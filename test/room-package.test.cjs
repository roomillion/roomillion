"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { RoomDatabaseService } = require("../src/main/database.cjs");
const { DataBackupService } = require("../src/main/data-backup-service.cjs");
const { RoomVectorService } = require("../src/main/room-vector-service.cjs");
const { extractAndValidate, packDirectory, verifyIntegrity } = require("../src/main/room-package.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");
const { writeGeneratedRoomIcon } = require("../src/main/room-icon.cjs");

async function createSource(root, id = "cn.zhibian.package-test") {
  await fsp.mkdir(path.join(root, "app"), { recursive: true });
  const manifest = {
    formatVersion: "0.1",
    id,
    name: "包测试",
    version: "1.0.0",
    runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" },
    entry: "app/index.html",
    permissions: { database: "private", network: [] },
    hostModules: []
  };
  await fsp.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), "utf8");
  await fsp.writeFile(path.join(root, "app", "index.html"), "<!doctype html><title>test</title>", "utf8");
}

test("64 MiB room packages and databases over 50 MiB round-trip with vector data, with and without passwords", { timeout: 120000 }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-large-package-"));
  const databases = [];
  t.after(async () => { for (const db of databases) await db.closeAll(); await fsp.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source");
  await createSource(source, "cn.zhibian.large-package");
  const file = await fsp.open(path.join(source, "app", "payload.bin"), "w");
  try { for (let i = 0; i < 8; i++) { const chunk = crypto.randomBytes(8 * 1024 * 1024); if (!i) chunk.write("DATA"); await file.write(chunk); } }
  finally { await file.close(); }
  const archive = path.join(root, "large.room");
  await packDirectory(source, archive);
  assert.ok((await fsp.stat(archive)).size > 50 * 1024 * 1024);
  const store = await new RoomStore(path.join(root, "origin")).init();
  const room = await store.installPackage(archive);
  const db = await new RoomDatabaseService(store).init(); databases.push(db);
  const vectors = new RoomVectorService(db);
  await vectors.create(room.id, { name: "docs", dimensions: 2, embedding: "test:embed:2" });
  await vectors.upsert(room.id, "docs", [{ id: "source-page", vector: [1,0], text: "可追溯的原文", metadata: { page: 1 } }], { embedding: "test:embed:2" });
  await db.run(room.id, "CREATE TABLE large_data (content BLOB)");
  await db.run(room.id, "INSERT INTO large_data VALUES(zeroblob(?))", [52 * 1024 * 1024]);
  const transfer = await new DataBackupService(store, db).init();
  const backupPath = path.join(root, "large.zdata");
  const backup = await transfer.createBackup(room.id, "large-backup-test", backupPath);
  assert.ok(backup.bytes > 50 * 1024 * 1024);
  const backupInspection = await transfer.inspectBackup(backupPath, room.id);
  await transfer.restoreBackup(backupInspection.token, "large-backup-test");
  for (const protect of [false, true]) {
    const exported = path.join(root, protect ? "protected.room" : "plain.room");
    const result = await transfer.createRoomTransfer(room.id, { includeData: true, password: protect ? "large-room-test" : "" }, exported);
    assert.ok(result.bytes > 50 * 1024 * 1024);
    assert.ok(result.dataBytes > 50 * 1024 * 1024);
    const target = await new RoomStore(path.join(root, protect ? "target-protected" : "target-plain")).init();
    const targetDb = await new RoomDatabaseService(target).init(); databases.push(targetDb);
    const targetTransfer = await new DataBackupService(target, targetDb).init();
    const initial = await targetTransfer.inspectRoomTransfer(exported);
    const inspection = protect ? await targetTransfer.unlockRoomTransfer(initial.token, "large-room-test") : initial;
    const installed = await target.commitImport(inspection.token, inspection.defaultSelectedKeys);
    await targetTransfer.completeRoomTransferImport(inspection.token, installed.id);
    assert.equal((await targetDb.query(room.id, "SELECT length(content) AS bytes FROM large_data"))[0].bytes, 52 * 1024 * 1024);
    const found = await new RoomVectorService(targetDb).search(room.id, "docs", [1,0], { embedding: "test:embed:2" });
    assert.equal(found[0].text, "可追溯的原文");
    assert.equal(found[0].metadata.page, 1);
  }
});

test("zroom packs, validates, installs, and exports", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-package-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const source = path.join(tempRoot, "source");
  const packagePath = path.join(tempRoot, "room.room");
  await createSource(source);
  const packedManifest = await packDirectory(source, packagePath);
  assert.equal(packedManifest.id, "cn.zhibian.package-test");

  const extracted = await extractAndValidate(packagePath, path.join(tempRoot, "extract"));
  assert.equal(extracted.manifest.name, "包测试");
  assert.equal(extracted.packageInfo.portability.status, "portable");
  assert.deepEqual(extracted.packageInfo.portability.targets, ["win32-x64", "linux-x64"]);
  await verifyIntegrity(extracted.stagingPath);

  const store = await new RoomStore(path.join(tempRoot, "data")).init();
  const installed = await store.installPackage(packagePath);
  assert.equal(installed.id, "cn.zhibian.package-test");
  assert.equal(store.listRooms().length, 1);

  const exportedPath = path.join(tempRoot, "exported.room");
  await store.exportRoom(installed.id, exportedPath);
  const exported = await extractAndValidate(exportedPath, path.join(tempRoot, "export-check"));
  assert.equal(exported.manifest.version, "1.0.0");
});

