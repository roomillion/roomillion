"use strict";
const { app, BrowserWindow, protocol, ipcMain } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { RoomStore } = require("./room-store.cjs");
const { RoomDatabaseService } = require("./database.cjs");
const { RoomViewManager } = require("./room-view-manager.cjs");
const { createCustomRoom } = require("./custom-room.cjs");
const { packDirectory } = require("./room-package.cjs");
const { createRoomProtocolHandler } = require("./room-protocol-handler.cjs");
const { hasPermission } = require("./ipc.cjs");
const { RoomBlobService } = require("./room-blob-service.cjs");
const { RoomJobService } = require("./room-job-service.cjs");
const { normalizeRoomTestDefinition, runDeclaredScenarios } = require("./room-test-definition.cjs");
const { RoomDocumentService } = require("./room-document-service.cjs");
const { RoomToolService } = require("./room-tool-service.cjs");
const { createRoomRuntimeAiMock } = require("./room-runtime-ai-mock.cjs");
const { RoomAiRequests } = require("./room-ai-requests.cjs");
const { BinaryFileService } = require("./binary-file-service.cjs");
const { RoomFileAccessService } = require("./room-file-access-service.cjs");

function start(input, schemeRegistered = false) {
  if (!path.isAbsolute(input) || path.basename(input) !== "input.json") throw new Error("运行检查路径无效");
  const jobRoot = path.dirname(input);
  if (!path.basename(jobRoot).startsWith("zhibian-room-check-")) throw new Error("运行检查必须使用临时目录");
  app.setPath("userData", path.join(jobRoot, "profile"));
  if (!schemeRegistered) protocol.registerSchemesAsPrivileged([{ scheme: "room", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }]);
  let mainWindow, views, database, blobs;
  const report = { passed: false, kind: "isolated-runtime", checks: [], limitations: ["验证隔离启动、重载、可见本地按钮和房间声明的业务场景，不代表视觉效果验收通过", "不调用真实 AI、不联网、不读取用户文件；声明式测试可使用本地 AI 模拟响应"] };
  app.whenReady().then(async () => {
    const payload = JSON.parse(await fsp.readFile(input, "utf8"));
    const store = await new RoomStore(path.join(jobRoot, "data")).init();
    let room;
    let testDefinition = null;
    if (payload?.mode === "installed-program") {
      if (payload.program !== "program") throw new Error("运行检查程序位置无效");
      const sourceRoot = path.join(jobRoot, "program");
      try { testDefinition = normalizeRoomTestDefinition(await fsp.readFile(path.join(sourceRoot, "app", "room-tests.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const packagePath = path.join(jobRoot, "runtime-check.room");
      await packDirectory(sourceRoot, packagePath, { enforceCurrentDependencyPolicy: false });
      room = await store.installPackage(packagePath, { source: "local-generated" });
    } else {
      testDefinition = normalizeRoomTestDefinition(payload?.files?.["room-tests.json"]);
      room = (await createCustomRoom({ spec: payload, roomStore: store })).room;
    }
    database = await new RoomDatabaseService(store).init();
    blobs = new RoomBlobService(store);
    const jobs = new RoomJobService(store);
    const documents = new RoomDocumentService({ resourcesPath: app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../resources"), blobService: blobs });
    const roomTools = new RoomToolService({ documentService: documents, blobService: blobs });
    mainWindow = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const handler = createRoomProtocolHandler({ roomStore: store, resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "room-modules") : path.resolve(__dirname, "../../resources/room-modules") });
    views = await new RoomViewManager(mainWindow, store, handler).init();
    const handle = (channel, fn, permission = null, withEvent = false) => ipcMain.handle(channel, (event, ...args) => {
      if (views.getRoomIdForSender(event.sender.id) !== room.id) throw new Error("运行检查调用方无效");
      if (permission && !hasPermission(room, ...permission)) throw new Error("房间未声明所需权限");
      return withEvent ? fn(event, ...args) : fn(...args);
    });
    handle("room:getInfo", () => room);
    handle("room:dbQuery", (sql, params) => database.query(room.id, sql, params), ["database", "read"]);
    handle("room:dbRun", (sql, params) => database.run(room.id, sql, params), ["database", "write"]);
    handle("room:storageGet", key => database.storageGet(room.id, key), ["database"]);
    handle("room:storageSet", (key, value) => database.storageSet(room.id, key, value), ["database"]);
    const { RoomVectorService } = require("./room-vector-service.cjs");
    const vectors = new RoomVectorService(database);
    for (const method of ["create", "list", "upsert", "search", "remove", "drop"]) handle(`room:vector:${method}`, (...args) => vectors[method](room.id, ...args), ["database"]);
    const runtimeAiRole = room.grantedPermissions?.ai?.roles?.[0];
    const runtimeAiPermission = ["ai", runtimeAiRole];
    const fixtureModels = testDefinition?.mocks?.files?.length ? [{ id: "mock-profile", label: "隔离视觉测试模型", model: "mock-model", providerName: "离线模拟", ready: true, hasCredential: true, supportsImages: true, input: ["text", "image"], contextWindow: 128000 }] : [];
    const fixtureSlots = {};
    handle("room:aiListModels", () => fixtureModels, runtimeAiPermission);
    handle("room:aiGetCapabilities", () => ({
      embedding: { kind: "embedding", configured: true, ready: true, label: "隔离 Embedding", model: "mock-embedding" },
      rerank: { kind: "rerank", configured: true, ready: true, label: "隔离 Rerank", model: "mock-rerank" },
      intuition: { kind: "intuition", configured: true, ready: true, label: "隔离直觉模型", model: "mock-jev" }
    }), runtimeAiPermission);
    handle("room:aiEmbed", texts => {
      if (!Array.isArray(texts) || !texts.length) throw new Error("Embedding 输入必须是非空文本数组");
      const embeddings = texts.map((text, index) => [Math.max(1, String(text).length), index + 1]);
      return { embeddings, dimensions: 2, embedding: "mock:embedding:2", model: "mock-embedding", profileId: "mock-embedding", usage: { input: null, totalTokens: null } };
    }, runtimeAiPermission);
    handle("room:aiRerank", (query, documents, options = {}) => {
      if (typeof query !== "string" || !Array.isArray(documents) || !documents.length) throw new Error("Rerank 隔离测试参数无效");
      const topN = Math.min(Number(options.topN) || documents.length, documents.length);
      const results = documents.map((text, index) => ({ index, relevanceScore: String(text).includes(query) ? 1 : 1 / (index + 2) })).sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, topN);
      return { results, model: "mock-rerank", usage: { searchUnits: null, totalTokens: null } };
    }, runtimeAiPermission);
    handle("room:aiIntuition", (_state, questions) => {
      if (!questions || typeof questions !== "object" || Array.isArray(questions)) throw new Error("直觉模型隔离测试问题无效");
      const answers = {};
      for (const [name, question] of Object.entries(questions)) {
        if (question.type === "noul") answers[name] = { type: "noul", noul: 0.5 };
        else if (question.type === "choice") {
          const choices = Object.keys(question.criteria || {});
          const probability = choices.length ? 1 / choices.length : 0;
          answers[name] = { type: "choice", choice: choices[0], confidence: probability, probabilities: Object.fromEntries(choices.map(choice => [choice, probability])) };
        } else if (question.type === "score") {
          const criteria = Array.isArray(question.criteria) ? question.criteria : [];
          const probability = criteria.length ? 1 / criteria.length : 0;
          answers[name] = { type: "score", score: criteria.length ? (criteria.length - 1) / 2 : 0, confidence: probability, legend: Object.fromEntries(criteria.map((item, index) => [index, item])), probabilities: Object.fromEntries(criteria.map((_item, index) => [index, probability])) };
        } else throw new Error("直觉模型隔离测试问题类型无效");
      }
      return { answers, model: "mock-jev", usage: { inputTokens: null, outputTokens: null } };
    }, runtimeAiPermission);
    handle("room:aiGetSelection", () => ({ profileId: null }), runtimeAiPermission);
    handle("room:aiGetSlotDefinitions", () => room.requestedPermissions?.ai?.slots || {}, runtimeAiPermission);
    handle("room:aiGetSlots", () => ({ ...fixtureSlots }), runtimeAiPermission);
    handle("room:aiSelectSlot", (slot, profileId) => { fixtureSlots[slot] = profileId; return { slot, profileId }; }, runtimeAiPermission);
    handle("room:aiClearSlot", slot => { delete fixtureSlots[slot]; return { slot, profileId: null }; }, runtimeAiPermission);
    const aiMock = createRoomRuntimeAiMock(testDefinition?.mocks?.ai);
    const aiRequests = new RoomAiRequests();
    let aiRequestIndex = 0;
    handle("room:aiCancel", (event, requestId) => aiRequests.cancel(event.sender, room.id, requestId), runtimeAiPermission, true);
    handle("room:aiGenerate", async (event, _prompt, options = {}) => {
      const request = aiRequests.start(event.sender, room.id, options.requestId === undefined ? `mock-${++aiRequestIndex}` : options.requestId);
      try {
        return await aiMock.stream({ signal: request.signal, options, onTextDelta: options.streamRequestId ? delta => {
          if (!event.sender.isDestroyed()) event.sender.send("room:aiTextDelta", { requestId: options.streamRequestId, delta });
        } : undefined });
      } finally { request.finish(); }
    }, runtimeAiPermission, true);
    handle("room:aiBatch", (requests, options) => aiMock.batch(requests, options), runtimeAiPermission);
    handle("room:credentialList", () => []);
    handle("room:networkGetStatus", () => ({ enabled: false, allowed: false, reason: "隔离检查禁止外网" }));
    // Only declared synthetic bytes are materialized under this disposable worker's root.
    // Reuse production file services so handles, paging and room isolation stay identical.
    const fixtureRoot = path.join(jobRoot, "fixtures");
    await fsp.mkdir(fixtureRoot, { recursive: true });
    for (const file of testDefinition?.mocks?.files || []) await fsp.writeFile(path.join(fixtureRoot, file.name), Buffer.from(file.base64, "base64"));
    const binaryFiles = new BinaryFileService();
    const directoryFiles = new RoomFileAccessService(path.join(jobRoot, "fixture-grants"));
    const fixtureNames = options => (testDefinition?.mocks?.files || []).filter(file => !options?.extensions?.length || options.extensions.includes(path.extname(file.name).slice(1).toLowerCase()));
    handle("room:pickText", () => null, ["files", "pick"]);
    let nextBinaryPick = 0;
    handle("room:pickBinary", async options => {
      const file = fixtureNames(options)[nextBinaryPick++];
      if (!file) return null;
      const data = await fsp.readFile(path.join(fixtureRoot, file.name));
      return { name: file.name, size: data.length, type: "application/octet-stream", data: new Uint8Array(data) };
    }, ["files", "pick"]);
    handle("room:binaryOpen", async options => {
      const file = fixtureNames(options)[0];
      return file ? binaryFiles.open(room.id, path.join(fixtureRoot, file.name)) : null;
    }, ["files", "pick"]);
    handle("room:filePickMany", options => Promise.all(fixtureNames(options).map(file => binaryFiles.open(room.id, path.join(fixtureRoot, file.name)))), ["files", "pickMany"]);
    handle("room:binaryRead", (token, options) => {
      if (!hasPermission(room, "files", "pick") && !hasPermission(room, "files", "pickMany")) throw new Error("房间没有选择文件权限");
      return binaryFiles.read(room.id, token, options);
    });
    handle("room:binaryClose", token => binaryFiles.close(room.id, token));
    handle("room:directoryOpen", async (options = {}) => {
      const mode = ["read", "write", "readwrite"].includes(options.mode) ? options.mode : "read";
      if (mode !== "write" && !hasPermission(room, "files", "directoryRead")) throw new Error("房间没有读取文件夹权限");
      if (mode !== "read" && !hasPermission(room, "files", "directoryWrite")) throw new Error("房间没有写入文件夹权限");
      return testDefinition?.mocks?.files?.length ? directoryFiles.grant(room.id, fixtureRoot, mode) : null;
    });
    handle("room:directoryGrants", () => directoryFiles.listGrants(room.id));
    handle("room:directoryList", (id, options) => directoryFiles.list(room.id, id, options), ["files", "directoryRead"]);
    handle("room:directoryRead", (id, relativePath, options) => directoryFiles.read(room.id, id, relativePath, options), ["files", "directoryRead"]);
    handle("room:directoryWrite", (id, relativePath, content) => directoryFiles.write(room.id, id, relativePath, content), ["files", "directoryWrite"]);
    handle("room:directoryRevoke", id => directoryFiles.revoke(room.id, id));
    const captureExports = testDefinition?.mocks?.captureExports === true;
    const exportRoot = path.join(jobRoot, "exports");
    const exportStreams = new Map();
    const recordExport = async (name, target) => {
      const stat = await fsp.stat(target);
      const file = await fsp.open(target, "r");
      let signature;
      try {
        const head = Buffer.alloc(Math.min(8, stat.size));
        await file.read(head, 0, head.length, 0);
        signature = head.toString("latin1");
      } finally { await file.close(); }
      const evidence = { name, bytes: stat.size, signature };
      if (name.endsWith(".md")) evidence.excerpt = (await fsp.readFile(target, "utf8")).slice(0, 500);
      if (name.endsWith(".docx")) {
        const zip = await require("jszip").loadAsync(await fsp.readFile(target));
        const documentXml = await zip.file("word/document.xml")?.async("string");
        if (!documentXml) throw new Error("导出的 Word 缺少正文");
        evidence.docxText = documentXml.replace(/<[^>]*>/g, "").slice(0, 500);
      }
      if (name.endsWith(".pdf")) evidence.pdfPages = (await require("pdf-lib").PDFDocument.load(await fsp.readFile(target))).getPageCount();
      report.exports ||= [];
      report.exports.push(evidence);
    };
    const exportTarget = async (name) => {
      const safeName = path.basename(String(name || "export.bin")).slice(0, 120);
      await fsp.mkdir(exportRoot, { recursive: true });
      return { safeName, target: path.join(exportRoot, `${report.exports?.length || 0}-${safeName}`) };
    };
    handle("room:exportText", async (suggestedName, content) => {
      if (typeof content !== "string") throw new Error("导出内容必须是文本");
      if (!captureExports) return null; // Same result as canceling the production save dialog.
      const { safeName, target } = await exportTarget(suggestedName);
      await fsp.writeFile(target, content, "utf8");
      await recordExport(safeName, target);
      return target;
    }, ["files", "export"]);
    handle("room:exportBinary", async (suggestedName, content) => {
      if (!(content instanceof ArrayBuffer) && !ArrayBuffer.isView(content)) throw new Error("导出内容必须是 ArrayBuffer 或 Uint8Array");
      if (content.byteLength === 0) throw new Error("导出二进制内容不能为空");
      if (!captureExports) return null;
      const { safeName, target } = await exportTarget(suggestedName);
      await fsp.writeFile(target, Buffer.from(content instanceof ArrayBuffer ? content : content.buffer, content.byteOffset || 0, content.byteLength));
      await recordExport(safeName, target);
      return target;
    }, ["files", "export"]);
    handle("room:exportBegin", async suggestedName => {
      if (!captureExports) return null;
      const { safeName, target } = await exportTarget(suggestedName);
      const token = crypto.randomUUID();
      exportStreams.set(token, { safeName, target, handle: await fsp.open(target, "w"), bytes: 0 });
      return { token, path: target, bytes: 0 };
    }, ["files", "export"]);
    handle("room:exportWrite", async (token, content) => {
      const stream = exportStreams.get(String(token || ""));
      if (!stream) throw new Error("隔离导出流不存在");
      const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content instanceof ArrayBuffer ? content : content.buffer, content.byteOffset || 0, content.byteLength);
      if (buffer.length) { await stream.handle.write(buffer); stream.bytes += buffer.length; }
      return { bytes: stream.bytes };
    }, ["files", "export"]);
    handle("room:exportFinish", async token => {
      const stream = exportStreams.get(String(token || ""));
      if (!stream) throw new Error("隔离导出流不存在");
      exportStreams.delete(String(token));
      await stream.handle.close();
      await recordExport(stream.safeName, stream.target);
      return { path: stream.target, bytes: stream.bytes };
    }, ["files", "export"]);
    handle("room:exportAbort", async token => {
      const stream = exportStreams.get(String(token || ""));
      if (!stream) return false;
      exportStreams.delete(String(token));
      await stream.handle.close();
      await fsp.rm(stream.target, { force: true });
      return true;
    }, ["files", "export"]);
    handle("room:blobList", options => blobs.list(room.id, options), ["database"]);
    handle("room:blobPut", (options, content) => blobs.put(room.id, options, content), ["database"]);
    handle("room:blobBegin", options => blobs.begin(room.id, options), ["database"]);
    handle("room:blobWrite", (token, content) => blobs.write(room.id, token, content), ["database"]);
    handle("room:blobFinish", token => blobs.finish(room.id, token), ["database"]);
    handle("room:blobAbort", token => blobs.abort(room.id, token), ["database"]);
    handle("room:blobRead", (id, options) => blobs.read(room.id, id, options), ["database"]);
    handle("room:blobRemove", id => blobs.remove(room.id, id), ["database"]);
    handle("room:toolList", () => roomTools.list(room));
    handle("room:toolCall", (id, input) => roomTools.call(room, id, input));
    handle("room:documentMarkdownToPdf", (source, options = {}) => {
      if (typeof source === "string") return documents.renderMarkdown(room.id, source, options);
      if (source?.artifactId) return documents.renderMarkdownArtifact(room.id, String(source.artifactId), options);
      throw new Error("PDF 源必须是 Markdown 文本或 Markdown 制品 ID");
    }, ["database"]);
    handle("room:jobCreate", input => jobs.create(room.id, input), ["database"]);
    handle("room:jobList", options => jobs.list(room.id, options), ["database"]);
    handle("room:jobGet", id => jobs.get(room.id, id), ["database"]);
    handle("room:jobTransition", (id, input) => jobs.transition(room.id, id, input), ["database"]);
    handle("room:jobRecover", () => jobs.recover(room.id), ["database"]);
    const view = views.createView(room.id);
    // This window is intentionally hidden. Chromium otherwise stretches short test waits
    // to background timer intervals, letting streams finish before the cancel click.
    view.webContents.setBackgroundThrottling(false);
    view.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
    view.webContents.on("render-process-gone", (_event, details) => {
      report.rendererCrashed = true;
      report.rendererCrashReason = String(details?.reason || "unknown").slice(0, 100);
      report.rendererExitCode = Number.isFinite(details?.exitCode) ? details.exitCode : null;
    });
    for (const phase of ["startup", "reload"]) {
      if (phase === "startup") await views.open(room.id);
      else { await database.closeRoom(room.id); await view.webContents.loadURL(`room://${room.id}/${room.entry}`); }
      const result = await view.webContents.executeJavaScript(`new Promise(resolve => { const started=Date.now(); const check=()=>{ const error=document.documentElement.dataset.roomError; if(error) return resolve({passed:false,error}); if(document.documentElement.dataset.roomReady==='true') return setTimeout(()=>resolve({passed:!document.documentElement.dataset.roomError && document.body.getBoundingClientRect().height>0,error:document.documentElement.dataset.roomError||null}),500); if(Date.now()-started>12000) return resolve({passed:false,error:'初始化未完成'});setTimeout(check,100); };check(); })`);
      report.checks.push({ id: phase, ...result });
      if (!result.passed) break;
    }
    if (report.checks.length === 2 && report.checks.every(check => check.passed)) {
      const interactionScript = [
        "(async () => {",
        "  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));",
        "  const seen = new WeakSet();",
        "  const tested = [];",
        "  const skipped = [];",
        "  const capabilityPattern = /(?:\\bAI\\b|人工智能|模型|联网|网络请求|导入|上传|选择文件|打开文件|打开文档|选择一个文档|导出|下载|浏览网页)/i;",
        "  const visible = (element) => {",
        "    const style = getComputedStyle(element);",
        "    const rect = element.getBoundingClientRect();",
        "    return !element.disabled && !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;",
        "  };",
        "  const labelOf = (element) => String(element.getAttribute('aria-label') || element.title || element.textContent || element.id || '未命名按钮').replace(/\\s+/g, ' ').trim().slice(0, 80);",
        "  const fillControls = () => {",
        "    for (const control of document.querySelectorAll('input, textarea, select')) {",
        "      if (!visible(control) || control.disabled || control.readOnly) continue;",
        "      if (control instanceof HTMLInputElement && ['button', 'submit', 'reset', 'file', 'hidden', 'image'].includes(control.type)) continue;",
        "      if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) {",
        "        if (control.required && !control.checked) control.click();",
        "        continue;",
        "      }",
        "      if (control instanceof HTMLSelectElement) {",
        "        if (!control.value && control.options.length) control.selectedIndex = Math.min(1, control.options.length - 1);",
        "      } else if (!control.value) {",
        "        if (control instanceof HTMLInputElement && control.type === 'number') control.value = '1';",
        "        else if (control instanceof HTMLInputElement && control.type === 'date') control.value = '2026-01-02';",
        "        else if (control instanceof HTMLInputElement && control.type === 'email') control.value = 'test@example.com';",
        "        else control.value = '运行检查';",
        "      }",
        "      control.dispatchEvent(new Event('input', { bubbles: true }));",
        "      control.dispatchEvent(new Event('change', { bubbles: true }));",
        "    }",
        "  };",
        "  globalThis.alert = () => {};",
        "  globalThis.confirm = () => true;",
        "  globalThis.prompt = () => '';",
        "  fillControls();",
        "  for (let attempt = 0; attempt < 24; attempt += 1) {",
        "    const candidates = [...document.querySelectorAll(\"button, [role='button']\")].filter((element) => visible(element) && !seen.has(element));",
        "    if (!candidates.length) break;",
        "    const button = candidates[0];",
        "    seen.add(button);",
        "    const label = labelOf(button);",
        "    if (capabilityPattern.test(label)) { skipped.push(label); continue; }",
        "    fillControls();",
        "    button.click();",
        "    tested.push(label);",
        "    await sleep(250);",
        "    const error = document.documentElement.dataset.roomError;",
        "    if (error) return { passed: false, error, tested, skipped, discovered: document.querySelectorAll(\"button, [role='button']\").length };",
        "  }",
        "  return { passed: true, error: null, tested, skipped, discovered: document.querySelectorAll(\"button, [role='button']\").length };",
        "})()"
      ].join("\n");
      const interaction = await view.webContents.executeJavaScript(interactionScript);
      report.checks.push({ id: "interactions", ...interaction });
      if (interaction.passed && testDefinition) {
        aiMock.reset();
        report.checks.push({ id: "declared-scenarios", ...(await runDeclaredScenarios(view.webContents, testDefinition)) });
      }
    }
    report.passed = !report.rendererCrashed && report.checks.length >= 3 && report.checks.every(check => check.passed);
  }).catch(error => { report.error = String(error.message).slice(0, 1000); }).finally(async () => {
    await fsp.writeFile(path.join(jobRoot, "result.json"), JSON.stringify(report));
    views?.destroyAll();
    await blobs?.dispose?.().catch(() => {});
    await database?.closeAll();
    mainWindow?.destroy();
    app.exit(0);
  });
}
// Electron's script entry does not consistently populate require.main.
if (!process.argv.some(argument => argument.startsWith("--room-runtime-check="))) start(process.argv[2]);
module.exports = { start };
