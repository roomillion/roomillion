"use strict";

const SUITE_VERSION = "1.0";
const LEVELS = Object.freeze({
  quick: { tier: 1, label: "快速", estimates: { chat: "约 800–1,800", vision: "约 800–2,000", comprehensive: "约 1,500–3,000" } },
  standard: { tier: 2, label: "标准", estimates: { chat: "约 2,000–4,000", vision: "约 1,500–4,000", comprehensive: "约 3,000–7,000" } },
  deep: { tier: 3, label: "深度", estimates: { chat: "约 4,000–7,000", vision: "约 3,000–6,000", comprehensive: "约 6,000–12,000" } }
});
const CATEGORY_LABELS = Object.freeze({ comprehensive: "综合", chat: "聊天", vision: "图片" });
const CUSTOM_CASE_FORMAT = "zhibian-benchmark-case@1";
const CUSTOM_OPERATORS = new Set(["equals", "numberEquals", "contains", "includesAll", "oneOf", "exists"]);
const CUSTOM_IMAGE_LIMIT = 2 * 1024 * 1024;
const CUSTOM_IMAGE_TOTAL_LIMIT = 20 * 1024 * 1024;
const CUSTOM_CASE_LIMIT = 50;
const state = { models: [], running: false, runToken: 0, results: [], customRecords: [], customCases: [], uploadedImage: null };

const elements = {
  connectionDot: document.getElementById("connectionDot"), connectionLabel: document.getElementById("connectionLabel"),
  model: document.getElementById("benchmarkModel"), category: document.getElementById("benchmarkCategory"), level: document.getElementById("benchmarkLevel"),
  modelCard: document.getElementById("modelCard"), tokenEstimate: document.getElementById("tokenEstimate"), caseEstimate: document.getElementById("caseEstimate"), budgetNote: document.getElementById("budgetNote"),
  start: document.getElementById("startBenchmark"), stop: document.getElementById("stopBenchmark"), setupHint: document.getElementById("setupHint"),
  status: document.getElementById("benchmarkStatus"), progressLabel: document.getElementById("progressLabel"), progressText: document.getElementById("progressText"), progressFill: document.getElementById("progressFill"),
  caseList: document.getElementById("caseList"), currentScore: document.getElementById("currentScore"), currentGrade: document.getElementById("currentGrade"),
  chatScore: document.getElementById("chatScore"), visionScore: document.getElementById("visionScore"), runCount: document.getElementById("runCount"),
  rankingCategory: document.getElementById("rankingCategory"), rankingLevel: document.getElementById("rankingLevel"), leaderboard: document.getElementById("leaderboardBody"),
  clearHistory: document.getElementById("clearHistory"), manageCustomCases: document.getElementById("manageCustomCases"),
  resultDetailDialog: document.getElementById("resultDetailDialog"), resultDetailTitle: document.getElementById("resultDetailTitle"),
  resultDetailSummary: document.getElementById("resultDetailSummary"), resultDetailCases: document.getElementById("resultDetailCases"),
  closeResultDetail: document.getElementById("closeResultDetail"), customCaseDialog: document.getElementById("customCaseDialog"),
  closeCustomCases: document.getElementById("closeCustomCases"), customCaseList: document.getElementById("customCaseList"), newCustomCase: document.getElementById("newCustomCase"),
  customCaseForm: document.getElementById("customCaseForm"), customCaseId: document.getElementById("customCaseId"), customTitle: document.getElementById("customTitle"),
  customType: document.getElementById("customType"), customLevel: document.getElementById("customLevel"), customMaxTokens: document.getElementById("customMaxTokens"),
  customPrompt: document.getElementById("customPrompt"), customResponseFormat: document.getElementById("customResponseFormat"),
  customAssertions: document.getElementById("customAssertions"), customImageField: document.getElementById("customImageField"), customImageSource: document.getElementById("customImageSource"),
  customImagePicker: document.getElementById("customImagePicker"), pickCustomImage: document.getElementById("pickCustomImage"), customImageLabel: document.getElementById("customImageLabel"),
  loadRuleExample: document.getElementById("loadRuleExample"), toast: document.getElementById("toast")
};

let toastTimer = null;
let removeModelListener = null;

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.style.background = isError ? "#8e3e32" : "#173d32";
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function parseJson(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(source); } catch {}
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(source.slice(start, end + 1)); } catch {}
  }
  return null;
}

function boundedScore(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))); }
function addPoints(checks) { return boundedScore(checks.reduce((sum, [condition, points]) => sum + (condition ? points : 0), 0)); }
function sameStrings(value, expected) { return Array.isArray(value) && value.length === expected.length && expected.every((item) => value.includes(item)); }

function validateAssertions(input, responseFormat) {
  let assertions = input;
  if (typeof input === "string") {
    try { assertions = JSON.parse(input); } catch { throw new Error("评分断言不是有效 JSON"); }
  }
  if (!Array.isArray(assertions) || assertions.length < 1 || assertions.length > 12) throw new Error("评分断言必须包含 1-12 项");
  const normalized = assertions.map((assertion, index) => {
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) throw new Error(`第 ${index + 1} 条断言必须是对象`);
    const path = String(assertion.path || "").trim();
    const operator = String(assertion.operator || "").trim();
    const weight = Number(assertion.weight);
    if (path !== "$text" && !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(path)) throw new Error(`第 ${index + 1} 条断言的路径无效`);
    if (responseFormat === "text" && path !== "$text") throw new Error("纯文本题只能使用 $text 路径");
    if (!CUSTOM_OPERATORS.has(operator)) throw new Error(`第 ${index + 1} 条断言的操作符不受支持`);
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error(`第 ${index + 1} 条断言的权重必须是 1-100 的整数`);
    if (operator !== "exists" && !Object.hasOwn(assertion, "expected")) throw new Error(`第 ${index + 1} 条断言缺少 expected`);
    if (["includesAll", "oneOf"].includes(operator) && (!Array.isArray(assertion.expected) || assertion.expected.length < 1 || assertion.expected.length > 20)) {
      throw new Error(`第 ${index + 1} 条断言的 expected 必须是 1-20 项数组`);
    }
    if (operator === "numberEquals" && !Number.isFinite(Number(assertion.expected))) throw new Error(`第 ${index + 1} 条断言的 expected 必须是数字`);
    if (JSON.stringify(assertion.expected ?? null).length > 2000) throw new Error(`第 ${index + 1} 条断言的 expected 过长`);
    return { path, operator, ...(operator === "exists" ? {} : { expected: assertion.expected }), weight };
  });
  if (normalized.reduce((sum, item) => sum + item.weight, 0) !== 100) throw new Error("所有评分断言的权重之和必须等于 100");
  return normalized;
}

function valueAtPath(root, path, rawText) {
  if (path === "$text") return { exists: true, value: String(rawText || "").trim() };
  let value = root;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return { exists: false, value: undefined };
    value = value[segment];
  }
  return { exists: true, value };
}

function assertionMatches(assertion, root, rawText) {
  const actual = valueAtPath(root, assertion.path, rawText);
  if (assertion.operator === "exists") return actual.exists && actual.value !== null;
  if (!actual.exists) return false;
  if (assertion.operator === "equals") return typeof actual.value === "string" && typeof assertion.expected === "string"
    ? actual.value.trim() === assertion.expected.trim()
    : JSON.stringify(actual.value) === JSON.stringify(assertion.expected);
  if (assertion.operator === "numberEquals") return Number(actual.value) === Number(assertion.expected);
  if (assertion.operator === "contains") return typeof actual.value === "string"
    ? actual.value.includes(String(assertion.expected))
    : Array.isArray(actual.value) && actual.value.some((value) => JSON.stringify(value) === JSON.stringify(assertion.expected));
  if (assertion.operator === "includesAll") return Array.isArray(actual.value)
    ? assertion.expected.every((expected) => actual.value.some((value) => JSON.stringify(value) === JSON.stringify(expected)))
    : typeof actual.value === "string" && assertion.expected.every((expected) => actual.value.includes(String(expected)));
  if (assertion.operator === "oneOf") return assertion.expected.some((expected) => JSON.stringify(actual.value) === JSON.stringify(expected));
  return false;
}

