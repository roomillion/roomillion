"use strict";
const { app, BrowserWindow, protocol, ipcMain } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
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
    handle("room:aiListModels", () => [], runtimeAiPermission);
    handle("room:aiGetSelection", () => ({ profileId: null }), runtimeAiPermission);
    handle("room:aiGetSlotDefinitions", () => room.requestedPermissions?.ai?.slots || {}, runtimeAiPermission);
    handle("room:aiGetSlots", () => ({}), runtimeAiPermission);
    handle("room:aiSelectSlot", (_slot, profileId) => ({ profileId }), runtimeAiPermission);
    handle("room:aiClearSlot", slot => ({ slot, profileId: null }), runtimeAiPermission);
    const aiMock = createRoomRuntimeAiMock(testDefinition?.mocks?.ai);
    const aiRequests = new RoomAiRequests();
    let aiRequestIndex = 0;
    handle("room:aiCancel", (event, requestId) => aiRequests.cancel(event.sender, room.id, requestId), runtimeAiPermission, true);
    handle("room:aiGenerate", async (event, _prompt, options = {}) => {
      const request = aiRequests.start(event.sender, room.id, options.requestId === undefined ? `mock-${++aiRequestIndex}` : options.requestId);
      try {
        return await aiMock.stream({ signal: request.signal, onTextDelta: options.streamRequestId ? delta => {
          if (!event.sender.isDestroyed()) event.sender.send("room:aiTextDelta", { requestId: options.streamRequestId, delta });
        } : undefined });
      } finally { request.finish(); }
    }, runtimeAiPermission, true);
    handle("room:aiBatch", (requests, options) => aiMock.batch(requests, options), runtimeAiPermission);
    handle("room:credentialList", () => []);
    handle("room:networkGetStatus", () => ({ enabled: false, allowed: false, reason: "隔离检查禁止外网" }));
    for (const channel of ["room:pickText", "room:pickBinary", "room:binaryOpen"]) handle(channel, () => null, ["files", "pick"]);
    handle("room:filePickMany", () => [], ["files", "pickMany"]);
    handle("room:directoryOpen", () => null);
    handle("room:directoryGrants", () => []);
    handle("room:directoryList", () => ({ entries: [], total: 0, nextCursor: null }));
    handle("room:directoryRead", () => { throw new Error("隔离检查没有真实目录"); });
    handle("room:directoryWrite", () => { throw new Error("隔离检查不写入真实目录"); });
    handle("room:directoryRevoke", () => true);
    for (const channel of ["room:exportText", "room:exportBinary"]) handle(channel, () => null, ["files", "export"]);
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
        "  const capabilityPattern = /(?:\\bAI\\b|人工智能|模型|联网|网络请求|导入|上传|选择文件|打开文件|导出|下载|浏览网页)/i;",
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
