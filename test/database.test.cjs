"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RoomStore } = require("../src/main/room-store.cjs");
const { RoomDatabaseService } = require("../src/main/database.cjs");

test("each room gets isolated persistent SQLite data", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-db-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const database = await new RoomDatabaseService(store).init();
  const roomA = "cn.zhibian.room-a";
  const roomB = "cn.zhibian.room-b";

  await database.run(roomA, "CREATE TABLE notes (text TEXT NOT NULL)");
  await database.run(roomA, "INSERT INTO notes(text) VALUES(?)", ["only A"]);
  await database.run(roomB, "CREATE TABLE notes (text TEXT NOT NULL)");
  await database.run(roomB, "INSERT INTO notes(text) VALUES(?)", ["only B"]);

  assert.deepEqual(await database.query(roomA, "SELECT text FROM notes"), [{ text: "only A" }]);
  assert.deepEqual(await database.query(roomB, "SELECT text FROM notes"), [{ text: "only B" }]);
  await database.storageSet(roomA, "theme", { mode: "dark" });
  assert.deepEqual(await database.storageGet(roomA, "theme"), { mode: "dark" });
  assert.equal(await database.storageGet(roomB, "theme"), null);

  await database.closeAll();
  const reopened = await new RoomDatabaseService(store).init();
  assert.deepEqual(await reopened.query(roomA, "SELECT text FROM notes"), [{ text: "only A" }]);
  await reopened.closeAll();
});

test("room database rejects cross-file SQL operations", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-db-security-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const database = await new RoomDatabaseService(store).init();
  await assert.rejects(() => database.run("cn.zhibian.secure", "ATTACH DATABASE 'other.db' AS other"), /不允许/);
  await database.closeAll();
});

test("room database recovers the rollback snapshot after an interrupted replacement", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-db-interruption-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const roomId = "cn.zhibian.interrupted";
  const database = await new RoomDatabaseService(store).init();
  await database.run(roomId, "CREATE TABLE notes (text TEXT NOT NULL)");
  const inserted = await database.run(roomId, "INSERT INTO notes(text) VALUES('SAFE_BEFORE_INTERRUPTION')");
  assert.equal(inserted.changes, 1);
  assert.equal(inserted.lastInsertId, 1);
  await database.closeAll();

  const dataRoot = store.getDataRoot(roomId);
  const databasePath = path.join(dataRoot, "room.db");
  const rollbackPath = path.join(dataRoot, "room.db.rollback-simulated");
  const incompleteRestorePath = path.join(dataRoot, "room.db.restore-simulated");
  await fsp.rename(databasePath, rollbackPath);
  await fsp.writeFile(incompleteRestorePath, "INCOMPLETE_RESTORE", "utf8");

  const reopened = await new RoomDatabaseService(store).init();
  assert.deepEqual(await reopened.query(roomId, "SELECT text FROM notes"), [{ text: "SAFE_BEFORE_INTERRUPTION" }]);
  await assert.rejects(() => fsp.access(rollbackPath));
  await assert.rejects(() => fsp.access(incompleteRestorePath));
  await reopened.closeAll();
});