function scoreCustomResponse(text, responseFormat, assertions) {
  const root = responseFormat === "json" ? parseJson(text) : null;
  if (responseFormat === "json" && !root) return 0;
  return boundedScore(assertions.reduce((sum, assertion) => sum + (assertionMatches(assertion, root, text) ? assertion.weight : 0), 0));
}

function compileCustomRecord(row) {
  if (!/^custom_[a-f0-9]{32}$/.test(String(row.id || ""))) throw new Error("自定义题目标识无效");
  if (!["text", "json"].includes(row.response_format)) throw new Error("自定义题目的回答格式无效");
  const responseFormat = row.response_format;
  const assertions = validateAssertions(row.assertions_json, responseFormat);
  if (row.format !== CUSTOM_CASE_FORMAT) throw new Error("自定义题目格式版本不受支持");
  if (!LEVELS[row.level] || !["chat", "vision"].includes(row.type)) throw new Error("自定义题目的类别或等级无效");
  if (typeof row.title !== "string" || row.title.length < 2 || row.title.length > 80 || typeof row.prompt !== "string" || row.prompt.length < 20 || row.prompt.length > 6000) throw new Error("自定义题目的名称或提示词无效");
  if (!Number.isInteger(Number(row.max_tokens)) || Number(row.max_tokens) < 16 || Number(row.max_tokens) > 2000) throw new Error("自定义题目的 Token 上限无效");
  const imageKind = String(row.image_kind || "none");
  if (row.type === "vision" && !["dashboard", "permission", "error", "uploaded"].includes(imageKind)) throw new Error("图片题必须选择测试图片");
  if (imageKind === "uploaded" && (!["image/png", "image/jpeg", "image/webp"].includes(row.image_mime) || typeof row.image_base64 !== "string" || row.image_base64.length === 0 || row.image_base64.length > Math.ceil(CUSTOM_IMAGE_LIMIT * 4 / 3) + 8)) throw new Error("自定义测试图片无效或超过 2 MB");
  return {
    id: row.id, type: row.type, tier: LEVELS[row.level].tier, title: row.title, focus: `自定义 · ${LEVELS[row.level].label}`,
    maxTokens: Number(row.max_tokens), format: responseFormat, prompt: row.prompt, custom: true, assertions,
    imageKind, imageMime: row.image_mime || null, imageBase64: row.image_base64 || null, revision: row.updated_at,
    score: (text) => scoreCustomResponse(text, responseFormat, assertions)
  };
}

const TEST_CASES = Object.freeze([
  {
    id: "instruction-exact", type: "chat", tier: 1, title: "精确指令遵循", focus: "固定格式与禁止赘述", maxTokens: 96, format: "text",
    prompt: "这是智变房间生成 Harness 的适配测试。只输出下面三行，标点、空格和顺序必须完全一致；不要 Markdown，不要解释。\n房间类型: 数据工具\n运行模式: 离线优先\n下一步: 生成草案",
    score(text) {
      const expected = ["房间类型: 数据工具", "运行模式: 离线优先", "下一步: 生成草案"];
      const lines = String(text || "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return addPoints([[lines[0] === expected[0], 30], [lines[1] === expected[1], 30], [lines[2] === expected[2], 30], [lines.join("\n") === expected.join("\n"), 10]]);
    }
  },
  {
    id: "harness-diagnosis", type: "chat", tier: 2, title: "Harness 故障归因", focus: "区分房间代码与编排状态", maxTokens: 260, format: "json",
    prompt: "房间草案检查和运行测试均通过，但安装步骤报错“检查点类型无效”。日志显示生成代码无异常，旧会话曾在安装前升级过检查点结构。请只输出 JSON：faultOwner 只能是 room-code 或 harness-state；safeRetry 只能是 full-regenerate 或 install-only；userDataAction 只能是 delete 或 keep；reason 用不超过 30 个汉字。不要建议重置整个会话。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      return addPoints([[value.faultOwner === "harness-state", 35], [value.safeRetry === "install-only", 30], [value.userDataAction === "keep", 20],
        [typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 30, 10], [sameStrings(Object.keys(value), ["faultOwner", "safeRetry", "userDataAction", "reason"]), 5]]);
    }
  },
  {
    id: "capability-routing", type: "chat", tier: 2, title: "能力与权限路由", focus: "3D、数据库、AI 与离线约束", maxTokens: 420, format: "json",
    prompt: "用户要一个离线 3D 台球训练房间：有真实碰撞、键盘操作、程序化音效、保存最高分，并通过主工作台 AI 给训练建议；不读写用户文件，不访问普通互联网。只输出 JSON，字段为 database、aiRoles、files、network、hostModules。hostModules 必须从 graphics.three@1、physics.rapier@1、game.input@1、game.audio@1、game.assets@1 中选择；不能增加其他模块。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      const modules = ["graphics.three@1", "physics.rapier@1", "game.input@1", "game.audio@1", "game.assets@1"];
      return addPoints([[value.database === "private", 15], [sameStrings(value.aiRoles, ["general"]), 15], [Array.isArray(value.files) && value.files.length === 0, 15],
        [Array.isArray(value.network) && value.network.length === 0, 15], [sameStrings(value.hostModules, modules), 35],
        [sameStrings(Object.keys(value), ["database", "aiRoles", "files", "network", "hostModules"]), 5]]);
    }
  },
  {
    id: "long-requirement", type: "chat", tier: 3, title: "长需求关键事实抽取", focus: "跨段约束保持", maxTokens: 420, format: "json",
    prompt: "阅读需求备忘录并只输出 JSON。\n【项目】北区设备巡检。第一阶段曾考虑网页外链，最终否决。数据必须保存在房间私有数据库。\n【文件】用户只需导出 XLSX，不需要导入；早期会议提过 CSV，但最终决定只导出 XLSX。\n【AI】调用主工作台模型生成周报，不允许房间保存密钥。模型由房间用户选择。\n【网络】普通互联网总开关保持关闭，不声明任何网络源。\n【界面】首页是统计看板，第二页是巡检记录。图表必须使用 ui.chart@1；表格导出使用 document.spreadsheet.rich@1。\n【交付】房间名最终定为“北区巡检驾驶舱”，旧名“巡检助手”废弃。\n输出字段 finalName、pageCount、filePermission、networkOrigins、aiCredentialOwner、hostModules。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      return addPoints([[value.finalName === "北区巡检驾驶舱", 18], [Number(value.pageCount) === 2, 12], [value.filePermission === "export", 15],
        [Array.isArray(value.networkOrigins) && value.networkOrigins.length === 0, 15], [value.aiCredentialOwner === "主工作台", 15],
        [sameStrings(value.hostModules, ["ui.chart@1", "document.spreadsheet.rich@1"]), 25]]);
    }
  },
  {
    id: "spec-audit", type: "chat", tier: 3, title: "规范自检与最小修复", focus: "发现越权并给出有限修改", maxTokens: 520, format: "json",
    prompt: "审查这份房间草案：manifest 只声明 database=private、files=[]、ai.roles=[general]、network=[]；代码调用了 room.db.run、room.files.exportBinary、room.ai.generate，并直接调用 fetch 获取天气。要求保持导出与天气功能。只输出 JSON：violations 为缺失或违规能力代码数组；manifestAdd 为应新增权限数组；codeChange 为必须改用的工作台 API 名称；directNetworkAllowed 为布尔值。房间网络只能通过 room.network.request，且还必须声明精确服务源。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      const violations = Array.isArray(value.violations) ? value.violations.join(" ").toLowerCase() : "";
      const additions = Array.isArray(value.manifestAdd) ? value.manifestAdd.join(" ").toLowerCase() : "";
      return addPoints([[violations.includes("files.export"), 20], [violations.includes("network") || violations.includes("fetch"), 20],
        [additions.includes("files.export"), 15], [additions.includes("network"), 15], [value.codeChange === "room.network.request", 20], [value.directNetworkAllowed === false, 10]]);
    }
  },
  {
    id: "vision-dashboard", type: "vision", tier: 1, title: "仪表盘图片理解", focus: "中文 OCR、指标与趋势", maxTokens: 300, format: "json", image: "dashboard",
    prompt: "识别图片中的智变房间仪表盘，只输出 JSON：title、restockCount、riskBatchCount、primaryAction、activeNav、barTrend。barTrend 只能是 rising、falling 或 flat。数字必须是数值。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      return addPoints([[value.title === "库存驾驶舱", 20], [Number(value.restockCount) === 12, 20], [Number(value.riskBatchCount) === 3, 20],
        [value.primaryAction === "导出 CSV", 15], [value.activeNav === "总览", 15], [value.barTrend === "rising", 10]]);
    }
  },
  {
    id: "vision-permission", type: "vision", tier: 2, title: "权限界面状态识别", focus: "布局、勾选状态与操作目标", maxTokens: 320, format: "json", image: "permission",
    prompt: "图片是房间设置界面。只输出 JSON：roomName、sidebarState、grantedPermission、pendingPermission、primaryButton、warningCount。sidebarState 只能是 expanded 或 collapsed；warningCount 为数值。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      return addPoints([[value.roomName === "维修工单", 15], [value.sidebarState === "collapsed", 15], [value.grantedPermission === "私有数据库", 20],
        [value.pendingPermission === "视觉 AI", 20], [value.primaryButton === "保存设置", 20], [Number(value.warningCount) === 1, 10]]);
    }
  },
  {
    id: "vision-error", type: "vision", tier: 3, title: "错误截图定位", focus: "错误类型、对象、属性与行号", maxTokens: 360, format: "json", image: "error",
    prompt: "分析这张房间启动失败截图，只输出 JSON：errorType、undefinedObject、propertyName、lineNumber、fixKind。fixKind 只能是 guard-before-access、retry-network 或 reinstall-database。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      return addPoints([[value.errorType === "TypeError", 20], [value.undefinedObject === "checkpoint", 25], [value.propertyName === "id", 20],
        [Number(value.lineNumber) === 48, 15], [value.fixKind === "guard-before-access", 20]]);
    }
  },
  {
    id: "manifest-json", type: "chat", tier: 1, title: "结构化房间草案", focus: "JSON、权限与共享模块", maxTokens: 320, format: "json",
    prompt: "为以下需求输出一个 JSON 对象：做一个名为“设备巡检台账”的离线房间，保存记录、导出文件、调用通用 AI 生成总结、用工作台内置图表模块展示统计，不访问普通互联网。只允许根字段 name、permissions、hostModules；不得输出 Markdown。权限格式必须符合智变房间清单：database 为 private；files 为字符串数组；ai.roles 为字符串数组；network 为数组；图表模块 ID 为 ui.chart@1。",
    score(text) {
      const value = parseJson(text); if (!value) return 0;
      return addPoints([[value.name === "设备巡检台账", 10], [value.permissions?.database === "private", 15], [sameStrings(value.permissions?.files, ["export"]), 15],
        [sameStrings(value.permissions?.ai?.roles, ["general"]), 15], [Array.isArray(value.permissions?.network) && value.permissions.network.length === 0, 15],
        [sameStrings(value.hostModules, ["ui.chart@1"]), 20], [sameStrings(Object.keys(value), ["name", "permissions", "hostModules"]), 10]]);
    }
  }
]);

