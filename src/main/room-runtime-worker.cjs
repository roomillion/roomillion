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

function start(input, schemeRegistered = false) {
  if (!path.isAbsolute(input) || path.basename(input) !== "input.json") throw new Error("运行检查路径无效");
  const jobRoot = path.dirname(input);
  if (!path.basename(jobRoot).startsWith("zhibian-room-check-")) throw new Error("运行检查必须使用临时目录");
  app.setPath("userData", path.join(jobRoot, "profile"));
  if (!schemeRegistered) protocol.registerSchemesAsPrivileged([{ scheme: "room", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }]);
  let mainWindow, views, database;
  const report = { passed: false, kind: "isolated-startup", checks: [], limitations: ["仅验证隔离启动和重载，不代表业务功能或视觉效果验收通过", "不调用真实 AI、不联网、不读取用户文件；文件选择返回取消"] };
  app.whenReady().then(async () => {
    const payload = JSON.parse(await fsp.readFile(input, "utf8"));
    const store = await new RoomStore(path.join(jobRoot, "data")).init();
    let room;
    if (payload?.mode === "installed-program") {
      if (payload.program !== "program") throw new Error("运行检查程序位置无效");
      const sourceRoot = path.join(jobRoot, "program");
      const packagePath = path.join(jobRoot, "runtime-check.room");
      await packDirectory(sourceRoot, packagePath, { enforceCurrentDependencyPolicy: false });
      room = await store.installPackage(packagePath, { source: "local-generated" });
    } else {
      room = (await createCustomRoom({ spec: payload, roomStore: store })).room;
    }
    database = await new RoomDatabaseService(store).init();
    mainWindow = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const handler = createRoomProtocolHandler({ roomStore: store, resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "room-modules") : path.resolve(__dirname, "../../resources/room-modules") });
    views = await new RoomViewManager(mainWindow, store, handler).init();
    const handle = (channel, fn, permission = null) => ipcMain.handle(channel, (event, ...args) => {
      if (views.getRoomIdForSender(event.sender.id) !== room.id) throw new Error("运行检查调用方无效");
      if (permission && !hasPermission(room, ...permission)) throw new Error("房间未声明所需权限");
      return fn(...args);
    });
    handle("room:getInfo", () => room);
    handle("room:dbQuery", (sql, params) => database.query(room.id, sql, params), ["database", "read"]);
    handle("room:dbRun", (sql, params) => database.run(room.id, sql, params), ["database", "write"]);
    handle("room:storageGet", key => database.storageGet(room.id, key), ["database"]);
    handle("room:storageSet", (key, value) => database.storageSet(room.id, key, value), ["database"]);
    const { RoomVectorService } = require("./room-vector-service.cjs");
    const vectors = new RoomVectorService(database);
    for (const method of ["create", "list", "upsert", "search", "remove", "drop"]) handle(`room:vector:${method}`, (...args) => vectors[method](room.id, ...args), ["database"]);
    handle("room:aiListModels", () => [], ["ai", "invoke"]);
    handle("room:aiGetSelection", () => ({ profileId: null }), ["ai", "invoke"]);
    handle("room:networkGetStatus", () => ({ enabled: false, allowed: false, reason: "隔离检查禁止外网" }));
    for (const channel of ["room:pickText", "room:pickBinary", "room:binaryOpen"]) handle(channel, () => null, ["files", "pick"]);
    for (const channel of ["room:exportText", "room:exportBinary"]) handle(channel, () => null, ["files", "export"]);
    const view = views.createView(room.id);
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
    report.passed = !report.rendererCrashed && report.checks.length === 2 && report.checks.every(check => check.passed);
  }).catch(error => { report.error = String(error.message).slice(0, 1000); }).finally(async () => {
    await fsp.writeFile(path.join(jobRoot, "result.json"), JSON.stringify(report));
    views?.destroyAll();
    await database?.closeAll();
    mainWindow?.destroy();
    app.exit(0);
  });
}
// Electron's script entry does not consistently populate require.main.
if (!process.argv.some(argument => argument.startsWith("--room-runtime-check="))) start(process.argv[2]);
module.exports = { start };
