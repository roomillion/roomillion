"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RoomStore } = require("../src/main/room-store.cjs");
const { RoomDatabaseService } = require("../src/main/database.cjs");
const { RoomVectorService } = require("../src/main/room-vector-service.cjs");

test("vectors persist, rank by cosine, filter, roll back batches, isolate rooms and survive snapshot restore", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-vectors-"));
  const store = await new RoomStore(root).init();
  const db = await new RoomDatabaseService(store).init();
  t.after(async () => { await db.closeAll(); await fsp.rm(root, { recursive: true, force: true }); });
  let vectors = new RoomVectorService(db);
  const room = "cn.zhibian.vector-test", other = "cn.zhibian.vector-other";
  await vectors.create(room, { name: "notes", dimensions: 3, embedding: "service:model:3" });
  await vectors.upsert(room, "notes", [
    { id: "one", vector: [2,0,0], text: "第一份材料", metadata: { doc: "a", page: 1 } },
    { id: "two", vector: [0,1,0], text: "第二份材料", metadata: { doc: "b", page: 2 } },
    { id: "three", vector: [-1,0,0], text: "相反方向", metadata: { doc: "a" } }
  ], { embedding: "service:model:3" });
  assert.deepEqual((await vectors.search(room, "notes", [1,0,0], { embedding: "service:model:3", topK: 3 })).map((r) => r.id), ["one", "two", "three"]);
  assert.equal((await vectors.search(room, "notes", [1,0,0], { embedding: "service:model:3", filter: { doc: "b" } }))[0].id, "two");
  assert.deepEqual(await vectors.list(other), []);
  await assert.rejects(vectors.search(other, "notes", [1,0,0], { embedding: "service:model:3" }), /不存在/);
  await assert.rejects(vectors.search(room, "notes", [1,0,0], { embedding: "other-model" }), /模型标识/);
  await assert.rejects(vectors.search(room, "notes", [0,0,0], { embedding: "service:model:3" }), /不能为零/);
  await assert.rejects(vectors.upsert(room, "notes", [
    { id: "one", vector: [0,1,0], text: "不该保存" },
    { id: "bad", vector: [1,2], text: "错误" }
  ], { embedding: "service:model:3" }), /维度/);
  assert.equal((await vectors.search(room, "notes", [1,0,0], { embedding: "service:model:3" }))[0].text, "第一份材料");
  const snapshot = await db.exportSnapshot(room);
  await db.closeAll();
  vectors = new RoomVectorService(db);
  assert.equal((await vectors.list(room))[0].count, 3);
  await vectors.remove(room, "notes", ["one"]);
  assert.equal((await vectors.list(room))[0].count, 2);
  await db.replaceSnapshot(room, snapshot, path.join(root, "pre-restore.db"));
  assert.equal((await vectors.list(room))[0].count, 3);
  await vectors.drop(room, "notes");
  assert.deepEqual(await vectors.list(room), []);
});