function selectedModel() { return state.models.find((model) => model.id === elements.model.value) || null; }
function casesFor(category, level) {
  const tier = LEVELS[level].tier;
  return [...TEST_CASES, ...state.customCases].filter((item) => item.tier <= tier && (category === "comprehensive" || item.type === category));
}
function selectedCases() { return casesFor(elements.category.value, elements.level.value); }
function benchmarkSetKey(cases) {
  const custom = cases.filter((item) => item.custom).map((item) => `${item.id}:${item.revision}`).sort();
  if (!custom.length) return "builtin";
  let hash = 2166136261;
  for (const character of custom.join("|")) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `custom-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function gradeFor(score) { if (score >= 90) return "S"; if (score >= 80) return "A"; if (score >= 70) return "B"; if (score >= 60) return "C"; return "D"; }
function formatScore(value) { return Number.isFinite(Number(value)) && value !== null ? Number(value).toFixed(1) : "—"; }
function setStatus(status, label) { elements.status.className = `statusBadge ${status}`; elements.status.textContent = label; }

function renderModelCard() {
  const model = selectedModel();
  if (!model) {
    elements.modelCard.innerHTML = "<strong>没有可用模型</strong><p>请先到主工作台 AI 能力中心完成配置。</p>";
    return;
  }
  elements.modelCard.replaceChildren();
  const title = document.createElement("strong"); title.textContent = model.label;
  const detail = document.createElement("p"); detail.textContent = `${model.providerName} · ${model.model}`;
  const tags = document.createElement("div"); tags.className = "modelTags";
  const values = [model.supportsImages ? "支持图片" : "仅文本", model.contextWindow ? `上下文 ${model.contextWindow.toLocaleString()}` : "上下文未知", model.maxTokens ? `输出上限 ${model.maxTokens.toLocaleString()}` : "输出上限未知"];
  for (const value of values) { const tag = document.createElement("span"); tag.textContent = value; tags.appendChild(tag); }
  elements.modelCard.append(title, detail, tags);
}

function updateSetup() {
  const model = selectedModel();
  const category = elements.category.value;
  const level = elements.level.value;
  const cases = selectedCases(); const customCases = cases.filter((item) => item.custom);
  elements.tokenEstimate.textContent = `${LEVELS[level].estimates[category]} Token${customCases.length ? " + 自定义题" : ""}`;
  elements.caseEstimate.textContent = `${cases.length} 项${customCases.length ? `（${customCases.length} 个自定义）` : ""}`;
  elements.budgetNote.textContent = customCases.length
    ? `基础预计值不包含自定义题；本次自定义题最大输出上限合计 ${customCases.reduce((sum, item) => sum + item.maxTokens, 0)} Token，实际以 Provider 用量为准。`
    : "实际计费取决于模型分词、图片计价和返回长度，完成后以 Provider 返回值优先记录。";
  elements.start.textContent = `开始${LEVELS[level].label}${CATEGORY_LABELS[category]}评测`;
  elements.start.disabled = state.running || !model?.ready;
  elements.setupHint.textContent = !model?.ready
    ? "请先在主工作台“AI 能力中心”配置并启用模型。"
    : category !== "chat" && !model.supportsImages
      ? "该模型目录声明为仅文本；图片题将记 0 分，用于反映能力边界。"
      : "题目和测试图由房间本地生成；只有题目内容会通过主工作台 AI Gateway 发送。";
  renderModelCard();
}

function renderCases() {
  elements.caseList.replaceChildren();
  if (!state.results.length) {
    const empty = document.createElement("div"); empty.className = "emptyState";
    empty.innerHTML = "<span>AI</span><h3>选择模型与评测档位</h3><p>系统会发送固定题目与程序生成的离线测试图，自动评分并写入排行榜。</p>";
    elements.caseList.appendChild(empty); return;
  }
  state.results.forEach((result, index) => {
    const article = document.createElement("article"); article.className = `caseItem ${result.status}`;
    if (["done", "failed", "skipped"].includes(result.status)) {
      article.classList.add("clickable"); article.tabIndex = 0; article.setAttribute("role", "button");
      article.setAttribute("aria-label", `查看${result.item.title}详情`);
      article.addEventListener("click", () => openCurrentCaseDetail(result));
      article.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); openCurrentCaseDetail(result); } });
    }
    const icon = document.createElement("span"); icon.className = "caseIcon"; icon.textContent = result.item.type === "vision" ? "图" : "文";
    const text = document.createElement("div"); text.className = "caseText";
    const title = document.createElement("strong"); title.textContent = `${index + 1}. ${result.item.title}`;
    const detail = document.createElement("small"); detail.textContent = result.status === "running" ? "正在调用模型…" : result.note || result.item.focus;
    text.append(title, detail);
    const score = document.createElement("div"); score.className = "caseResult";
    const strong = document.createElement("strong"); strong.textContent = result.status === "pending" ? "—" : result.status === "running" ? "…" : String(result.score ?? 0);
    const small = document.createElement("small"); small.textContent = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)} 秒` : result.status;
    score.append(strong, small); article.append(icon, text, score); elements.caseList.appendChild(article);
  });
}

