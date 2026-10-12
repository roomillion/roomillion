"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { RoomActionService } = require("../src/main/room-action-service.cjs");
const { RoomBlobService } = require("../src/main/room-blob-service.cjs");
const { validateActions, validateValue } = require("../src/main/room-action-schema.cjs");
const { validateManifest } = require("../src/main/manifest.cjs");
const schema = { type: "object", properties: { quantity: { type: "integer", minimum: 0 } }, required: ["quantity"], additionalProperties: false };
const action = (id, effect = "read") => ({ id, name: id, description: "测试操作", effect, inputSchema: schema });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "room-actions-"));
  const rooms = new Map(["a", "b"].map(id => [id, { id, name: id, version: "1.0.0", packageSha256: "first", actions: [action("read"), action("write", "write"), action("delete", "destructive")] }]));
  const denied = new Set();
  const store = { dataRoot: root, listRooms: () => [...rooms.values()], getRoom: id => rooms.get(id), hasPermission: id => !denied.has(id), getDataRoot: id => path.join(root, id, "data") };
  const senders = new Map(["a", "b"].map((id, index) => { const sender = new EventEmitter(); sender.id = index + 1; sender.isDestroyed = () => false; return [id, sender]; }));
  const views = { ensureViewLoaded: async () => {}, getRoomIdForSender: id => id === 1 ? "a" : id === 2 ? "b" : null };
  const blobs = new RoomBlobService(store);
  const service = await new RoomActionService({ roomStore: store, roomViews: views, blobService: blobs, registrationTimeoutMs: 100, invocationTimeoutMs: 150, ...options }).init();
  for (const [id, sender] of senders) await service.register(id, sender, ["read", "write", "delete"]);
  t.after(async () => { await service.dispose(); await blobs.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, rooms, denied, store, views, senders, blobs, service };
}
test("action manifest schema rejects ambiguous effects, unsafe IDs, unsupported schemas and malformed inputs", () => {
  const manifest = { formatVersion: "0.1", id: "a", name: "a", version: "1.0.0", runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" }, entry: "app/index.html", actions: [action("read")] };
  assert.equal(validateManifest(manifest).actions[0].effect, "read");
  for (const bad of [{ ...action("read"), effect: "auto" }, { ...action("read"), id: "../secret" }, { ...action("read"), inputSchema: { type: "object", $ref: "file:///secret" } }]) assert.throws(() => validateActions([bad]));
  assert.throws(() => validateActions([action("read"), action("read")]));
  for (const input of [{}, { quantity: -1 }, { quantity: "1" }, { quantity: 1, path: "C:/secret" }]) assert.throws(() => validateValue(schema, input));
});
test("room actions deduplicate concurrent dispatch, preserve multi-turn writes, bind replies and survive restart", async t => {
  const f = await fixture(t); let quantity = 0, calls = 0;
  f.senders.get("a").send = (channel, request) => {
    if (channel !== "room:actionInvoke") return;
    calls++;
    setTimeout(async () => {
      await assert.rejects(f.service.receive("b", f.senders.get("b"), { taskId: request.taskId, ok: true, result: "forged" }), /不属于/);
      quantity += request.input.quantity;
      await f.service.receive("a", f.senders.get("a"), { taskId: request.taskId, ok: true, result: { quantity } });
    }, 5);
  };
  const [one, duplicate] = await Promise.all([f.service.start("session", "a", "write", { quantity: 2 }, "same-call"), f.service.start("session", "a", "write", { quantity: 2 }, "same-call")]);
  assert.equal(one.id, duplicate.id); assert.equal((await f.service.wait("session", one.id)).result.quantity, 2);
  const two = await f.service.start("session", "a", "write", { quantity: 3 }, "next-call");
  assert.equal((await f.service.wait("session", two.id)).result.quantity, 5); assert.equal(calls, 2);
  assert.throws(() => f.service.get("other-session", one.id), /不属于/);
  const restored = await new RoomActionService({ roomStore: f.store, roomViews: f.views, blobService: f.blobs }).init();
  assert.equal((await restored.start("session", "a", "write", { quantity: 2 }, "same-call")).id, one.id); assert.equal(calls, 2);
  await restored.dispose();
});
test("destructive approval is bound to room version, revocation and declared handlers", async t => {
  const f = await fixture(t); let calls = 0;
  const sender = f.senders.get("a"); sender.send = (_channel, request) => { calls++; f.service.receive("a", sender, { taskId: request.taskId, ok: true, result: null }); };
  await assert.rejects(f.service.register("a", sender, ["secret"]), /声明/);
  const task = await f.service.start("session", "a", "delete", { quantity: 1 }); assert.equal(task.status, "confirmation"); assert.equal(calls, 0);
  f.rooms.get("a").version = "1.0.1"; await assert.rejects(f.service.confirm("session", task.id, true), /变更/); assert.equal(calls, 0);
  await f.service.setAccess("a", false); await assert.rejects(f.service.start("session", "a", "read", { quantity: 1 }), /关闭/);
  await f.service.setAccess("a", true); await f.service.register("a", sender, ["delete"]);
  const next = await f.service.start("session", "a", "delete", { quantity: 1 }); await f.service.confirm("session", next.id, true);
  assert.equal((await f.service.wait("session", next.id)).status, "completed"); assert.equal(calls, 1);
});
test("interrupted or timed-out writes remain uncertain and are not silently replayed", async t => {
  const f = await fixture(t); f.senders.get("a").send = () => {};
  const task = await f.service.start("session", "a", "write", { quantity: 1 }, "once");
  assert.equal((await f.service.wait("session", task.id)).status, "uncertain");
  assert.equal(f.service.pending.has(task.id), false);
  await assert.rejects(f.service.receive("a", f.senders.get("a"), { taskId: task.id, ok: true, result: "late" }), /过期/);
  assert.equal((await f.service.start("session", "a", "write", { quantity: 1 }, "once")).id, task.id);
  const stored = f.service.get("session", task.id); stored.status = "running"; await f.service.save(stored);
  const restored = await new RoomActionService({ roomStore: f.store, roomViews: f.views, blobService: f.blobs }).init();
  assert.equal(restored.get("session", task.id).status, "uncertain"); await restored.dispose();
});
test("artifact transfer accepts only task-published room-owned files and rechecks source and destination grants", async t => {
  const f = await fixture(t); const file = await f.blobs.put("a", { name: "清单.md", kind: "artifact", mimeType: "text/markdown" }, "# 清单\n");
  const privateFile = await f.blobs.put("a", { name: "私有.md", kind: "artifact" }, "private");
  const sender = f.senders.get("a"); sender.send = (_channel, request) => f.service.receive("a", sender, { taskId: request.taskId, ok: true, result: { artifacts: [file.id] } });
  const task = await f.service.start("session", "a", "read", { quantity: 0 }); await f.service.wait("session", task.id);
  await assert.rejects(f.service.publishedFile("session", task.id, privateFile.id), /发布/);
  await assert.rejects(f.service.publishedFile("other", task.id, file.id), /不属于/);
  const source = await f.service.publishedFile("session", task.id, file.id); const copied = await f.service.copyFileToRoom(source.path, source.item, "b");
  assert.equal(Buffer.from((await f.blobs.read("b", copied.id)).data).toString(), "# 清单\n");
  const abort = f.blobs.abort.bind(f.blobs); let aborted = false;
  f.blobs.abort = async (...args) => { aborted = true; return abort(...args); };
  await assert.rejects(f.service.copyFileToRoom(path.join(f.root, "missing.md"), source.item, "b"), /ENOENT/);
  assert.equal(aborted, true);
  await assert.rejects(f.blobs.read("b", file.id), /不存在/);
  f.denied.add("a"); await assert.rejects(f.service.publishedFile("session", task.id, file.id), /撤销/);
  f.denied.add("b"); await assert.rejects(f.service.copyFileToRoom(source.path, source.item, "b"), /权限/);
});