test("zroom carries a validated display icon and rejects active SVG content", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-icon-package-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const source = path.join(tempRoot, "source");
  await createSource(source, "cn.zhibian.icon-package");
  const manifestPath = path.join(source, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  manifest.icon = "assets/icon.svg";
  await fsp.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await writeGeneratedRoomIcon(source, { name: "包测试", theme: "emerald", icon: { glyph: "包", background: "#173d32", foreground: "#d7f36a" } });
  const archive = path.join(tempRoot, "icon.room");
  await packDirectory(source, archive);
  const inspection = await extractAndValidate(archive, path.join(tempRoot, "extract"));
  assert.equal(inspection.manifest.icon, "assets/icon.svg");
  assert.match(inspection.packageInfo.icon.dataUrl, /^data:image\/svg\+xml;base64,/);
  const store = await new RoomStore(path.join(tempRoot, "data")).init();
  const installed = await store.installPackage(archive);
  assert.equal(installed.icon, "assets/icon.svg");

  await fsp.writeFile(path.join(source, "assets", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
  await assert.rejects(() => packDirectory(source, path.join(tempRoot, "unsafe.room")), /活动内容/);
});

test("integrity verification detects modified files", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-integrity-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const source = path.join(tempRoot, "source");
  const packagePath = path.join(tempRoot, "room.room");
  await createSource(source, "cn.zhibian.integrity-test");
  await packDirectory(source, packagePath);
  const extracted = await extractAndValidate(packagePath, path.join(tempRoot, "extract"));
  await fsp.writeFile(path.join(extracted.stagingPath, "app", "index.html"), "tampered", "utf8");
  await assert.rejects(() => verifyIntegrity(extracted.stagingPath), /完整性校验失败/);
});

test("uninstall can retain room data for reinstall or remove it completely", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-uninstall-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const source = path.join(tempRoot, "source");
  const packagePath = path.join(tempRoot, "room.room");
  await createSource(source, "cn.zhibian.uninstall-test");
  await packDirectory(source, packagePath);
  const store = await new RoomStore(path.join(tempRoot, "data")).init();
  const installed = await store.installPackage(packagePath);
  const roomRoot = store.getRoomRoot(installed.id);
  const retainedFile = path.join(roomRoot, "data", "retained.txt");
  await fsp.mkdir(path.dirname(retainedFile), { recursive: true });
  await fsp.writeFile(retainedFile, "保留的业务数据", "utf8");

  assert.equal(await store.deleteRoom(installed.id, { deleteData: false }), true);
  assert.equal(store.getRoom(installed.id), null);
  await assert.rejects(() => fsp.access(path.join(roomRoot, "program")));
  assert.equal(await fsp.readFile(retainedFile, "utf8"), "保留的业务数据");
  assert.equal(store.permissions.getEntry(installed.id), null);

  const reinstalled = await store.installPackage(packagePath);
  assert.equal(reinstalled.id, installed.id);
  assert.equal(await fsp.readFile(retainedFile, "utf8"), "保留的业务数据");
  assert.equal(await store.deleteRoom(installed.id, { deleteData: true }), true);
  await assert.rejects(() => fsp.access(roomRoot));
});