function detailTag(text) {
  const tag = document.createElement("span"); tag.textContent = text; return tag;
}

function storedCaseDefinition(entry) {
  if (entry.prompt) return entry;
  const builtIn = TEST_CASES.find((item) => item.id === entry.id);
  return { ...entry, title: builtIn?.title || entry.id, prompt: builtIn?.prompt || "旧记录没有保存题目正文", focus: builtIn?.focus || "" };
}

function renderDetail({ title, summary, cases }) {
  elements.resultDetailTitle.textContent = title;
  elements.resultDetailSummary.replaceChildren(...summary.map(detailTag));
  elements.resultDetailCases.replaceChildren();
  for (const source of cases) {
    const item = storedCaseDefinition(source);
    const article = document.createElement("article"); article.className = "detailCase";
    const header = document.createElement("header");
    const heading = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = item.title || item.id;
    const meta = document.createElement("small"); meta.textContent = [item.type === "vision" ? "图片题" : "聊天题", item.custom ? "自定义" : "内置", item.status, item.durationMs ? `${(item.durationMs / 1000).toFixed(1)} 秒` : "", item.tokens ? `${item.tokens} Token` : ""].filter(Boolean).join(" · ");
    heading.append(name, meta);
    const score = document.createElement("span"); score.textContent = `${Number(item.score) || 0} 分`;
    header.append(heading, score); article.appendChild(header);
    const question = document.createElement("section"); question.className = "traceBlock";
    const questionTitle = document.createElement("h3"); questionTitle.textContent = "问题";
    const questionBody = document.createElement("pre"); questionBody.textContent = item.prompt || "（题目正文不可用）";
    question.append(questionTitle, questionBody); article.appendChild(question);
    const answer = document.createElement("section"); answer.className = "traceBlock";
    const answerTitle = document.createElement("h3"); answerTitle.textContent = "模型原始回答";
    const answerBody = document.createElement("pre"); answerBody.textContent = item.output || (item.note ? `（无回答）\n${item.note}` : "（无回答）");
    answer.append(answerTitle, answerBody); article.appendChild(answer);
    if (item.assertions?.length) {
      const rule = document.createElement("section"); rule.className = "traceBlock";
      const ruleTitle = document.createElement("h3"); ruleTitle.textContent = "评分断言";
      const ruleBody = document.createElement("pre"); ruleBody.textContent = JSON.stringify(item.assertions, null, 2);
      rule.append(ruleTitle, ruleBody); article.appendChild(rule);
    }
    elements.resultDetailCases.appendChild(article);
  }
  elements.resultDetailDialog.showModal();
}

function openCurrentCaseDetail(result) {
  renderDetail({
    title: result.item.title,
    summary: [`${result.score ?? 0} 分`, result.item.type === "vision" ? "图片识别" : "聊天能力", result.item.custom ? "自定义题目" : "内置题目", result.note || result.status],
    cases: [{
      id: result.item.id, title: result.item.title, prompt: result.item.prompt, type: result.item.type, custom: result.item.custom,
      assertions: result.item.assertions, status: result.status, score: result.score, output: result.output, note: result.note,
      durationMs: result.durationMs, tokens: result.usage?.total
    }]
  });
}

async function openRunDetails(runId) {
  const rows = await window.room.db.query("SELECT * FROM benchmark_runs WHERE id = ?", [runId]);
  const row = rows[0]; if (!row) throw new Error("评测记录不存在或已被清空");
  let settings = {}; let cases = [];
  try { settings = JSON.parse(row.settings_json); } catch {}
  try { cases = JSON.parse(row.results_json); } catch {}
  renderDetail({
    title: `${row.model_label} · ${formatScore(row.score)} 分`,
    summary: [row.provider_name, row.model_name, `${CATEGORY_LABELS[row.category] || row.category} · ${LEVELS[row.level]?.label || row.level}`, `${row.grade} 级`, `${row.total_tokens} Token${row.token_source === "estimated" ? "（估算）" : ""}`, `${(row.duration_ms / 1000).toFixed(1)} 秒`, settings.customCaseCount ? `自定义题 ${settings.customCaseCount} · ${row.custom_set}` : "仅内置题", settings.supportsImages ? "支持图片" : "仅文本", `题库 ${row.suite_version}`, new Date(row.created_at).toLocaleString("zh-CN")],
    cases: Array.isArray(cases) ? cases : []
  });
}

function updateProgress(done, total, label = "评测进行中") {
  elements.progressLabel.textContent = label;
  elements.progressText.textContent = `${done} / ${total}`;
  elements.progressFill.style.width = `${total ? Math.round(done / total * 100) : 0}%`;
}

function drawRounded(ctx, x, y, width, height, radius, fill, stroke = null) {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}
function drawText(ctx, text, x, y, size = 24, color = "#17352f", weight = 600) {
  ctx.fillStyle = color; ctx.font = `${weight} ${size}px "Microsoft YaHei UI", sans-serif`; ctx.fillText(text, x, y);
}
function canvasBytes(canvas) {
  const base64 = canvas.toDataURL("image/png").split(",")[1];
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { mimeType: "image/png", data: bytes };
}

