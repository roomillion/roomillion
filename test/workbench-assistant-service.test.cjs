"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchAssistantService } = require("../src/main/workbench-assistant-service.cjs");
const answer = (content, error = null) => ({ role: "assistant", content, api: "openai-completions", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: error ? "error" : content.some(x => x.type === "toolCall") ? "toolUse" : "stop", ...(error ? { errorMessage: error } : {}), timestamp: Date.now() });
test("real Pi assistant retains three turns, retries a broken stream, recovers interrupted tools and never repeats completed writes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-pi-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
  const tasks = new Map(); let writes = 0, broke = false, turns = 0;
  const actions = {
    tasks, catalog: async () => [{ id: "inventory", name: "物资台账", enabled: true, actions: [{ name: "登记" }] }],
    list: id => [...tasks.values()].filter(task => task.sessionId === id), publicTask: task => task,
    start: async (sessionId, roomId, actionId, input, callKey) => { const existing = [...tasks.values()].find(task => task.callKey === callKey); if (existing) return existing; const task = { id: "task" + ++writes, sessionId, roomId, actionId, input, callKey, status: "completed", result: { quantity: writes } }; tasks.set(task.id, task); return task; },
    wait: async (_sessionId, id) => tasks.get(id)
  };
  const streamFn = (_model, context) => {
    const stream = new AssistantMessageEventStream(); const last = context.messages.at(-1);
    const users = context.messages.filter(message => message.role === "user"); turns = Math.max(turns, users.length);
    let result;
    if (users.length === 2 && last.role === "user" && !broke) { broke = true; result = answer([], "Stream ended without finish_reason"); }
    else result = answer(last.role === "user" ? [{ type: "toolCall", name: "call_room_action", id: "reused-call-id", arguments: { roomId: "inventory", actionId: "add", input: { quantity: users.length } } }] : [{ type: "text", text: `已完成第 ${users.length} 次操作` }]);
    stream.push(result.stopReason === "error" ? { type: "error", reason: "error", error: result } : { type: "done", reason: result.stopReason, message: result }); stream.end(result); return stream;
  };
  const aiService = { createAgentRuntime: async () => ({ model: { id: "test", provider: "test", api: "openai-completions", maxTokens: 8000 }, streamFn }), listPublicProfiles: () => [{ id: "model" }] };
  let service = await new WorkbenchAssistantService({ roomStore: { dataRoot: root }, aiService, actions }).init();
  const session = await service.create();
  for (const prompt of ["登记 1 支铅笔", "再加 2 支", "再改一次"]) { await service.send(session.id, prompt); await service.runs.get(session.id)?.promise; }
  assert.equal(writes, 3); assert.equal(turns, 3); assert.equal(service.get(session.id).status, "idle"); assert.equal(service.get(session.id).messages.filter(message => message.role === "user").length, 3);
  const stored = service.require(session.id);
  const lastTool = stored.messages.findLastIndex(message => message.role === "toolResult"); stored.messages.splice(lastTool, 1); stored.status = "working"; await service.persist(stored);
  service = await new WorkbenchAssistantService({ roomStore: { dataRoot: root }, aiService, actions }).init();
  assert.equal(service.get(session.id).status, "stopped"); service.recover(service.require(session.id));
  assert.equal(service.require(session.id).messages.filter(message => message.role === "toolResult").length, 3);
  assert.equal(writes, 3); assert.match(service.require(session.id).messages.filter(message => message.role === "toolResult").at(-1).content[0].text, /task3/);
  await assert.rejects(service.configure(session.id, { profileId: "missing" }), /不存在/);
  await service.dispose();
});
test("assistant preserves user messages after provider setup failure, scopes attachments and rejects replay of an uncertain transfer", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-failure-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actions = { tasks: new Map(), list: () => [], catalog: async () => [], copyFileToRoom: () => assert.fail("must not repeat transfer") };
  const service = await new WorkbenchAssistantService({ roomStore: { dataRoot: root }, aiService: { createAgentRuntime: async () => { throw Error("模型没有密钥"); } }, actions }).init();
  const session = await service.create(); await service.send(session.id, "处理文档"); await service.runs.get(session.id)?.promise;
  assert.equal(service.get(session.id).status, "error"); assert.equal(service.get(session.id).messages[0].text, "处理文档");
  const input = path.join(root, "sample.md"); await fs.writeFile(input, "# 测试"); await service.attachFile(session.id, input);
  const publicFile = service.get(session.id).files[0]; assert.equal(publicFile.path, undefined);
  const persist = service.persist.bind(service); service.persist = async () => { throw Error("disk full"); };
  await assert.rejects(service.send(session.id, "磁盘故障测试"), /disk full/);
  assert.equal(service.runs.has(session.id), false); assert.equal(service.get(session.id).status, "error");
  service.persist = persist;
  const stored = service.require(session.id); stored.journal.transfer = { uncertain: true, name: "transfer_room_file" };
  await assert.rejects(service.tools(stored).find(tool => tool.name === "transfer_room_file").execute("transfer", { fileId: publicFile.id, targetRoomId: "a" }), /不确定/);
  assert.throws(() => service.get("other"), /不存在/); await service.dispose();
});
