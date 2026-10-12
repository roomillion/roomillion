"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { json, validateActions, validateValue } = require("./room-action-schema.cjs");
const TASK_ID = /^task_[a-f0-9]{32}$/;
const fingerprint = room => `${room.version}:${room.packageSha256 || ""}`;
const finalStates = new Set(["completed", "failed", "cancelled", "uncertain"]);

class RoomActionService {
  constructor({ roomStore, roomViews, blobService, onEvent = () => {}, registrationTimeoutMs = 15000, invocationTimeoutMs = 0 }) {
    Object.assign(this, { roomStore, roomViews, blobService, onEvent, registrationTimeoutMs, invocationTimeoutMs });
    this.root = path.join(roomStore.dataRoot, "assistant-tasks");
    this.tasks = new Map(); this.handlers = new Map(); this.pending = new Map(); this.queues = new Map(); this.saves = new Map(); this.starting = new Map();
    this.access = {}; this.disposed = false; this.accessSave = Promise.resolve();
  }
  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    try { this.access = JSON.parse(await fsp.readFile(path.join(this.root, "access.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const file of await fsp.readdir(this.root)) {
      if (!/^task_[a-f0-9]{32}\.json$/.test(file)) continue;
      const task = JSON.parse(await fsp.readFile(path.join(this.root, file), "utf8"));
      if (!TASK_ID.test(task.id)) continue;
      // A process interruption does not prove a write failed. Never silently repeat it.
      if (["running", "queued"].includes(task.status)) {
        task.status = task.effect === "read" || task.status === "queued" ? "failed" : "uncertain";
        task.error = task.status === "uncertain" ? "工作台曾中断，操作可能已经执行。请查看房间结果，确认后再发起新操作。" : "工作台中断，任务未完成，可重新发起。";
        await this.save(task);
      }
      this.tasks.set(task.id, task);
    }
    return this;
  }
  async save(task) {
    const contents = JSON.stringify(task);
    const previous = this.saves.get(task.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const target = path.join(this.root, `${task.id}.json`);
      await fsp.writeFile(`${target}.tmp`, contents); await fsp.rename(`${target}.tmp`, target);
    });
    this.saves.set(task.id, next); await next;
    if (this.saves.get(task.id) === next) this.saves.delete(task.id);
  }
  async definitions(roomId) {
    const room = this.roomStore.getRoom(roomId);
    if (!room) throw new Error("房间已卸载");
    const actions = room.actions || JSON.parse(await fsp.readFile(path.join(this.roomStore.getProgramRoot(roomId), "manifest.json"), "utf8")).actions;
    return { room, actions: validateActions(actions) };
  }
  async catalog(query = "") {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const rooms = await Promise.all(this.roomStore.listRooms().map(async room => {
      const { actions } = await this.definitions(room.id);
      return { id: room.id, name: room.name, version: room.version, enabled: this.access[room.id] !== false, actions: actions.map(({ id, name, description, effect }) => ({ id, name, description, effect })) };
    }));
    return rooms.filter(room => !terms.length || terms.some(term => JSON.stringify(room).toLowerCase().includes(term)));
  }
  async setAccess(roomId, enabled) {
    await this.definitions(roomId);
    if (typeof enabled !== "boolean") throw new Error("助手访问开关必须是布尔值");
    this.access[roomId] = enabled;
    const contents = JSON.stringify(this.access);
    const target = path.join(this.root, "access.json");
    this.accessSave = this.accessSave.catch(() => {}).then(async () => { await fsp.writeFile(`${target}.tmp`, contents); await fsp.rename(`${target}.tmp`, target); });
    await this.accessSave;
    if (!enabled) for (const task of this.tasks.values()) if (task.roomId === roomId && !finalStates.has(task.status)) await this.cancel(task.sessionId, task.id);
    return enabled;
  }
  assertAccess(roomId) { if (this.disposed || this.access[roomId] === false) throw new Error("该房间已关闭助手访问"); }
  register(roomId, sender, ids) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("操作注册列表无效");
    return this.definitions(roomId).then(({ room, actions }) => {
      const allowed = new Set(actions.map(action => action.id));
      if (ids.some(id => !allowed.has(id))) throw new Error("房间只能注册 manifest.actions 中声明的操作");
      if (this.roomViews.getRoomIdForSender(sender.id) !== roomId) throw new Error("操作注册调用方无效");
      this.handlers.set(roomId, { sender, ids: new Set(ids), fingerprint: fingerprint(room) });
      if (!sender.__roomActionObserved) {
        sender.__roomActionObserved = true;
        const invalidate = () => {
          if (this.handlers.get(roomId)?.sender === sender) this.handlers.delete(roomId);
          for (const item of this.pending.values()) if (item.sender === sender) item.reject(new Error("房间窗口已关闭；请检查操作是否已完成"));
        };
        sender.once("destroyed", invalidate);
        sender.on("did-start-loading", invalidate);
      }
      return true;
    });
  }
  publicTask(task, { includeInput = false } = {}) {
    const resultText = task.result === undefined ? "" : JSON.stringify(task.result);
    return { id: task.id, roomId: task.roomId, roomName: task.roomName, actionId: task.actionId, name: task.name, effect: task.effect, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt, progress: task.progress || "", error: task.error || "", artifacts: task.artifacts || [], ...(includeInput ? { input: task.input } : {}), ...(resultText ? { result: resultText.length <= 24000 ? task.result : { preview: resultText.slice(0, 24000), truncated: true, characters: resultText.length } } : {}) };
  }
  get(sessionId, id) {
    const task = this.tasks.get(id);
    if (!task || task.sessionId !== sessionId) throw new Error("任务不存在或不属于当前对话");
    return task;
  }
  list(sessionId) { return [...this.tasks.values()].filter(task => task.sessionId === sessionId).map(task => this.publicTask(task, { includeInput: task.status === "confirmation" })); }
  emit(task) { try { this.onEvent({ sessionId: task.sessionId, task: this.publicTask(task, { includeInput: task.status === "confirmation" }) }); } catch {} }
  async start(sessionId, roomId, actionId, rawInput = {}, callKey = crypto.randomUUID()) {
    const key = `${sessionId}:${callKey}`;
    if (this.starting.has(key)) return this.starting.get(key);
    const promise = this.createTask(sessionId, roomId, actionId, rawInput, callKey);
    this.starting.set(key, promise);
    try { return await promise; } finally { this.starting.delete(key); }
  }
  async createTask(sessionId, roomId, actionId, rawInput, callKey) {
    this.assertAccess(roomId);
    const existing = [...this.tasks.values()].find(task => task.sessionId === sessionId && task.callKey === callKey);
    if (existing) return this.publicTask(existing);
    const { room, actions } = await this.definitions(roomId);
    const action = actions.find(item => item.id === actionId);
    if (!action) throw new Error("房间没有声明此操作");
    const input = json(rawInput); validateValue(action.inputSchema, input);
    const task = { id: `task_${crypto.randomBytes(16).toString("hex")}`, sessionId, callKey, roomId, roomName: room.name, roomFingerprint: fingerprint(room), actionId, name: action.name, effect: action.effect, input, status: ["destructive", "external"].includes(action.effect) ? "confirmation" : "queued", createdAt: Date.now(), updatedAt: Date.now() };
    this.tasks.set(task.id, task); await this.save(task); this.emit(task);
    if (task.status === "queued") this.schedule(task);
    return this.publicTask(task, { includeInput: task.status === "confirmation" });
  }
  async confirm(sessionId, id, allowed) {
    const task = this.get(sessionId, id);
    if (task.status !== "confirmation" || typeof allowed !== "boolean") throw new Error("任务不在等待确认状态");
    this.assertAccess(task.roomId);
    if (fingerprint(this.roomStore.getRoom(task.roomId) || {}) !== task.roomFingerprint) throw new Error("房间已变更，请重新发起操作");
    task.status = allowed ? "queued" : "cancelled"; task.updatedAt = Date.now(); await this.save(task); this.emit(task);
    if (allowed) this.schedule(task);
    return this.publicTask(task);
  }
  schedule(task) {
    const previous = this.queues.get(task.roomId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.run(task)).catch(error => { console.error("保存助手任务失败", error.message); });
    this.queues.set(task.roomId, next);
    next.finally(() => { if (this.queues.get(task.roomId) === next) this.queues.delete(task.roomId); });
  }
  async run(task) {
    if (task.status !== "queued") return;
    let dispatched = false;
    try {
      this.assertAccess(task.roomId);
      const { room, actions } = await this.definitions(task.roomId);
      if (fingerprint(room) !== task.roomFingerprint) throw new Error("房间已升级，请重新查看功能并发起操作");
      const action = actions.find(item => item.id === task.actionId);
      if (!action) throw new Error("操作已不可用");
      await this.roomViews.ensureViewLoaded(task.roomId, room);
      const deadline = Date.now() + this.registrationTimeoutMs;
      let registered;
      while (Date.now() < deadline && task.status === "queued") {
        registered = this.handlers.get(task.roomId);
        if (registered?.fingerprint === task.roomFingerprint && registered.ids.has(task.actionId) && !registered.sender.isDestroyed()) break;
        registered = null; await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (task.status !== "queued") return;
      if (!registered) throw new Error("房间没有注册此操作，或启动未完成；请打开房间检查");
      this.assertAccess(task.roomId);
      if (fingerprint(this.roomStore.getRoom(task.roomId) || {}) !== task.roomFingerprint) throw new Error("房间已变更，请重新发起操作");
      task.status = "running"; task.updatedAt = Date.now(); await this.save(task); this.emit(task);
      if (this.disposed || this.access[task.roomId] === false || task.status !== "running") throw new Error("操作已停止");
      const result = await new Promise((resolve, reject) => {
        const timer = this.invocationTimeoutMs > 0 ? setTimeout(() => {
          try { registered.sender.send("room:actionCancel", task.id); } catch {}
          this.pending.get(task.id)?.reject(new Error("房间操作超时；写入操作可能仍在运行，请先检查房间"));
        }, this.invocationTimeoutMs) : null;
        const finish = fn => value => { clearTimeout(timer); this.pending.delete(task.id); fn(value); };
        this.pending.set(task.id, { sender: registered.sender, resolve: finish(resolve), reject: finish(reject) });
        dispatched = true;
        try { registered.sender.send("room:actionInvoke", { taskId: task.id, actionId: task.actionId, input: task.input }); } catch (error) { this.pending.get(task.id)?.reject(error); }
      });
      if (action.outputSchema) validateValue(action.outputSchema, result, "output");
      const published = result && typeof result === "object" && Array.isArray(result.artifacts) ? result.artifacts : [];
      task.artifacts = [];
      for (const id of published) {
        if (typeof id !== "string" || !this.roomStore.hasPermission(task.roomId, "database")) throw new Error("房间发布制品无效或缺少数据权限");
        const { item } = await this.blobService.getFile(task.roomId, id);
        if (item.kind !== "artifact") throw new Error("只能发布当前房间的制品");
        task.artifacts.push(item);
      }
      task.result = result; task.status = "completed"; task.error = "";
    } catch (error) {
      if (task.status !== "cancelled") task.status = dispatched && task.effect !== "read" ? "uncertain" : "failed";
      task.error = String(error.message || error).slice(0, 2000);
    }
    task.updatedAt = Date.now(); await this.save(task); this.emit(task);
  }
  async receive(roomId, sender, payload) {
    const pending = this.pending.get(payload?.taskId);
    const task = this.tasks.get(payload?.taskId);
    if (!pending || !task || task.roomId !== roomId || pending.sender !== sender) throw new Error("房间操作响应不属于当前调用方或已过期");
    if (payload.progress !== undefined) {
      task.progress = String(payload.progress).slice(0, 1000); this.emit(task); return true;
    }
    if (payload.ok === true) { try { pending.resolve(json(payload.result ?? null)); } catch (error) { pending.reject(error); } }
    else pending.reject(new Error(String(payload.error || "房间操作执行失败").slice(0, 2000)));
    return true;
  }
  async wait(sessionId, id, timeoutMs = 10000) {
    const task = this.get(sessionId, id);
    const end = Date.now() + Math.min(Math.max(Number(timeoutMs) || 0, 0), 10000);
    while (["queued", "running"].includes(task.status) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
    return this.publicTask(task, { includeInput: task.status === "confirmation" });
  }
  async cancel(sessionId, id) {
    const task = this.get(sessionId, id);
    if (finalStates.has(task.status)) return this.publicTask(task);
    const pending = this.pending.get(id);
    if (pending) { try { pending.sender.send("room:actionCancel", id); } catch {} pending.reject(new Error("用户请求停止；请检查房间是否已完成部分操作")); }
    else { task.status = "cancelled"; task.updatedAt = Date.now(); await this.save(task); this.emit(task); }
    return this.publicTask(task);
  }
  async publishedFile(sessionId, taskId, artifactId) {
    const task = this.get(sessionId, taskId);
    if (task.status !== "completed" || !task.artifacts?.some(item => item.id === artifactId)) throw new Error("该文件不是当前对话任务发布的制品");
    this.assertAccess(task.roomId);
    if (!this.roomStore.hasPermission(task.roomId, "database")) throw new Error("来源房间数据权限已撤销");
    return this.blobService.getFile(task.roomId, artifactId);
  }
  async copyFileToRoom(filePath, item, targetRoomId) {
    this.assertAccess(targetRoomId);
    if (!this.roomStore.getRoom(targetRoomId) || !this.roomStore.hasPermission(targetRoomId, "database")) throw new Error("目标房间不存在或缺少数据权限");
    const opened = await this.blobService.begin(targetRoomId, { name: item.name, mimeType: item.mimeType, kind: "artifact" });
    let handle;
    try {
      handle = await fsp.open(filePath, "r");
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        this.assertAccess(targetRoomId);
        if (!this.roomStore.hasPermission(targetRoomId, "database")) throw new Error("目标房间数据权限已撤销");
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        await this.blobService.write(targetRoomId, opened.token, buffer.subarray(0, bytesRead));
      }
      return await this.blobService.finish(targetRoomId, opened.token);
    } catch (error) { await this.blobService.abort(targetRoomId, opened.token); throw error; }
    finally { await handle?.close(); }
  }
  async dispose() {
    this.disposed = true;
    for (const pending of [...this.pending.values()]) pending.reject(new Error("工作台正在退出，请检查任务结果后继续"));
    await Promise.allSettled([...this.queues.values(), ...this.saves.values(), this.accessSave]);
  }
}
module.exports = { RoomActionService, TASK_ID };