function createBenchmarkImage(kind) {
  const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 600;
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#eef4f1"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (kind === "dashboard") {
    ctx.fillStyle = "#103c31"; ctx.fillRect(0, 0, 170, 600);
    drawText(ctx, "智变", 36, 55, 28, "#d7f06f", 900);
    drawRounded(ctx, 18, 104, 134, 48, 12, "#d7f06f"); drawText(ctx, "总览", 62, 136, 20, "#17352f", 900);
    drawText(ctx, "物资", 63, 202, 19, "#b8d0c7", 600); drawText(ctx, "批次", 63, 258, 19, "#b8d0c7", 600);
    drawText(ctx, "库存驾驶舱", 210, 65, 30, "#17352f", 900);
    drawRounded(ctx, 740, 28, 170, 48, 12, "#ef9c38"); drawText(ctx, "导出 CSV", 772, 60, 19, "#ffffff", 900);
    const cards = [["待补货", "12", "#ca684f"], ["本月入库", "386", "#1b8b68"], ["风险批次", "3", "#e3972f"]];
    cards.forEach(([label, number, color], index) => {
      const x = 210 + index * 235; drawRounded(ctx, x, 110, 208, 120, 16, "#ffffff", "#d9e6e0");
      drawText(ctx, label, x + 22, 146, 17, "#71867e", 600); drawText(ctx, number, x + 22, 205, 42, color, 900);
    });
    drawRounded(ctx, 210, 260, 680, 285, 18, "#ffffff", "#d9e6e0"); drawText(ctx, "近四周入库趋势", 238, 305, 19, "#17352f", 800);
    [72, 124, 178, 232].forEach((height, index) => {
      ctx.fillStyle = ["#a8d8c7", "#75bda6", "#3e9c7d", "#12634f"][index]; ctx.fillRect(285 + index * 130, 500 - height, 72, height);
      drawText(ctx, `第${index + 1}周`, 290 + index * 130, 525, 14, "#71867e", 500);
    });
  } else if (kind === "permission") {
    ctx.fillStyle = "#123b31"; ctx.fillRect(0, 0, 72, 600);
    drawRounded(ctx, 12, 24, 48, 48, 13, "#d7f06f"); drawText(ctx, "智", 24, 57, 23, "#17352f", 900);
    ["房", "AI", "设"].forEach((text, index) => drawText(ctx, text, text === "AI" ? 24 : 26, 145 + index * 67, text === "AI" ? 17 : 21, index === 2 ? "#d7f06f" : "#a9c3b9", 800));
    drawText(ctx, "维修工单", 112, 64, 28, "#17352f", 900); drawText(ctx, "房间设置 / 权限", 112, 96, 16, "#72877f", 500);
    drawRounded(ctx, 190, 132, 650, 398, 20, "#ffffff", "#d1dfd9"); drawText(ctx, "权限申请", 230, 182, 24, "#17352f", 900);
    drawText(ctx, "房间请求 2 项能力，其中 1 项待处理", 230, 214, 15, "#72877f", 500);
    drawRounded(ctx, 230, 250, 570, 76, 12, "#eff8f4");
    ctx.fillStyle = "#1b936c"; ctx.beginPath(); ctx.arc(264, 288, 14, 0, Math.PI * 2); ctx.fill(); drawText(ctx, "✓", 255, 296, 19, "#ffffff", 900);
    drawText(ctx, "私有数据库", 294, 282, 19, "#17352f", 800); drawText(ctx, "已授权", 294, 307, 13, "#2b8a6a", 700);
    drawRounded(ctx, 230, 338, 570, 76, 12, "#fff7e7", "#efc46a"); ctx.strokeStyle = "#dc922e"; ctx.lineWidth = 3; ctx.strokeRect(251, 364, 26, 26);
    drawText(ctx, "视觉 AI", 294, 371, 19, "#17352f", 800); drawText(ctx, "待授权 · 内容会发送给所选模型", 294, 397, 13, "#a36a1e", 600);
    drawRounded(ctx, 620, 450, 180, 50, 12, "#0d5948"); drawText(ctx, "保存设置", 665, 483, 19, "#d7f06f", 900);
  } else {
    ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, 960, 600);
    drawText(ctx, "房间启动失败", 42, 58, 27, "#ffffff", 900);
    drawRounded(ctx, 42, 88, 876, 90, 12, "#3a1f25", "#a84d5b");
    drawText(ctx, "TypeError: Cannot read properties of undefined (reading 'id')", 66, 132, 20, "#ffb4bd", 700);
    drawText(ctx, "at installCheckpoint (room-runtime.cjs:48:39)", 66, 160, 15, "#d3a4aa", 500);
    drawText(ctx, "SOURCE", 42, 226, 13, "#7dd3fc", 900);
    const lines = ["45  function installCheckpoint(checkpoint) {", "46    const room = loadDraft();", "47    validateRoom(room);", "48    const checkpointId = checkpoint.id;", "49    return install(room, checkpointId);", "50  }"];
    lines.forEach((line, index) => {
      if (index === 3) { ctx.fillStyle = "#713548"; ctx.fillRect(40, 324, 820, 40); }
      drawText(ctx, line, 58, 252 + index * 38, 18, index === 3 ? "#ffe0e5" : "#d2dae5", 500);
    });
    drawRounded(ctx, 42, 500, 876, 62, 10, "#17253a", "#354761"); drawText(ctx, "INSPECTOR   checkpoint = undefined", 66, 539, 19, "#facc15", 700);
  }
  return canvasBytes(canvas);
}

function createImageForCase(item) {
  if (item.image) return createBenchmarkImage(item.image);
  if (item.imageKind === "uploaded") {
    if (!item.imageBase64 || !["image/png", "image/jpeg", "image/webp"].includes(item.imageMime)) throw new Error("自定义测试图片不可用，请重新编辑题目");
    return { mimeType: item.imageMime, data: base64ToBytes(item.imageBase64) };
  }
  if (["dashboard", "permission", "error"].includes(item.imageKind)) return createBenchmarkImage(item.imageKind);
  throw new Error("图片题没有可用的测试图片");
}

