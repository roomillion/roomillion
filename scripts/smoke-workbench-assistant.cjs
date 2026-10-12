"use strict";
// Isolated real Electron rooms + real Pi loop, with deterministic provider replies.
const { app, BrowserWindow, protocol } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RoomStore } = require("../src/main/room-store.cjs");
const { RoomDatabaseService } = require("../src/main/database.cjs");
const { RoomBlobService } = require("../src/main/room-blob-service.cjs");
const { RoomViewManager } = require("../src/main/room-view-manager.cjs");
const { RoomActionService } = require("../src/main/room-action-service.cjs");
const { WorkbenchAssistantService } = require("../src/main/workbench-assistant-service.cjs");
const { AiService } = require("../src/main/ai-service.cjs");
const { createRoomProtocolHandler } = require("../src/main/room-protocol-handler.cjs");
const { registerIpcHandlers } = require("../src/main/ipc.cjs");
const repository = path.resolve(__dirname, "..");
const realMode = process.argv.includes("--real-ai");
const root = path.join(os.tmpdir(), `roomillion-assistant-smoke-${process.pid}`);
app.setPath("userData", path.join(root, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-gpu");
protocol.registerSchemesAsPrivileged([{ scheme: "room", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }]);
let views, assistant, actions, database, blobs, window, unregister;
const inventory = "cn.zhibian.example.inventory", documents = "cn.zhibian.example.document-workbench", meeting = "cn.zhibian.example.meeting-actions";
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await sleep(50); } throw new Error("Smoke 等待超时"); }
function answer(content, error) { return { role: "assistant", content, api: "openai-completions", provider: "smoke", model: "smoke", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: error ? "error" : content.some(part => part.type === "toolCall") ? "toolUse" : "stop", ...(error ? { errorMessage: error } : {}), timestamp: Date.now() }; }
async function smoke() {
  const store = await new RoomStore(path.join(root, "data")).init();
  for (const name of ["inventory", "document-workbench", "meeting-actions"]) await store.installPackage(path.join(repository, "resources/examples", `${name}.room`), { source: "builtin" });
  database = await new RoomDatabaseService(store).init(); blobs = new RoomBlobService(store);
  window = new BrowserWindow({ show: false, width: 1400, height: 940, titleBarStyle: "hidden", titleBarOverlay: true, webPreferences: { preload: path.join(repository, "src/preload/workbench-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = []; window.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const protocolHandler = createRoomProtocolHandler({ roomStore: store, resourcesRoot: path.join(repository, "resources/room-modules") });
  views = await new RoomViewManager(window, store, protocolHandler).init();
  const emit = payload => window.webContents.send("workbench:assistantEvent", payload);
  actions = await new RoomActionService({ roomStore: store, roomViews: views, blobService: blobs, onEvent: emit }).init();
  const ai = await new AiService(store.dataRoot).init();
  const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
  let broken = false;
  if (realMode) {
    if (!process.env.MIMO_API_KEY) throw new Error("需要 MIMO_API_KEY 环境变量");
    await ai.saveProfile({ providerId: "xiaomi-token-plan-cn", model: "mimo-v2.5", apiKey: process.env.MIMO_API_KEY, rememberKey: false });
  }
  if (!realMode) ai.createAgentRuntime = async () => ({ model: { id: "smoke", provider: "smoke", api: "openai-completions", maxTokens: 8000 }, streamFn: (_model, context) => {
    const users = context.messages.filter(message => message.role === "user"); const turn = users.length;
    const last = context.messages.at(-1); const stream = new AssistantMessageEventStream(); let result;
    const call = (name, input, suffix = "0") => answer([{ type: "toolCall", name, id: `t${turn}-${suffix}`, arguments: input }]);
    const payload = last.role === "toolResult" ? JSON.parse(last.content[0].text) : null;
    if (last.role === "user") {
      if (turn === 1) result = call("call_room_action", { roomId: inventory, actionId: "add", input: { name: "铅笔", quantity: 5, note: "助手登记" } });
      else if (turn === 2) result = call("call_room_action", { roomId: inventory, actionId: "set-quantity", input: { id: 1, quantity: 8 } });
      else if (turn === 3) result = call("call_room_action", { roomId: inventory, actionId: "export", input: { format: "markdown" } });
      else if (turn === 4) result = call("call_room_action", { roomId: inventory, actionId: "remove", input: { id: 1 } });
      else result = call("get_room_task", { taskId: actions.list(assistant.list()[0].id).find(task => task.actionId === "remove").id });
    } else if (turn === 3 && last.toolName === "call_room_action" && payload.actionId === "export") {
      if (!broken) { broken = true; result = answer([], "Stream ended without finish_reason"); }
      else result = call("transfer_room_file", { targetRoomId: documents, taskId: payload.id, artifactId: payload.artifacts[0].id }, "1");
    } else if (turn === 3 && last.toolName === "transfer_room_file") result = call("call_room_action", { roomId: documents, actionId: "convert-markdown", input: { artifactId: payload.artifactId, format: "pdf", name: "物资清单" } }, "2");
    else result = answer([{ type: "text", text: payload?.status === "confirmation" ? "请在执行记录中确认删除。" : "已完成，结果保存在执行记录中。" }]);
    stream.push(result.stopReason === "error" ? { type: "error", reason: "error", error: result } : { type: "done", reason: result.stopReason, message: result }); stream.end(result); return stream;
  } });
  assistant = await new WorkbenchAssistantService({ roomStore: store, aiService: ai, actions, onEvent: emit }).init();
  const outputPath = path.join(root, "saved.pdf");
  unregister = registerIpcHandlers({ mainWindow: window, roomStore: store, database, aiService: ai, blobService: blobs, roomViews: views, roomActions: actions, workbenchAssistant: assistant, examplePackages: [], environment: { appVersion: "0.4.1", electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, git: "smoke" }, networkService: { getPublicState: () => ({ roomNetworkEnabled: false }) }, diagnostics: { record: async () => {} }, dialogApi: { showSaveDialog: async () => ({ canceled: false, filePath: outputPath }) } });
  await window.loadFile(path.join(repository, "src/renderer/index.html"));
  await waitFor(() => window.webContents.executeJavaScript("state.environment !== null && state.environment !== undefined"));
  await window.webContents.executeJavaScript("document.getElementById('assistantButton').click()");
  await waitFor(() => window.webContents.executeJavaScript("document.getElementById('assistantDialog').open"));
  const sessionId = assistant.list()[0].id;
  async function turn(text) {
    await waitFor(() => window.webContents.executeJavaScript("!document.getElementById('assistantSend').disabled"));
    await window.webContents.executeJavaScript(`document.getElementById('assistantPrompt').value=${JSON.stringify(text)};document.getElementById('assistantForm').requestSubmit();`);
    try { await waitFor(() => assistant.require(sessionId).status === "working" || assistant.require(sessionId).messages.filter(message => message.role === "user").length > turn.count); } catch(error) { console.error("UI_STATE", await window.webContents.executeJavaScript("JSON.stringify({status:document.getElementById('assistantStatus').textContent,disabled:document.getElementById('assistantSend').disabled,open:document.getElementById('assistantDialog').open,prompt:document.getElementById('assistantPrompt').value})")); throw error; }
    await waitFor(() => !assistant.runs.has(sessionId), realMode ? 180000 : 30000); turn.count++;
    assert.equal(assistant.get(sessionId).status, "idle", assistant.get(sessionId).error);
  }
  turn.count = 0;
  if (realMode) {
    const started = Date.now();
    await turn("请直接用已安装的物资台账登记一条物资：名称‘助手真实测试铅笔’，数量 5，备注‘隔离测试’。完成后核实记录。不需要创建或修改房间程序。");
    assert.equal((await database.query(inventory, "SELECT quantity FROM inventory WHERE name = ?", ["助手真实测试铅笔"]))[0].quantity, 5);
    await turn("把刚才登记的‘助手真实测试铅笔’数量改为 8，再把当前物资清单生成 Markdown 文件，交给已安装的文档浏览与转换房间转成 PDF。请完成并核实文件；文件留在执行记录中，不需要弹出系统保存窗口。");
    assert.equal((await database.query(inventory, "SELECT quantity FROM inventory WHERE name = ?", ["助手真实测试铅笔"]))[0].quantity, 8);
    assert.equal((await database.query(inventory, "SELECT count(*) AS n FROM inventory"))[0].n, 1);
    const converted = actions.list(sessionId).find(task => task.actionId === "convert-markdown" && task.status === "completed");
    assert.ok(converted, "实际模型应调用文档房间完成 PDF 转换");
    const header = await blobs.read(documents, converted.artifacts[0].id, { length: 5 }); assert.equal(Buffer.from(header.data).toString(), "%PDF-");
    const messages = assistant.require(sessionId).messages;
    const report = { passed: true, model: "mimo-v2.5", turns: 2, tasks: actions.list(sessionId).length, requests: messages.filter(message => message.role === "assistant").length, totalTokens: messages.reduce((sum, message) => sum + (Number(message.usage?.totalTokens) || 0), 0), milliseconds: Date.now() - started, realPdf: true };
    await fs.writeFile(path.join(repository, "release/assistant-real-ai-smoke.json"), JSON.stringify(report, null, 2));
    console.log("WORKBENCH_ASSISTANT_REAL_AI_OK", JSON.stringify(report)); return;
  }
  await turn("登记 5 支铅笔");
  assert.equal((await database.query(inventory, "SELECT quantity FROM inventory"))[0].quantity, 5);
  await turn("把刚才的数量改为 8");
  assert.equal((await database.query(inventory, "SELECT quantity FROM inventory"))[0].quantity, 8);
  const nativeView = views.views.get(inventory);
  await nativeView.webContents.executeJavaScript("document.getElementById('itemForm').elements.name.value='橡皮';document.getElementById('itemForm').elements.quantity.value='2';document.getElementById('itemForm').requestSubmit()");
  await waitFor(async () => (await database.query(inventory, "SELECT count(*) AS n FROM inventory"))[0].n === 2);
  nativeView.webContents.reload();
  await waitFor(() => actions.handlers.get(inventory)?.ids.has("export"));
  await turn("把清单交给文档房间，生成 PDF");
  assert.equal(actions.list(sessionId).filter(task => task.actionId === "export").length, 1);
  const converted = actions.list(sessionId).find(task => task.actionId === "convert-markdown");
  assert.equal(converted.status, "completed", converted.error); assert.ok(converted.artifacts[0].size > 1000);
  const pdf = await blobs.read(documents, converted.artifacts[0].id, { length: 5 }); assert.equal(Buffer.from(pdf.data).toString(), "%PDF-");
  const exported = await window.webContents.executeJavaScript(`window.workbench.assistant.saveArtifact(${JSON.stringify(sessionId)},${JSON.stringify(converted.id)},${JSON.stringify(converted.artifacts[0].id)})`);
  assert.equal(exported.name, "saved.pdf"); assert.equal((await fs.readFile(outputPath)).subarray(0, 5).toString(), "%PDF-");
  await turn("删除刚才登记的铅笔");
  const deletion = actions.list(sessionId).find(task => task.actionId === "remove"); assert.equal(deletion.status, "confirmation");
  assert.equal((await database.query(inventory, "SELECT count(*) AS n FROM inventory"))[0].n, 2);
  await window.webContents.executeJavaScript("[...document.querySelectorAll('#assistantTasks button')].find(button=>button.textContent==='确认执行').click()");
  await waitFor(() => actions.get(sessionId, deletion.id).status === "completed");
  await turn("我确认了，查看结果"); assert.equal((await database.query(inventory, "SELECT count(*) AS n FROM inventory"))[0].n, 1);
  const meetingTask = await actions.start(sessionId, meeting, "add", { title: "验收助手", owner: "小明", dueDate: "2026-10-20", priority: "中" });
  assert.equal((await actions.wait(sessionId, meetingTask.id)).status, "completed");
  const updated = await actions.start(sessionId, meeting, "set-status", { id: 1, status: "done" }); assert.equal((await actions.wait(sessionId, updated.id)).status, "completed");
  const meetingFile = await actions.start(sessionId, meeting, "export", { format: "markdown" }); assert.equal((await actions.wait(sessionId, meetingFile.id)).status, "completed");
  // A room cannot use the trusted assistant APIs or register undeclared functionality.
  assert.match(await nativeView.webContents.executeJavaScript("room.actions.register('undeclared',()=>({})).then(()=> 'bad').catch(error=>error.message)"), /声明/);
  // A malformed action registration must not poison previously valid handlers.
  assert.equal((await actions.start(sessionId, inventory, "list", {}, "post-invalid")).roomId, inventory);
  await waitFor(() => [...actions.tasks.values()].filter(task => task.sessionId === sessionId).every(task => !["queued", "running"].includes(task.status)));
  const geometry = await window.webContents.executeJavaScript(`(() => { const dialog=document.getElementById('assistantDialog'),messages=document.getElementById('assistantMessages');return {overflow:dialog.scrollWidth-dialog.clientWidth,scroll:messages.scrollHeight>messages.clientHeight,buttons:document.querySelectorAll('#assistantTasks button').length};})()`);
  assert.ok(geometry.overflow <= 2); assert.ok(geometry.buttons > 3);
  await waitFor(() => window.webContents.executeJavaScript("!document.getElementById('assistantSend').disabled && document.querySelectorAll('#assistantMessages .assistantMessage.user').length === 5"));
  await sleep(150);
  const screenshotArg = process.argv.find(arg => arg.startsWith("--screenshot="));
  if (screenshotArg) { const image = await window.webContents.capturePage(); await fs.writeFile(screenshotArg.slice(13), image.toPNG()); }
  assert.deepEqual(errors, []);
  console.log("WORKBENCH_ASSISTANT_SMOKE_OK", JSON.stringify({ turns: 5, tasks: actions.list(sessionId).length, streamRetry: broken, realPdf: true, permissionIsolation: true }));
}
app.whenReady().then(smoke).then(async () => { await assistant?.dispose(); await actions?.dispose(); unregister?.(); await views?.dispose(); await database?.closeAll(); await blobs?.dispose(); if (window && !window.isDestroyed()) window.destroy(); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); app.exit(0); }).catch(error => { let message = String(error.stack || error); if (process.env.MIMO_API_KEY) message = message.replaceAll(process.env.MIMO_API_KEY, "[密钥已隐藏]"); console.error(message); app.exit(1); });
