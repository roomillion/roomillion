"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { packDirectory } = require("./room-package.cjs");
const { normalizeNetworkOrigin } = require("./manifest.cjs");
const { normalizeRoomIconSpec, validateRoomIconFile, writeGeneratedRoomIcon } = require("./room-icon.cjs");
const { normalizeRoomTestDefinition } = require("./room-test-definition.cjs");
const {
  expandHostModules,
  getRoomModule,
  getSelectableRoomModuleCatalog
} = require("./room-module-catalog.cjs");

const CUSTOM_ROOM_FORMAT = "room-app@1";
const CUSTOM_ROOM_THEMES = Object.freeze(["emerald", "blue", "violet", "amber", "rose", "slate", "dark", "custom"]);
// Kept as a compatibility export. Room source capacity is now governed by disk and
// package-format technical limits rather than three arbitrary character ceilings.
const CUSTOM_FILE_LIMITS = Object.freeze({ html: Infinity, css: Infinity, javascript: Infinity, total: Infinity });
const CUSTOM_FILE_PERMISSIONS = new Set(["pick", "pickMany", "directoryRead", "directoryWrite", "export", "largeText"]);
const CUSTOM_AI_ROLES = new Set(["general", "coding", "vision"]);
const CUSTOM_BROWSER_PERMISSIONS = new Set(["navigate", "download"]);
const CUSTOM_COMPUTE_PERMISSIONS = new Set(["worker"]);
const CUSTOM_RUNTIME_RAPIER_MARKER = "/* zhibian-runtime:rapier-ready@1 */";
const MODULE_GLOBAL_ALIASES = Object.freeze({
  "data.search@1": "Fuse",
  "document.pdf.view@1": "pdfjsLib"
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maximum, fallback = "") {
  const result = String(value ?? "").trim().slice(0, maximum);
  return result || fallback;
}

function uniqueStrings(value, maximum, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  const result = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (result.length !== value.length || result.length > maximum) throw new Error(`${label} 包含空值、重复值或超过 ${maximum} 项`);
  return result;
}

function normalizeSourcePath(value) {
  const source = String(value || "").replace(/\\/g, "/");
  if (!source || source.startsWith("/") || source.includes("\0") || source.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`自由房间文件路径无效：${source || "(空)"}`);
  if (!/^[A-Za-z0-9_./@+-]+$/.test(source)) throw new Error(`自由房间文件路径包含不支持的字符：${source}`);
  if (["index.html", "styles.css", "app.js", "bootstrap.mjs", "room-app.json"].includes(source.toLowerCase())) throw new Error(`自由房间扩展文件不能覆盖运行时文件：${source}`);
  return source;
}

function issue(code, message, file, severity = "error") {
  return { code, message, file, severity };
}

function analyzeHtml(html) {
  const issues = [];
  const forbiddenTags = /<\/?(?:html|head|body|script|style|link|meta|base|iframe|frame|object|embed|applet|portal)\b/i;
  if (forbiddenTags.test(html)) issues.push(issue("html.forbidden-tag", "HTML 只能提供 body 内容，不能包含文档外壳、脚本、样式或嵌入页面标签", "index.html"));
  if (/\son[a-z]+\s*=/i.test(html)) issues.push(issue("html.inline-handler", "HTML 不允许 onClick 等内联事件，事件必须写在 app.js", "index.html"));
  if (/javascript\s*:/i.test(html)) issues.push(issue("html.javascript-url", "HTML 不允许 javascript: URL", "index.html"));
  if (/\b(?:src|href|action|poster)\s*=\s*["']\s*(?:https?:|wss?:|\/\/)/i.test(html)) issues.push(issue("html.external-url", "HTML 不允许外部 URL", "index.html"));
  if (/\b(?:srcdoc|formaction)\s*=/i.test(html)) issues.push(issue("html.active-content", "HTML 不允许 srcdoc 或 formaction", "index.html"));
  if (!/<(?:main|canvas|section|article|div)\b/i.test(html)) issues.push(issue("html.no-root", "HTML 至少需要一个可显示的根区域", "index.html"));
  if (!/<h1\b/i.test(html)) issues.push(issue("html.no-heading", "建议提供一个 h1 作为房间可访问名称", "index.html", "warning"));
  return issues;
}

function analyzeCss(css) {
  const issues = [];
  if (/@import\b/i.test(css)) issues.push(issue("css.import", "CSS 不允许 @import", "styles.css"));
  if (/url\s*\(\s*["']?\s*(?:https?:|wss?:|\/\/)/i.test(css)) issues.push(issue("css.external-url", "CSS 不允许外部 URL", "styles.css"));
  if (/\b(?:expression|behavior|-moz-binding)\s*:/i.test(css)) issues.push(issue("css.active-content", "CSS 包含不安全的动态表达式", "styles.css"));
  if (!/@media\b/i.test(css) && !/(?:min\(|max\(|clamp\(|vw|vh|dvh)/i.test(css)) {
    issues.push(issue("css.responsive", "建议增加响应式尺寸或媒体查询", "styles.css", "warning"));
  }
  return issues;
}

function analyzeJavascript(javascript, allowedNetworkOrigins = [], browserCapabilities = [], computeCapabilities = []) {
  const issues = [];
  try {
    // bootstrap.mjs loads every JavaScript source as an ES module. vm.Script cannot
    // parse module declarations, so remove only their declaration syntax for this
    // fast check; the isolated runtime check remains the authoritative module parser.
    const syntaxProbe = String(javascript)
      .replace(/^\s*import\s+[\s\S]*?\s+from\s+["'][^"']+["']\s*;?\s*$/gm, "")
      .replace(/^\s*import\s+["'][^"']+["']\s*;?\s*$/gm, "")
      .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
      .replace(/\bexport\s+default\s+/g, "")
      .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class)\b|(?:const|let|var)\b)/g, "");
    new vm.Script(`"use strict";\n${syntaxProbe}`, { filename: "room-app.js", displayErrors: true });
  } catch (error) {
    issues.push(issue("js.syntax", `JavaScript 语法错误：${cleanText(error.message, 300)}`, "app.js"));
    return issues;
  }
  const rules = [
    ["js.eval", /\beval\s*\(/, "不允许 eval"],
    ["js.function-constructor", /(?:\bnew\s+Function\b|\bFunction\s*\()/, "不允许 Function 构造器"],
    ["js.dynamic-import", /\bimport\s*\(/, "app.js 不允许自行动态导入模块；使用 hostModules"],
    ["js.node", /(?:\brequire\s*\(|\bprocess\s*\.|\bBuffer\s*\.|\bmodule\.exports\b|["'`]node:|\bchild_process\b|\belectron\b)/, "不允许 Node.js、Electron 或系统命令能力"],
    ["js.network", /(?:\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bnavigator\.sendBeacon\b|\bRTCPeerConnection\b)/, "不允许直接网络 API"],
    ["js.privileged-worker", /(?:\bServiceWorker\b|\bSharedWorker\b|\bserviceWorker\b|\bimportScripts\s*\()/, "不允许 Service Worker、SharedWorker 或 importScripts"],
    ["js.navigation", /(?:\bwindow\.open\s*\(|\blocation\.(?:assign|replace)\s*\(|\blocation\.href\s*=)/, "不允许打开窗口或导航"],
    ["js.html-injection", /(?:\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\()/, "不允许 HTML 字符串注入；请使用 textContent 和 DOM API"],
    ["js.volatile-storage", /\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(/, "房间持久化必须使用 await window.room.storage.get/set 或 room.db，并声明 database:true；浏览器存储不会随房间备份迁移"]
  ];
  if (!computeCapabilities.includes("worker") && /\bWorker\s*\(/.test(javascript)) issues.push(issue("js.worker-undeclared", "创建 Web Worker 必须声明 capabilities.compute: [\"worker\"]", "app.js"));
  for (const [code, pattern, message] of rules) {
    const match = pattern.exec(javascript);
    if (match) issues.push({ ...issue(code, message, "app.js"), line: javascript.slice(0, match.index).split("\n").length });
  }
  const allowed = new Set(allowedNetworkOrigins.map(normalizeNetworkOrigin));
  const externalUrls = javascript.match(/https?:\/\/[^\s"'`\\)\]}]+/gi) || [];
  for (const externalUrl of [...new Set(externalUrls)]) {
    let origin;
    try {
      origin = new URL(externalUrl).origin;
    } catch {
      issues.push(issue("js.external-url", `代码包含无效的外部 URL：${cleanText(externalUrl, 120)}`, "app.js"));
      continue;
    }
    if (!allowed.has(origin) && !browserCapabilities.includes("navigate")) {
      issues.push(issue("js.external-url", `代码使用了未在 capabilities.network 声明的服务源：${origin}`, "app.js"));
    }
  }
  if (!/(?:addEventListener\s*\(|requestAnimationFrame\s*\(|\.onclick\s*=|window\.room\b)/.test(javascript)) {
    issues.push(issue("js.no-interaction", "代码没有明显的初始化、交互或 Room SDK 调用", "app.js", "warning"));
  }
  if (/\bTODO\b|\bFIXME\b|待实现|占位实现/i.test(javascript)) issues.push(issue("js.placeholder", "代码仍含 TODO/FIXME 或待实现占位", "app.js"));
  return issues;
}

function normalizeModelSlots(input) {
  if (input === undefined) return {};
  if (!isPlainObject(input) || Object.keys(input).length > 16) throw new Error("capabilities.modelSlots 必须是最多 16 项的对象");
  const slots = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = String(rawName).trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`模型槽位名称无效：${name}`);
    const value = typeof rawValue === "string" ? { role: rawValue } : rawValue;
    if (!isPlainObject(value) || !CUSTOM_AI_ROLES.has(value.role)) throw new Error(`模型槽位 ${name} 的角色无效`);
    slots[name] = {
      role: value.role,
      requiresImages: value.requiresImages === true || value.role === "vision",
      minimumContextWindow: Math.max(0, Math.min(10_000_000, Number(value.minimumContextWindow) || 0))
    };
  }
  return slots;
}

function normalizeCapabilities(input) {
  const source = isPlainObject(input) ? input : {};
  const files = source.files === undefined ? [] : uniqueStrings(source.files, 8, "capabilities.files");
  for (const permission of files) if (!CUSTOM_FILE_PERMISSIONS.has(permission)) throw new Error(`不支持的文件能力：${permission}`);
  const rawNetwork = source.network === undefined ? [] : uniqueStrings(source.network, Number.MAX_SAFE_INTEGER, "capabilities.network");
  const network = rawNetwork.map(normalizeNetworkOrigin);
  if (new Set(network).size !== network.length) throw new Error("capabilities.network 包含重复服务源");
  const browser = source.browser === undefined ? [] : uniqueStrings(source.browser, 2, "capabilities.browser");
  for (const permission of browser) if (!CUSTOM_BROWSER_PERMISSIONS.has(permission)) throw new Error(`不支持的浏览器能力：${permission}`);
  if (browser.includes("download") && !browser.includes("navigate")) throw new Error("浏览器下载能力需要同时声明 navigate");
  const credentials = source.credentials === undefined ? [] : uniqueStrings(source.credentials, 32, "capabilities.credentials");
  for (const alias of credentials) if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias)) throw new Error(`凭据别名无效：${alias}`);
  const tools = source.tools === undefined ? [] : uniqueStrings(source.tools, 64, "capabilities.tools");
  for (const toolId of tools) if (!/^[a-z][a-z0-9.-]{1,79}@\d+$/.test(toolId)) throw new Error(`房间工具 ID 无效：${toolId}`);
  const compute = source.compute === undefined ? [] : uniqueStrings(source.compute, 1, "capabilities.compute");
  for (const permission of compute) if (!CUSTOM_COMPUTE_PERMISSIONS.has(permission)) throw new Error(`不支持的计算能力：${permission}`);
  const aiInput = isPlainObject(source.ai) ? source.ai : null;
  const requestedRoles = aiInput?.roles ?? source.aiRoles ?? (source.ai === true ? ["general"] : []);
  const aiRoles = uniqueStrings(requestedRoles, 3, "capabilities.ai.roles");
  for (const role of aiRoles) if (!CUSTOM_AI_ROLES.has(role)) throw new Error(`不支持的 AI 角色：${role}`);
  const modelSlots = normalizeModelSlots(aiInput?.slots ?? source.modelSlots);
  for (const slot of Object.values(modelSlots)) if (!aiRoles.includes(slot.role)) aiRoles.push(slot.role);
  return {
    database: source.database === true,
    files,
    ai: aiRoles.length > 0,
    aiRoles,
    modelSlots,
    network,
    browser,
    compute,
    tools,
    credentials
  };
}

function normalizeCustomRoomSpec(input) {
  if (!isPlainObject(input)) throw new Error("自由房间规格必须是 JSON 对象");
  if (input.formatVersion !== CUSTOM_ROOM_FORMAT) throw new Error(`formatVersion 必须是 ${CUSTOM_ROOM_FORMAT}`);
  if (input.kind !== "custom") throw new Error("自由房间 kind 必须是 custom");
  const name = cleanText(input.name, 60);
  const description = cleanText(input.description, 300);
  if (!name) throw new Error("自由房间缺少名称");
  if (description.length < 4) throw new Error("自由房间说明过短");
  const requestedModules = input.hostModules === undefined ? [] : uniqueStrings(input.hostModules, Number.MAX_SAFE_INTEGER, "hostModules");
  const selectable = new Set(getSelectableRoomModuleCatalog().map((module) => module.id));
  for (const moduleId of requestedModules) if (!selectable.has(moduleId)) throw new Error(`自由房间不能使用未开放模块：${moduleId}`);
  const hostModules = expandHostModules(requestedModules);
  if (!isPlainObject(input.files)) throw new Error("自由房间必须包含 files 对象");
  const files = {
    html: String(input.files.html ?? "").trim(),
    css: String(input.files.css ?? "").trim(),
    javascript: String(input.files.javascript ?? "").trim()
  };
  if (!files.html || !files.css || !files.javascript) throw new Error("files.html、files.css、files.javascript 都不能为空");
  for (const [rawPath, rawContent] of Object.entries(input.files)) {
    if (["html", "css", "javascript"].includes(rawPath)) continue;
    const sourcePath = normalizeSourcePath(rawPath);
    if (typeof rawContent !== "string") throw new Error(`自由房间文件必须是文本：${sourcePath}`);
    files[sourcePath] = rawContent;
  }
  const theme = CUSTOM_ROOM_THEMES.includes(input.theme) ? input.theme : "custom";
  return {
    formatVersion: CUSTOM_ROOM_FORMAT,
    kind: "custom",
    name,
    description,
    theme,
    icon: normalizeRoomIconSpec(input.icon, { name, theme }),
    hostModules,
    capabilities: normalizeCapabilities(input.capabilities),
    files
  };
}

function inspectCustomRoomSpec(input) {
  const spec = normalizeCustomRoomSpec(input);
  const findings = [
    ...analyzeHtml(spec.files.html),
    ...analyzeCss(spec.files.css),
    ...analyzeJavascript(spec.files.javascript, spec.capabilities.network, spec.capabilities.browser, spec.capabilities.compute),
    ...Object.entries(spec.files).flatMap(([filePath, content]) => {
      if (["html", "css", "javascript"].includes(filePath)) return [];
      const extension = path.posix.extname(filePath).toLowerCase();
      if ([".js", ".mjs"].includes(extension)) return analyzeJavascript(content, spec.capabilities.network, spec.capabilities.browser, spec.capabilities.compute).map((item) => ({ ...item, file: filePath }));
      if (extension === ".css") return analyzeCss(content).map((item) => ({ ...item, file: filePath }));
      if (extension === ".html") return analyzeHtml(content).map((item) => ({ ...item, file: filePath }));
      return [];
    })
  ];
  if (Object.hasOwn(spec.files, "room-tests.json")) {
    try { normalizeRoomTestDefinition(spec.files["room-tests.json"]); }
    catch (error) { findings.push(issue("tests.invalid", `room-tests.json 无效：${error.message}`, "room-tests.json")); }
  }
  const allSource = Object.values(spec.files).join("\n");
  const usesNetworkSdk = /\b(?:window\.)?room\.network\.(?:getStatus|request|open|read|close)\s*\(/.test(allSource);
  if (/\b(?:window\.)?room\.(?:db|storage|vector)\./.test(allSource) && !spec.capabilities.database) findings.push(issue("js.database-undeclared", "调用 room.db/storage/vector 必须声明 capabilities.database:true", "app.js"));
  if (usesNetworkSdk && spec.capabilities.network.length === 0) {
    findings.push(issue("js.network-undeclared", "代码调用了 room.network，但 capabilities.network 没有声明服务源", "app.js"));
  } else if (!usesNetworkSdk && spec.capabilities.network.length > 0) {
    findings.push(issue("js.network-unused", "房间声明了联网服务，但代码没有调用 room.network", "app.js", "warning"));
  }
  const usesBrowserSdk = /\b(?:window\.)?room\.browser\.(?:getState|createTab|closeTab|activateTab|navigate|goBack|goForward|reload|stop|setViewport|clearData|respondToPermission)\s*\(/.test(allSource);
  if (usesBrowserSdk && !spec.capabilities.browser.includes("navigate")) {
    findings.push(issue("js.browser-undeclared", "代码调用了 room.browser，但 capabilities.browser 没有声明 navigate", "app.js"));
  } else if (!usesBrowserSdk && spec.capabilities.browser.length > 0) {
    findings.push(issue("js.browser-unused", "房间声明了浏览器能力，但代码没有调用 room.browser", "app.js", "warning"));
  }
  const errors = findings.filter((item) => item.severity === "error");
  const warnings = findings.filter((item) => item.severity === "warning");
  const report = {
    passed: errors.length === 0,
    errors,
    warnings,
    checks: {
      format: true,
      pageableMultiFile: true,
      syntax: !errors.some((item) => item.code === "js.syntax"),
      noExternalNetwork: !errors.some((item) => /external-url|network/.test(item.code)),
      controlledNetworkOnly: !errors.some((item) => /external-url|network/.test(item.code)),
      noHostEscape: !errors.some((item) => /node|navigation|worker|eval|function-constructor/.test(item.code)),
      noHtmlInjection: !errors.some((item) => /html-injection|inline-handler|javascript-url|active-content/.test(item.code)),
      moduleAllowlist: true,
      controlledBrowserOnly: !errors.some((item) => item.code === "js.browser-undeclared")
    },
    metrics: {
      htmlCharacters: spec.files.html.length,
      cssCharacters: spec.files.css.length,
      javascriptCharacters: spec.files.javascript.length,
      totalCharacters: Object.values(spec.files).reduce((sum, value) => sum + value.length, 0),
      fileCount: Object.keys(spec.files).length,
      hostModuleCount: spec.hostModules.length,
      networkOriginCount: spec.capabilities.network.length,
      browserCapabilityCount: spec.capabilities.browser.length
    }
  };
  return { spec, report };
}

function validateCustomRoomSpec(input) {
  const inspected = inspectCustomRoomSpec(input);
  if (!inspected.report.passed) {
    const error = new Error(`自由房间未通过安全检查：${inspected.report.errors.map((item) => item.message).join("；")}`);
    error.code = "CUSTOM_ROOM_VALIDATION_FAILED";
    error.report = inspected.report;
    throw error;
  }
  return inspected;
}

function customRoomPermissions(spec) {
  const permissions = { network: [...spec.capabilities.network] };
  if (spec.capabilities.database) permissions.database = "private";
  if (spec.capabilities.files.length) permissions.files = [...spec.capabilities.files];
  if (spec.capabilities.ai) permissions.ai = { roles: [...spec.capabilities.aiRoles], ...(Object.keys(spec.capabilities.modelSlots).length ? { slots: structuredClone(spec.capabilities.modelSlots) } : {}) };
  if (spec.capabilities.browser.length) permissions.browser = [...spec.capabilities.browser];
  if (spec.capabilities.compute.length) permissions.compute = [...spec.capabilities.compute];
  if (spec.capabilities.tools.length) permissions.tools = [...spec.capabilities.tools];
  if (spec.capabilities.credentials.length) permissions.credentials = [...spec.capabilities.credentials];
  return permissions;
}

function classicModuleScripts(hostModules) {
  return hostModules.flatMap((moduleId) => getRoomModule(moduleId).assets
    .filter((asset) => asset.type === "script")
    .map((asset) => `  <script src="/_modules/${moduleId}/${asset.publicName}"></script>`)).join("\n");
}

function moduleStyles(hostModules) {
  return hostModules.flatMap((moduleId) => getRoomModule(moduleId).assets
    .filter((asset) => asset.type === "style")
    .map((asset) => `  <link rel="stylesheet" href="/_modules/${moduleId}/${asset.publicName}">`)).join("\n");
}

function rapierRuntimeInitializer(hostModules, indent = "") {
  if (!hostModules.includes("physics.rapier@1")) return "";
  return `${indent}${CUSTOM_RUNTIME_RAPIER_MARKER}
${indent}if (typeof globalThis.RAPIER?.init !== "function") throw new Error("内置 Rapier 物理模块未正确加载");
${indent}await globalThis.RAPIER.init();`;
}

function applyCustomRuntimeCompatibility(source, hostModules = []) {
  const content = String(source ?? "");
  if (!hostModules.includes("physics.rapier@1") || content.includes(CUSTOM_RUNTIME_RAPIER_MARKER)) return content;
  return `${rapierRuntimeInitializer(hostModules)}
${content}`;
}

function generatedCustomIndexHtml(spec) {
  const scripts = classicModuleScripts(spec.hostModules);
  const styles = moduleStyles(spec.hostModules);
  const roomStyles = Object.keys(spec.files)
    .filter((filePath) => filePath !== "css" && path.posix.extname(filePath).toLowerCase() === ".css")
    .sort()
    .map((filePath) => `  <link rel="stylesheet" href="./${filePath.replace(/[&<>"']/g, "")}">`)
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN" data-room-kind="custom"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${spec.name.replace(/[&<>"']/g, "")}</title>
${styles ? `${styles}\n` : ""}  <link rel="stylesheet" href="./styles.css">
${roomStyles ? `${roomStyles}\n` : ""}
</head><body data-theme="${spec.theme}">
${spec.files.html}
${scripts ? `${scripts}\n` : ""}  <script type="module" src="./bootstrap.mjs"></script>
</body></html>`;
}

function generatedCustomBootstrap(hostModules) {
  const imports = [];
  let index = 0;
  for (const moduleId of hostModules) {
    for (const asset of getRoomModule(moduleId).assets) {
      if (asset.type !== "module") continue;
      const variable = `moduleValue${index++}`;
      const target = `/_modules/${moduleId}/${asset.publicName}`;
      const alias = MODULE_GLOBAL_ALIASES[moduleId] || `RoomModule${index}`;
      if (asset.export === "default") imports.push(`const ${variable} = (await import(${JSON.stringify(target)})).default; globalThis[${JSON.stringify(alias)}] = ${variable};`);
      else imports.push(`const ${variable} = await import(${JSON.stringify(target)}); globalThis[${JSON.stringify(alias)}] = ${variable};`);
    }
  }
  return `"use strict";
const showFatal = (error) => {
  document.documentElement.dataset.roomError = String(error?.message || error).slice(0, 500);
  const panel = document.createElement("pre");
  panel.id = "zhibian-room-error";
  panel.setAttribute("role", "alert");
  panel.textContent = "房间启动失败：" + (error?.message || error);
  Object.assign(panel.style, { position:"fixed", inset:"16px", zIndex:"2147483647", overflow:"auto", padding:"16px", borderRadius:"12px", color:"#fff", background:"#501d19" });
  document.body.appendChild(panel);
};
async function boot() {
  ${imports.join("\n  ")}
${rapierRuntimeInitializer(hostModules, "  ")}
  await import("./app.js");
  if (!document.documentElement.dataset.roomError) document.documentElement.dataset.roomReady = "true";
}
globalThis.addEventListener("error", (event) => { if (!document.documentElement.dataset.roomError) showFatal(event.error || event.message); });
globalThis.addEventListener("unhandledrejection", (event) => { if (!document.documentElement.dataset.roomError) showFatal(event.reason); });
boot().catch(showFatal);
`;
}

function customRoomMetadata(spec) {
  return {
    formatVersion: spec.formatVersion,
    kind: spec.kind,
    name: spec.name,
    description: spec.description,
    theme: spec.theme,
    icon: spec.icon,
    hostModules: spec.hostModules,
    capabilities: spec.capabilities,
    sourceFiles: Object.keys(spec.files).filter((item) => !["html", "css", "javascript"].includes(item))
  };
}

async function createCustomRoom({ spec: input, roomStore, roomId: requestedRoomId = null, version = "1.0.0", selectedKeys, migration = null, iconFile = null }) {
  const { spec, report } = validateCustomRoomSpec(input);
  const token = crypto.randomUUID().replace(/-/g, "");
  const roomId = requestedRoomId || `local.generated.${token}`;
  const sourceRoot = await fsp.mkdtemp(path.join(roomStore.tempRoot, "custom-room-source-"));
  const packagePath = path.join(roomStore.tempRoot, `${roomId}-custom-${crypto.randomBytes(6).toString("hex")}.room`);
  try {
    await fsp.mkdir(path.join(sourceRoot, "app"), { recursive: true });
    const manifest = {
      formatVersion: "0.1",
      id: roomId,
      name: spec.name,
      version,
      publisher: { id: "local.user", name: "本机用户" },
      runtime: { roomSdk: "1", minimumWorkbench: require("./workbench-compatibility.cjs").currentVersion },
      entry: "app/index.html",
      icon: "assets/icon.svg",
      permissions: customRoomPermissions(spec),
      hostModules: spec.hostModules,
      embeddedDependencies: []
    };
    if (iconFile) {
      const extension = path.extname(iconFile).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error("上传的房间图标只支持 PNG、JPEG 或 WebP");
      manifest.icon = `assets/icon${extension === ".jpeg" ? ".jpg" : extension}`;
      const iconTarget = path.join(sourceRoot, ...manifest.icon.split("/"));
      await fsp.mkdir(path.dirname(iconTarget), { recursive: true });
      await fsp.copyFile(iconFile, iconTarget);
      await validateRoomIconFile(sourceRoot, manifest.icon);
    } else {
      let copiedPrevious = false;
      if (requestedRoomId) {
        const previousRoom = roomStore.getRoom(requestedRoomId);
        if (previousRoom?.icon) {
          try {
            const previousIcon = await roomStore.resolveProgramFile(requestedRoomId, previousRoom.icon);
            manifest.icon = previousRoom.icon;
            const iconTarget = path.join(sourceRoot, ...manifest.icon.split("/"));
            await fsp.mkdir(path.dirname(iconTarget), { recursive: true });
            await fsp.copyFile(previousIcon, iconTarget);
            await validateRoomIconFile(sourceRoot, manifest.icon);
            copiedPrevious = true;
          } catch {}
        }
      }
      if (!copiedPrevious) await writeGeneratedRoomIcon(sourceRoot, { name: spec.name, theme: spec.theme, icon: spec.icon });
    }
    await fsp.writeFile(path.join(sourceRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fsp.writeFile(path.join(sourceRoot, "app", "room-app.json"), `${JSON.stringify(customRoomMetadata(spec), null, 2)}\n`, "utf8");
    await fsp.writeFile(path.join(sourceRoot, "app", "index.html"), generatedCustomIndexHtml(spec), "utf8");
    await fsp.writeFile(path.join(sourceRoot, "app", "styles.css"), `${spec.files.css}\n`, "utf8");
    await fsp.writeFile(path.join(sourceRoot, "app", "app.js"), `${spec.files.javascript}\n`, "utf8");
    await fsp.writeFile(path.join(sourceRoot, "app", "bootstrap.mjs"), generatedCustomBootstrap(spec.hostModules), "utf8");
    for (const [sourcePath, content] of Object.entries(spec.files)) {
      if (["html", "css", "javascript"].includes(sourcePath)) continue;
      const target = path.join(sourceRoot, "app", ...sourcePath.split("/"));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, "utf8");
    }
    // Host-owned provenance; source license texts are data and never injected into executable code.
    // Keep notices on subsequent edits even when the new conversation has no source snapshot.
    if (!migration && requestedRoomId && roomStore.getRoom(requestedRoomId)) {
      try {
        const previous = await roomStore.resolveProgramFile(requestedRoomId, "project-migration.json");
        migration = JSON.parse(await fsp.readFile(previous, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT" && !/不存在|not found/i.test(error.message)) throw error;
      }
    }
    if (migration) await fsp.writeFile(path.join(sourceRoot, "project-migration.json"), `${JSON.stringify(migration, null, 2)}\n`, "utf8");
    await packDirectory(sourceRoot, packagePath);
    const room = await roomStore.installPackage(packagePath, {
      source: "local-generated",
      ...(selectedKeys ? { selectedKeys } : {})
    });
    return { room, spec, report };
  } finally {
    await fsp.rm(sourceRoot, { recursive: true, force: true });
    await fsp.rm(packagePath, { force: true });
  }
}

async function loadCustomRoomSpec(roomStore, roomId) {
  const programRoot = roomStore.getProgramRoot(roomId);
  const metadata = JSON.parse(await fsp.readFile(path.join(programRoot, "app", "room-app.json"), "utf8"));
  const files = {
    html: extractCustomBody(await fsp.readFile(path.join(programRoot, "app", "index.html"), "utf8"), metadata.hostModules),
    css: await fsp.readFile(path.join(programRoot, "app", "styles.css"), "utf8"),
    javascript: await fsp.readFile(path.join(programRoot, "app", "app.js"), "utf8")
  };
  for (const sourcePath of Array.isArray(metadata.sourceFiles) ? metadata.sourceFiles : []) {
    const safePath = normalizeSourcePath(sourcePath);
    files[safePath] = await fsp.readFile(path.join(programRoot, "app", ...safePath.split("/")), "utf8");
  }
  return normalizeCustomRoomSpec({
    ...metadata,
    files
  });
}

function extractCustomBody(indexHtml) {
  const match = String(indexHtml).match(/<body[^>]*>\s*([\s\S]*?)\s*(?:<script src="\/_modules\/|<script type="module" src="\.\/bootstrap\.mjs")/i);
  if (!match) throw new Error("自由房间 HTML 外壳无效");
  return match[1].trim();
}

module.exports = {
  CUSTOM_FILE_LIMITS,
  CUSTOM_ROOM_FORMAT,
  CUSTOM_RUNTIME_RAPIER_MARKER,
  CUSTOM_ROOM_THEMES,
  applyCustomRuntimeCompatibility,
  analyzeCss,
  analyzeHtml,
  analyzeJavascript,
  createCustomRoom,
  customRoomPermissions,
  generatedCustomBootstrap,
  generatedCustomIndexHtml,
  inspectCustomRoomSpec,
  loadCustomRoomSpec,
  normalizeCustomRoomSpec,
  validateCustomRoomSpec
};