function estimateTokens(text) {
  const source = String(text || ""); const chinese = (source.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.max(1, Math.ceil(chinese + (source.length - chinese) / 4));
}
function usageFor(usage, prompt, output, hasImage) {
  const input = Number(usage?.input ?? usage?.prompt_tokens ?? usage?.promptTokens);
  const out = Number(usage?.output ?? usage?.completion_tokens ?? usage?.completionTokens);
  const total = Number(usage?.totalTokens ?? usage?.total_tokens);
  if (Number.isFinite(input) || Number.isFinite(out) || Number.isFinite(total)) {
    const safeInput = Number.isFinite(input) ? input : Math.max(0, total - (Number.isFinite(out) ? out : 0));
    const safeOutput = Number.isFinite(out) ? out : Math.max(0, total - safeInput);
    return { input: Math.round(safeInput), output: Math.round(safeOutput), total: Math.round(Number.isFinite(total) ? total : safeInput + safeOutput), source: "provider" };
  }
  const estimatedInput = estimateTokens(prompt) + (hasImage ? 700 : 0); const estimatedOutput = estimateTokens(output);
  return { input: estimatedInput, output: estimatedOutput, total: estimatedInput + estimatedOutput, source: "estimated" };
}

function aggregateScores(results, category) {
  const average = (type) => {
    const values = results.filter((item) => item.item.type === type).map((item) => Number(item.score) || 0);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const chat = average("chat"); const vision = average("vision");
  const score = category === "chat" ? chat : category === "vision" ? vision : (chat || 0) * .6 + (vision || 0) * .4;
  return { score: Number((score || 0).toFixed(1)), chat: chat === null ? null : Number(chat.toFixed(1)), vision: vision === null ? null : Number(vision.toFixed(1)) };
}

async function initializeDatabase() {
  await window.room.db.run("CREATE TABLE IF NOT EXISTS benchmark_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, suite_version TEXT NOT NULL, custom_set TEXT NOT NULL DEFAULT 'builtin', profile_id TEXT NOT NULL, model_label TEXT NOT NULL, model_name TEXT NOT NULL, provider_id TEXT NOT NULL, provider_name TEXT NOT NULL, category TEXT NOT NULL, level TEXT NOT NULL, score REAL NOT NULL, chat_score REAL, vision_score REAL, grade TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, token_source TEXT NOT NULL, duration_ms INTEGER NOT NULL, case_count INTEGER NOT NULL, error_count INTEGER NOT NULL, settings_json TEXT NOT NULL, results_json TEXT NOT NULL, created_at TEXT NOT NULL)");
  const runColumns = await window.room.db.query("PRAGMA table_info(benchmark_runs)");
  if (!runColumns.some((column) => column.name === "custom_set")) await window.room.db.run("ALTER TABLE benchmark_runs ADD COLUMN custom_set TEXT NOT NULL DEFAULT 'builtin'");
  await window.room.db.run("CREATE INDEX IF NOT EXISTS benchmark_rank_idx ON benchmark_runs (category, level, suite_version, score DESC)");
  await window.room.db.run("CREATE INDEX IF NOT EXISTS benchmark_rank_set_idx ON benchmark_runs (category, level, suite_version, custom_set, score DESC)");
  await window.room.db.run("CREATE TABLE IF NOT EXISTS benchmark_custom_cases (id TEXT PRIMARY KEY, format TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, level TEXT NOT NULL, prompt TEXT NOT NULL, response_format TEXT NOT NULL, max_tokens INTEGER NOT NULL, assertions_json TEXT NOT NULL, image_kind TEXT NOT NULL, image_mime TEXT, image_base64 TEXT, image_name TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
}

function bytesToBase64(bytes) {
  let binary = "";
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let offset = 0; offset < source.length; offset += 0x8000) binary += String.fromCharCode(...source.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function defaultAssertions(format = "json") {
  return format === "text"
    ? [{ path: "$text", operator: "equals", expected: "OK", weight: 100 }]
    : [{ path: "status", operator: "equals", expected: "ok", weight: 100 }];
}

async function loadCustomCases() {
  state.customRecords = await window.room.db.query("SELECT * FROM benchmark_custom_cases ORDER BY created_at ASC");
  state.customCases = [];
  for (const row of state.customRecords) {
    if (!Number(row.enabled)) continue;
    try { state.customCases.push(compileCustomRecord(row)); } catch (error) { row.validationError = error.message || String(error); }
  }
  renderCustomCaseList(); updateSetup();
}

function syncCustomImageFields() {
  const vision = elements.customType.value === "vision";
  elements.customImageField.hidden = !vision;
  elements.customImagePicker.hidden = !vision || elements.customImageSource.value !== "uploaded";
}

function resetCustomForm() {
  elements.customCaseForm.reset(); elements.customCaseId.value = ""; elements.customLevel.value = "standard";
  elements.customMaxTokens.value = "320"; elements.customResponseFormat.value = "json"; elements.customType.value = "chat";
  elements.customAssertions.value = JSON.stringify(defaultAssertions("json"), null, 2);
  state.uploadedImage = null; elements.customImageLabel.textContent = "尚未选择；评测时图片会发送给所选 AI API"; syncCustomImageFields();
}

function editCustomCase(row) {
  elements.customCaseId.value = row.id; elements.customTitle.value = row.title; elements.customType.value = row.type;
  elements.customLevel.value = row.level; elements.customMaxTokens.value = String(row.max_tokens); elements.customPrompt.value = row.prompt;
  elements.customResponseFormat.value = row.response_format; elements.customAssertions.value = JSON.stringify(JSON.parse(row.assertions_json), null, 2);
  elements.customImageSource.value = row.image_kind === "uploaded" ? "uploaded" : ["dashboard", "permission", "error"].includes(row.image_kind) ? row.image_kind : "dashboard";
  state.uploadedImage = row.image_kind === "uploaded" && row.image_base64 ? { mimeType: row.image_mime, base64: row.image_base64, name: row.image_name || "已保存图片" } : null;
  elements.customImageLabel.textContent = state.uploadedImage?.name || "尚未选择；评测时图片会发送给所选 AI API"; syncCustomImageFields();
}

function renderCustomCaseList() {
  elements.customCaseList.replaceChildren();
  if (!state.customRecords.length) {
    const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "暂无自定义题目"; elements.customCaseList.appendChild(empty); return;
  }
  for (const row of state.customRecords) {
    const article = document.createElement("article"); article.className = "customListItem";
    const top = document.createElement("div"); const text = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = row.title;
    const meta = document.createElement("small"); meta.textContent = `${row.type === "vision" ? "图片" : "聊天"} · ${LEVELS[row.level]?.label || row.level}${row.validationError ? " · 规则无效" : ""}`;
    text.append(title, meta); const edit = document.createElement("button"); edit.className = "textButton"; edit.type = "button"; edit.textContent = "编辑"; edit.addEventListener("click", () => editCustomCase(row));
    top.append(text, edit);
    const actions = document.createElement("div"); actions.className = "customListActions";
    const enabledLabel = document.createElement("label"); enabledLabel.className = "switchLabel";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = Boolean(Number(row.enabled));
    enabled.addEventListener("change", () => setCustomCaseEnabled(row.id, enabled.checked).catch((error) => showToast(error.message || String(error), true)));
    enabledLabel.append(enabled, document.createTextNode("参与评测"));
    const remove = document.createElement("button"); remove.className = "textButton danger"; remove.type = "button"; remove.textContent = "删除";
    remove.addEventListener("click", () => deleteCustomCase(row).catch((error) => showToast(error.message || String(error), true)));
    actions.append(enabledLabel, remove); article.append(top, actions); elements.customCaseList.appendChild(article);
  }
}

async function setCustomCaseEnabled(id, enabled) {
  await window.room.db.run("UPDATE benchmark_custom_cases SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, new Date().toISOString(), id]);
  await loadCustomCases();
  await loadLeaderboard();
}

async function deleteCustomCase(row) {
  if (!window.confirm(`确定删除自定义题目“${row.title}”吗？历史评测中的题目与回答仍会保留。`)) return;
  await window.room.db.run("DELETE FROM benchmark_custom_cases WHERE id = ?", [row.id]);
  if (elements.customCaseId.value === row.id) resetCustomForm();
  await loadCustomCases(); await loadLeaderboard(); showToast("自定义题目已删除");
}

async function pickCustomImage() {
  const file = await window.room.files.pickBinary({ extensions: ["png", "jpg", "jpeg", "webp"] });
  if (!file) return;
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > CUSTOM_IMAGE_LIMIT) throw new Error("自定义测试图片必须小于 2 MB");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("只支持 PNG、JPEG 或 WebP 图片");
  state.uploadedImage = { mimeType: file.type, base64: bytesToBase64(file.data), name: String(file.name || "自定义图片").slice(0, 120) };
  elements.customImageLabel.textContent = `${state.uploadedImage.name} · ${(file.size / 1024).toFixed(1)} KB`;
}

async function saveCustomCase(event) {
  event.preventDefault();
  const id = elements.customCaseId.value || `custom_${crypto.randomUUID().replace(/-/g, "")}`;
  const title = elements.customTitle.value.trim(); const type = elements.customType.value; const level = elements.customLevel.value;
  const prompt = elements.customPrompt.value.trim(); const responseFormat = elements.customResponseFormat.value;
  const maxTokens = Number(elements.customMaxTokens.value); const assertions = validateAssertions(elements.customAssertions.value, responseFormat);
  if (title.length < 2 || title.length > 80) throw new Error("题目名称必须是 2-80 个字符");
  if (!LEVELS[level] || !["chat", "vision"].includes(type)) throw new Error("题目类别或等级无效");
  if (prompt.length < 20 || prompt.length > 6000) throw new Error("提示词必须是 20-6000 个字符");
  if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 2000) throw new Error("最大输出 Token 必须是 16-2000 的整数");
  const imageKind = type === "vision" ? elements.customImageSource.value : "none";
  if (type === "vision" && !["dashboard", "permission", "error", "uploaded"].includes(imageKind)) throw new Error("图片题必须选择测试图片");
  if (imageKind === "uploaded" && !state.uploadedImage?.base64) throw new Error("请先选择一张本地测试图片");
  const existing = state.customRecords.find((row) => row.id === id); const now = new Date().toISOString();
  if (!existing && state.customRecords.length >= CUSTOM_CASE_LIMIT) throw new Error(`自定义题目最多保存 ${CUSTOM_CASE_LIMIT} 个`);
  const otherImageBytes = state.customRecords.filter((row) => row.id !== id && row.image_kind === "uploaded").reduce((sum, row) => sum + Math.floor(String(row.image_base64 || "").length * 3 / 4), 0);
  const currentImageBytes = imageKind === "uploaded" ? Math.floor(state.uploadedImage.base64.length * 3 / 4) : 0;
  if (otherImageBytes + currentImageBytes > CUSTOM_IMAGE_TOTAL_LIMIT) throw new Error("自定义测试图片合计不能超过 20 MB");
  const values = [id, CUSTOM_CASE_FORMAT, title, type, level, prompt, responseFormat, maxTokens, JSON.stringify(assertions), imageKind,
    imageKind === "uploaded" ? state.uploadedImage.mimeType : null, imageKind === "uploaded" ? state.uploadedImage.base64 : null,
    imageKind === "uploaded" ? state.uploadedImage.name : null, existing ? Number(existing.enabled) : 1, existing?.created_at || now, now];
  const fields = "id, format, title, type, level, prompt, response_format, max_tokens, assertions_json, image_kind, image_mime, image_base64, image_name, enabled, created_at, updated_at";
  await window.room.db.run(`INSERT OR REPLACE INTO benchmark_custom_cases (${fields}) VALUES (${values.map(() => "?").join(",")})`, values);
  await loadCustomCases(); await loadLeaderboard(); resetCustomForm(); showToast(existing ? "自定义题目已更新" : "自定义题目已添加");
}

function fillRuleExample() {
  const format = elements.customResponseFormat.value;
  elements.customAssertions.value = JSON.stringify(defaultAssertions(format), null, 2);
  if (!elements.customPrompt.value.trim()) {
    elements.customPrompt.value = format === "json"
      ? "请只输出 JSON 对象，字段 status 必须等于 ok，不要输出 Markdown 或解释。"
      : "请只回复大写的 OK，不要添加标点、Markdown 或解释。";
  }
}

async function refreshModels() {
  const preferred = elements.model.value || (await window.room.storage.get("benchmark-preferences"))?.profileId;
  state.models = await window.room.ai.listModels(); elements.model.replaceChildren();
  for (const model of state.models) {
    const option = document.createElement("option"); option.value = model.id;
    option.textContent = `${model.label} · ${model.providerName} · ${model.model}${model.supportsImages ? " · 图文" : " · 文本"}${model.ready ? "" : " · 未就绪"}`;
    option.disabled = !model.ready; elements.model.appendChild(option);
  }
  const chosen = state.models.find((model) => model.id === preferred && model.ready)
    || state.models.find((model) => model.isSelected && model.ready)
    || state.models.find((model) => model.isDefault && model.ready)
    || state.models.find((model) => model.ready);
  elements.model.value = chosen?.id || "";
  const readyCount = state.models.filter((model) => model.ready).length;
  elements.connectionDot.classList.toggle("ready", readyCount > 0);
  elements.connectionLabel.textContent = readyCount ? `主工作台有 ${readyCount} 个可用模型` : "主工作台没有可用模型";
  updateSetup();
}

async function savePreferences() {
  await window.room.storage.set("benchmark-preferences", { profileId: elements.model.value, category: elements.category.value, level: elements.level.value });
}
async function loadPreferences() {
  const preferences = await window.room.storage.get("benchmark-preferences") || {};
  if (CATEGORY_LABELS[preferences.category]) elements.category.value = preferences.category;
  if (LEVELS[preferences.level]) elements.level.value = preferences.level;
  elements.rankingCategory.value = elements.category.value; elements.rankingLevel.value = elements.level.value;
}
async function refreshRunCount() {
  const rows = await window.room.db.query("SELECT COUNT(*) AS count FROM benchmark_runs");
  elements.runCount.textContent = String(rows[0]?.count || 0);
}

async function loadLeaderboard() {
  const category = elements.rankingCategory.value; const level = elements.rankingLevel.value;
  const customSet = benchmarkSetKey(casesFor(category, level));
  const sql = "SELECT * FROM benchmark_runs AS current WHERE category = ? AND level = ? AND suite_version = ? AND custom_set = ? AND id = (SELECT id FROM benchmark_runs AS candidate WHERE candidate.category = current.category AND candidate.level = current.level AND candidate.suite_version = current.suite_version AND candidate.custom_set = current.custom_set AND candidate.profile_id = current.profile_id ORDER BY candidate.score DESC, candidate.created_at DESC LIMIT 1) ORDER BY score DESC, duration_ms ASC LIMIT 50";
  const rows = await window.room.db.query(sql, [category, level, SUITE_VERSION, customSet]); elements.leaderboard.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "暂无同档记录"; elements.leaderboard.appendChild(empty); return;
  }
  rows.forEach((row, index) => {
    let settings = {}; try { settings = JSON.parse(row.settings_json); } catch {}
    const article = document.createElement("article"); article.className = "rankItem"; article.tabIndex = 0; article.setAttribute("role", "button");
    article.setAttribute("aria-label", `查看${row.model_label}评测详情`);
    article.addEventListener("click", () => openRunDetails(row.id).catch((error) => showToast(error.message || String(error), true)));
    article.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); openRunDetails(row.id).catch((error) => showToast(error.message || String(error), true)); }
    });
    const rank = document.createElement("span"); rank.className = "rankNumber"; rank.textContent = String(index + 1);
    const model = document.createElement("div"); model.className = "rankModel";
    const name = document.createElement("strong"); name.textContent = `${row.model_label} · ${row.model_name}`;
    const provider = document.createElement("small"); provider.textContent = `${row.provider_name} · ${new Date(row.created_at).toLocaleString("zh-CN")}`; model.append(name, provider);
    const score = document.createElement("strong"); score.className = "rankScore"; score.textContent = formatScore(row.score);
    const details = document.createElement("div"); details.className = "rankDetails";
    const items = [`${row.grade} 级`, `文 ${formatScore(row.chat_score)}`, `图 ${formatScore(row.vision_score)}`, `${row.total_tokens} Token${row.token_source === "estimated" ? "（估）" : ""}`, `${(row.duration_ms / 1000).toFixed(1)} 秒`, settings.customCaseCount ? `自定义题 ${settings.customCaseCount}` : "仅内置题", settings.supportsImages ? "图文模型" : "文本模型", settings.contextWindow ? `上下文 ${settings.contextWindow}` : "上下文未知", `温度 ${settings.temperature}`];
    for (const value of items) { const tag = document.createElement("span"); tag.textContent = value; details.appendChild(tag); }
    article.append(rank, model, score, details); elements.leaderboard.appendChild(article);
  });
}

async function saveRun({ model, category, level, scores, results, durationMs }) {
  const usage = results.reduce((sum, item) => ({ input: sum.input + (item.usage?.input || 0), output: sum.output + (item.usage?.output || 0), total: sum.total + (item.usage?.total || 0) }), { input: 0, output: 0, total: 0 });
  const tokenSource = results.some((item) => item.usage?.source === "estimated") ? "estimated" : "provider";
  const customSet = benchmarkSetKey(results.map((item) => item.item));
  const settings = { category, level, suiteVersion: SUITE_VERSION, customSet, customCaseCount: results.filter((item) => item.item.custom).length, temperature: 0, supportsImages: model.supportsImages, input: model.input, contextWindow: model.contextWindow, modelMaxTokens: model.maxTokens };
  const storedResults = results.map((item) => ({
    id: item.item.id, title: item.item.title, type: item.item.type, custom: item.item.custom === true, prompt: item.item.prompt,
    focus: item.item.focus, imageKind: item.item.image || item.item.imageKind || null, assertions: item.item.assertions || null,
    score: item.score, status: item.status, durationMs: item.durationMs || 0, tokens: item.usage?.total || 0,
    note: item.note || "", output: String(item.output || "").slice(0, 8000)
  }));
  const values = [SUITE_VERSION, customSet, model.id, model.label, model.model, model.providerId, model.providerName, category, level, scores.score, scores.chat, scores.vision, gradeFor(scores.score), usage.input, usage.output, usage.total, tokenSource, durationMs, results.length, results.filter((item) => ["failed", "skipped"].includes(item.status)).length, JSON.stringify(settings), JSON.stringify(storedResults), new Date().toISOString()];
  const fields = "suite_version, custom_set, profile_id, model_label, model_name, provider_id, provider_name, category, level, score, chat_score, vision_score, grade, input_tokens, output_tokens, total_tokens, token_source, duration_ms, case_count, error_count, settings_json, results_json, created_at";
  await window.room.db.run(`INSERT INTO benchmark_runs (${fields}) VALUES (${values.map(() => "?").join(",")})`, values);
  return { usage, tokenSource };
}

async function startBenchmark() {
  if (state.running) return;
  const model = selectedModel(); if (!model?.ready) return showToast("请先选择可用模型", true);
  const category = elements.category.value; const level = elements.level.value; const cases = selectedCases();
  const estimate = LEVELS[level].estimates[category]; const customCount = cases.filter((item) => item.custom).length;
  if (!window.confirm(`将用“${model.label}”执行 ${cases.length} 项${CATEGORY_LABELS[category]}测试，基础预计 ${estimate} Token${customCount ? `，另含 ${customCount} 个自定义题` : ""}。是否开始？`)) return;
  await savePreferences(); state.running = true;
  const token = ++state.runToken; const startedAt = Date.now();
  state.results = cases.map((item) => ({ item, status: "pending", score: null }));
  elements.start.disabled = true; elements.stop.hidden = false; elements.stop.disabled = false; elements.clearHistory.disabled = true;
  setStatus("running", "评测中"); updateProgress(0, cases.length); renderCases();
  let completed = 0;
  for (const result of state.results) {
    if (token !== state.runToken) break;
    result.status = "running"; renderCases(); elements.progressLabel.textContent = result.item.title;
    const caseStartedAt = Date.now();
    if (result.item.type === "vision" && !model.supportsImages) {
      result.status = "skipped"; result.score = 0; result.note = "模型目录声明不支持图片，能力项记 0 分"; result.durationMs = 0;
    } else {
      try {
        const images = result.item.type === "vision" ? [createImageForCase(result.item)] : [];
        const response = await window.room.ai.generate(result.item.prompt, {
          profileId: model.id, images, maxTokens: result.item.maxTokens, temperature: 0, structuredOutput: result.item.format === "json"
        });
        result.output = response.text; result.score = result.item.score(response.text); result.status = "done";
        result.durationMs = Date.now() - caseStartedAt; result.usage = usageFor(response.usage, result.item.prompt, response.text, images.length > 0);
        result.note = `${result.item.focus} · ${result.usage.total} Token${result.usage.source === "estimated" ? "（估算）" : ""}`;
      } catch (error) {
        result.status = "failed"; result.score = 0; result.durationMs = Date.now() - caseStartedAt;
        result.note = String(error.message || error).slice(0, 160); result.usage = usageFor(null, result.item.prompt, "", Boolean(result.item.image));
      }
    }
    completed += 1; updateProgress(completed, cases.length); renderCases();
  }
  const stopped = token !== state.runToken;
  state.running = false; elements.stop.hidden = true; elements.clearHistory.disabled = false; updateSetup();
  if (stopped) {
    setStatus("stopped", "已停止"); updateProgress(completed, cases.length, "本次未写入排行榜"); showToast("评测已停止，未保存不完整结果"); return;
  }
  const scores = aggregateScores(state.results, category); const durationMs = Date.now() - startedAt;
  const stored = await saveRun({ model, category, level, scores, results: state.results, durationMs });
  elements.currentScore.textContent = formatScore(scores.score);
  elements.currentGrade.textContent = `${gradeFor(scores.score)} 级 · ${CATEGORY_LABELS[category]}${LEVELS[level].label}档`;
  elements.chatScore.textContent = formatScore(scores.chat); elements.visionScore.textContent = formatScore(scores.vision);
  setStatus("finished", "已完成"); updateProgress(cases.length, cases.length, `完成 · ${stored.usage.total} Token${stored.tokenSource === "estimated" ? "（估算）" : ""}`);
  elements.rankingCategory.value = category; elements.rankingLevel.value = level;
  await Promise.all([refreshRunCount(), loadLeaderboard()]); showToast(`评测完成：${scores.score} 分，${gradeFor(scores.score)} 级`);
}

async function clearHistory() {
  if (state.running || !window.confirm("确定清空本房间保存的全部评测记录吗？此操作不能撤销。")) return;
  await window.room.db.run("DELETE FROM benchmark_runs"); await Promise.all([refreshRunCount(), loadLeaderboard()]); showToast("排行榜记录已清空");
}

async function initialize() {
  try {
    await initializeDatabase(); await loadPreferences(); await loadCustomCases(); await refreshModels(); await Promise.all([refreshRunCount(), loadLeaderboard()]);
    document.documentElement.dataset.roomReady = "true";
  } catch (error) {
    document.documentElement.dataset.roomError = String(error.message || error); setStatus("error", "初始化失败"); showToast(`初始化失败：${error.message || error}`, true);
  }
}

elements.model.addEventListener("change", async () => { await savePreferences(); updateSetup(); });
elements.category.addEventListener("change", async () => { elements.rankingCategory.value = elements.category.value; await savePreferences(); updateSetup(); await loadLeaderboard(); });
elements.level.addEventListener("change", async () => { elements.rankingLevel.value = elements.level.value; await savePreferences(); updateSetup(); await loadLeaderboard(); });
elements.rankingCategory.addEventListener("change", loadLeaderboard);
elements.rankingLevel.addEventListener("change", loadLeaderboard);
elements.closeResultDetail.addEventListener("click", () => elements.resultDetailDialog.close());
elements.manageCustomCases.addEventListener("click", () => { resetCustomForm(); renderCustomCaseList(); elements.customCaseDialog.showModal(); });
elements.closeCustomCases.addEventListener("click", () => elements.customCaseDialog.close());
elements.newCustomCase.addEventListener("click", resetCustomForm);
elements.customType.addEventListener("change", syncCustomImageFields);
elements.customImageSource.addEventListener("change", syncCustomImageFields);
elements.customResponseFormat.addEventListener("change", () => {
  if (!elements.customAssertions.value.trim()) elements.customAssertions.value = JSON.stringify(defaultAssertions(elements.customResponseFormat.value), null, 2);
});
elements.pickCustomImage.addEventListener("click", () => pickCustomImage().catch((error) => showToast(error.message || String(error), true)));
elements.loadRuleExample.addEventListener("click", fillRuleExample);
elements.customCaseForm.addEventListener("submit", (event) => saveCustomCase(event).catch((error) => showToast(error.message || String(error), true)));
elements.start.addEventListener("click", () => startBenchmark().catch((error) => { state.running = false; updateSetup(); setStatus("error", "运行失败"); showToast(error.message || String(error), true); }));
elements.stop.addEventListener("click", () => { if (state.running) { state.runToken += 1; elements.stop.disabled = true; elements.progressLabel.textContent = "正在完成当前请求…"; } });
elements.clearHistory.addEventListener("click", () => clearHistory().catch((error) => showToast(error.message || String(error), true)));
removeModelListener = window.room.ai.onModelsChanged(() => refreshModels().catch((error) => showToast(error.message || String(error), true)));
window.addEventListener("beforeunload", () => { removeModelListener?.(); });

initialize();
