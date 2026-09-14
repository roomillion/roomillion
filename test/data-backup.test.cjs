"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DataBackupService } = require("../src/main/data-backup-service.cjs");
const { RoomDatabaseService } = require("../src/main/database.cjs");
const { packDirectory } = require("../src/main/room-package.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");

async function createInstalledRoom(root, id = "cn.zhibian.backup-test") {
  const source = path.join(root, "source");
  const packagePath = path.join(root, "room.room");
  await fsp.mkdir(path.join(source, "app"), { recursive: true });
  await fsp.writeFile(path.join(source, "manifest.json"), JSON.stringify({
    formatVersion: "0.1",
    id,
    name: "数据备份测试",
    version: "1.0.0",
    runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" },
    entry: "app/index.html",
    permissions: { database: "private", network: [] },
    hostModules: []
  }), "utf8");
  await fsp.writeFile(path.join(source, "app", "index.html"), "<!doctype html><title>backup</title>", "utf8");
  await packDirectory(source, packagePath);
  const store = await new RoomStore(path.join(root, "workbench-data")).init();
  const room = await store.installPackage(packagePath, { source: "local-generated" });
  return { room, store };
}

test("encrypted zdata restores a room and preserves a pre-restore recovery point", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-data-backup-test-"));
  const { room, store } = await createInstalledRoom(root);
  const database = await new RoomDatabaseService(store).init();
  t.after(async () => {
    await database.closeAll();
    await fsp.rm(root, { recursive: true, force: true });
  });
  const backups = await new DataBackupService(store, database).init();
  await database.run(room.id, "CREATE TABLE records(value TEXT NOT NULL)");
  await database.run(room.id, "INSERT INTO records(value) VALUES(?)", ["ORIGINAL_SECRET_VALUE"]);

  const destination = path.join(root, "room-data.zdata");
  const created = await backups.createBackup(room.id, "correct horse battery", destination);
  assert.equal(created.roomId, room.id);
  const encoded = await fsp.readFile(destination, "utf8");
  assert.doesNotMatch(encoded, /ORIGINAL_SECRET_VALUE/);
  assert.doesNotMatch(encoded, /correct horse battery/);

  await database.run(room.id, "DELETE FROM records");
  await database.run(room.id, "INSERT INTO records(value) VALUES(?)", ["CHANGED_AFTER_BACKUP"]);
  const inspection = await backups.inspectBackup(destination, room.id);
  await assert.rejects(() => backups.restoreBackup(inspection.token, "wrong password"), /密码错误|已损坏/);
  assert.deepEqual(await database.query(room.id, "SELECT value FROM records"), [{ value: "CHANGED_AFTER_BACKUP" }]);

  const restored = await backups.restoreBackup(inspection.token, "correct horse battery");
  assert.equal(restored.backupCreated, true);
  assert.deepEqual(await database.query(room.id, "SELECT value FROM records"), [{ value: "ORIGINAL_SECRET_VALUE" }]);

  const recoveryDirectory = path.join(store.dataRoot, "backups", room.id);
  const recoveryFiles = await fsp.readdir(recoveryDirectory);
  assert.equal(recoveryFiles.filter((name) => name.endsWith("-pre-restore.room.db")).length, 1);
  const points = await backups.listRecoveryPoints(room.id);
  assert.equal(points.length, 1);
  assert.ok(points[0].bytes > 0);
  await assert.rejects(() => backups.readRecoveryPoint(room.id, "../room.db"), /不存在/);
  await assert.rejects(() => backups.readRecoveryPoint("cn.zhibian.other", points[0].name), /不存在/);
  const recovery = await backups.readRecoveryPoint(room.id, points[0].name);
  await backups.restorePlainSnapshot(room.id, recovery);
  assert.deepEqual(await database.query(room.id, "SELECT value FROM records"), [{ value: "CHANGED_AFTER_BACKUP" }]);
});

test("zdata rejects room mismatch and authenticated tampering without changing data", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-data-tamper-test-"));
  const { room, store } = await createInstalledRoom(root);
  const database = await new RoomDatabaseService(store).init();
  t.after(async () => {
    await database.closeAll();
    await fsp.rm(root, { recursive: true, force: true });
  });
  const backups = await new DataBackupService(store, database).init();
  await database.run(room.id, "CREATE TABLE records(value TEXT NOT NULL)");
  await database.run(room.id, "INSERT INTO records(value) VALUES('SAFE_CURRENT_VALUE')");
  const destination = path.join(root, "room-data.zdata");
  await backups.createBackup(room.id, "password-123", destination);

  await assert.rejects(
    () => backups.inspectBackup(destination, "cn.zhibian.different-room"),
    /不能恢复到当前房间/
  );

  const envelope = JSON.parse(await fsp.readFile(destination, "utf8"));
  const first = envelope.payload[0];
  envelope.payload = `${first === "A" ? "B" : "A"}${envelope.payload.slice(1)}`;
  const tamperedPath = path.join(root, "tampered.zdata");
  await fsp.writeFile(tamperedPath, JSON.stringify(envelope), "utf8");
  const inspection = await backups.inspectBackup(tamperedPath, room.id);
  await assert.rejects(() => backups.restoreBackup(inspection.token, "password-123"), /密码错误|已损坏/);
  assert.deepEqual(await database.query(room.id, "SELECT value FROM records"), [{ value: "SAFE_CURRENT_VALUE" }]);
});

test("zdata enforces password policy before writing", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-data-password-test-"));
  const { room, store } = await createInstalledRoom(root);
  const database = await new RoomDatabaseService(store).init();
  t.after(async () => {
    await database.closeAll();
    await fsp.rm(root, { recursive: true, force: true });
  });
  const backups = await new DataBackupService(store, database).init();
  const destination = path.join(root, "weak.zdata");
  await assert.rejects(() => backups.createBackup(room.id, "short", destination), /8-128/);
  await assert.rejects(() => fsp.access(destination));
});

test("zdata export refuses low disk space without replacing an existing file", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-data-disk-export-test-"));
  const { room, store } = await createInstalledRoom(root);
  const database = await new RoomDatabaseService(store).init();
  t.after(async () => {
    await database.closeAll();
    await fsp.rm(root, { recursive: true, force: true });
  });
  const backups = await new DataBackupService(store, database, {
    getAvailableBytes: async () => 0n
  }).init();
  const destination = path.join(root, "existing.zdata");
  await fsp.writeFile(destination, "KEEP_EXISTING_BACKUP", "utf8");
  await assert.rejects(
    () => backups.createBackup(room.id, "password-123", destination),
    /磁盘可用空间不足/
  );
  assert.equal(await fsp.readFile(destination, "utf8"), "KEEP_EXISTING_BACKUP");
});

test("zdata restore refuses low disk space without changing current data", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-data-disk-restore-test-"));
  const { room, store } = await createInstalledRoom(root);
  const database = await new RoomDatabaseService(store).init();
  t.after(async () => {
    await database.closeAll();
    await fsp.rm(root, { recursive: true, force: true });
  });
  await database.run(room.id, "CREATE TABLE records(value TEXT NOT NULL)");
  await database.run(room.id, "INSERT INTO records(value) VALUES('BACKED_UP')");
  const destination = path.join(root, "room-data.zdata");
  const normalBackups = await new DataBackupService(store, database).init();
  await normalBackups.createBackup(room.id, "password-123", destination);
  await database.run(room.id, "DELETE FROM records");
  await database.run(room.id, "INSERT INTO records(value) VALUES('CURRENT_SAFE_DATA')");

  const lowSpaceBackups = await new DataBackupService(store, database, {
    getAvailableBytes: async () => 0n
  }).init();
  const inspection = await lowSpaceBackups.inspectBackup(destination, room.id);
  await assert.rejects(
    () => lowSpaceBackups.restoreBackup(inspection.token, "password-123"),
    /磁盘可用空间不足/
  );
  assert.deepEqual(await database.query(room.id, "SELECT value FROM records"), [{ value: "CURRENT_SAFE_DATA" }]);
});

test("zdata migrates equivalent data between two independent workbench data roots", async (t) => {
  const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-data-source-root-"));
  const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-data-target-root-"));
  const source = await createInstalledRoom(rootA, "cn.zhibian.cross-root");
  const target = await createInstalledRoom(rootB, "cn.zhibian.cross-root");
  const sourceDatabase = await new RoomDatabaseService(source.store).init();
  const targetDatabase = await new RoomDatabaseService(target.store).init();
  t.after(async () => {
    await sourceDatabase.closeAll();
    await targetDatabase.closeAll();
    await fsp.rm(rootA, { recursive: true, force: true });
    await fsp.rm(rootB, { recursive: true, force: true });
  });

  await sourceDatabase.run(source.room.id, "CREATE TABLE records(value TEXT NOT NULL)");
  await sourceDatabase.run(source.room.id, "INSERT INTO records(value) VALUES('FROM_INDEPENDENT_ROOT_A')");
  await targetDatabase.run(target.room.id, "CREATE TABLE records(value TEXT NOT NULL)");
  await targetDatabase.run(target.room.id, "INSERT INTO records(value) VALUES('OLD_ROOT_B_VALUE')");
  const packagePath = path.join(rootA, "cross-root.zdata");
  const sourceBackups = await new DataBackupService(source.store, sourceDatabase).init();
  await sourceBackups.createBackup(source.room.id, "password-123", packagePath);

  const targetBackups = await new DataBackupService(target.store, targetDatabase).init();
  const inspection = await targetBackups.inspectBackup(packagePath, target.room.id);
  const restored = await targetBackups.restoreBackup(inspection.token, "password-123");
  assert.equal(restored.backupCreated, true);
  assert.deepEqual(await targetDatabase.query(target.room.id, "SELECT value FROM records"), [{ value: "FROM_INDEPENDENT_ROOT_A" }]);
  assert.notEqual(source.store.dataRoot, target.store.dataRoot);
});

test("plain app-only export remains a compatible .room", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-transfer-app-plain-"));
  const source = await createInstalledRoom(root, "cn.zhibian.transfer-app-plain");
  const database = await new RoomDatabaseService(source.store).init();
  t.after(async () => {
    await database.closeAll();
    await fsp.rm(root, { recursive: true, force: true });
  });
  const transfers = await new DataBackupService(source.store, database).init();
  const output = path.join(root, "app-only.room");
  const exported = await transfers.createRoomTransfer(source.room.id, { includeData: false, password: "" }, output);
  assert.equal(exported.mode, "app-only");
  assert.equal(exported.protected, false);
  const inspection = await transfers.inspectRoomTransfer(output);
  assert.equal(inspection.locked, undefined);
  assert.equal(inspection.transfer, undefined);
  assert.equal(inspection.room.id, source.room.id);
  await source.store.cancelImport(inspection.token);

  const legacyOutput = path.join(root, "legacy-app-only.zroom");
  await fsp.copyFile(output, legacyOutput);
  const legacyInspection = await transfers.inspectRoomTransfer(legacyOutput);
  assert.equal(legacyInspection.room.id, source.room.id);
  await source.store.cancelImport(legacyInspection.token);
});

test("password can protect an app-only .room and wrong passwords keep it locked", async (t) => {
  const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-transfer-app-protected-source-"));
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-transfer-app-protected-target-"));
  const source = await createInstalledRoom(sourceRoot, "cn.zhibian.transfer-app-protected");
  const sourceDatabase = await new RoomDatabaseService(source.store).init();
  const targetStore = await new RoomStore(path.join(targetRoot, "workbench-data")).init();
  const targetDatabase = await new RoomDatabaseService(targetStore).init();
  t.after(async () => {
    await sourceDatabase.closeAll();
    await targetDatabase.closeAll();
    await fsp.rm(sourceRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });
  const output = path.join(sourceRoot, "app-only-protected.room");
  const sourceTransfers = await new DataBackupService(source.store, sourceDatabase).init();
  const exported = await sourceTransfers.createRoomTransfer(source.room.id, {
    includeData: false,
    password: "app-password"
  }, output);
  assert.equal(exported.protected, true);
  const targetTransfers = await new DataBackupService(targetStore, targetDatabase).init();
  const locked = await targetTransfers.inspectRoomTransfer(output);
  assert.equal(locked.locked, true);
  assert.equal(locked.transfer.kind, "app-only");
  await assert.rejects(() => targetTransfers.unlockRoomTransfer(locked.token, "wrong-password"), /密码错误|已损坏/);
  assert.equal(targetTransfers.pendingEncryptedTransfers.size, 1);
  const inspection = await targetTransfers.unlockRoomTransfer(locked.token, "app-password");
  assert.equal(inspection.transfer.protected, true);
  const installed = await targetStore.commitImport(inspection.token, inspection.defaultSelectedKeys);
  const completion = await targetTransfers.completeRoomTransferImport(inspection.token, installed.id);
  assert.equal(completion.kind, "app-only");
  assert.equal(targetTransfers.pendingEncryptedTransfers.size, 0);
  assert.equal(targetTransfers.pendingRoomBundles.size, 0);
});

for (const protectedTransfer of [false, true]) {
  test(`app-and-data uses .room and restores data ${protectedTransfer ? "with" : "without"} a password`, async (t) => {
    const suffix = protectedTransfer ? "protected" : "plain";
    const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `zhibian-transfer-data-${suffix}-source-`));
    const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `zhibian-transfer-data-${suffix}-target-`));
    const source = await createInstalledRoom(sourceRoot, `cn.zhibian.transfer-data-${suffix}`);
    const sourceDatabase = await new RoomDatabaseService(source.store).init();
    const targetStore = await new RoomStore(path.join(targetRoot, "workbench-data")).init();
    const targetDatabase = await new RoomDatabaseService(targetStore).init();
    t.after(async () => {
      await sourceDatabase.closeAll();
      await targetDatabase.closeAll();
      await fsp.rm(sourceRoot, { recursive: true, force: true });
      await fsp.rm(targetRoot, { recursive: true, force: true });
    });
    await sourceDatabase.run(source.room.id, "CREATE TABLE records(value TEXT NOT NULL)");
    await sourceDatabase.run(source.room.id, "INSERT INTO records(value) VALUES('TRANSFERRED_DATA')");
    const output = path.join(sourceRoot, `app-and-data-${suffix}.room`);
    const sourceTransfers = await new DataBackupService(source.store, sourceDatabase).init();
    const exported = await sourceTransfers.createRoomTransfer(source.room.id, {
      includeData: true,
      password: protectedTransfer ? "data-password" : ""
    }, output);
    assert.equal(path.extname(exported.path), ".room");
    assert.equal(exported.mode, "app-and-data");
    assert.equal(exported.protected, protectedTransfer);
    assert.ok(exported.dataBytes > 0);
    const raw = (await fsp.readFile(output)).toString("latin1");
    if (protectedTransfer) assert.doesNotMatch(raw, /TRANSFERRED_DATA|data-password/);

    const targetTransfers = await new DataBackupService(targetStore, targetDatabase).init();
    const initial = await targetTransfers.inspectRoomTransfer(output);
    assert.equal(Boolean(initial.locked), protectedTransfer);
    const inspection = protectedTransfer
      ? await targetTransfers.unlockRoomTransfer(initial.token, "data-password")
      : initial;
    assert.equal(inspection.transfer.kind, "app-and-data");
    assert.equal(inspection.transfer.protected, protectedTransfer);
    assert.equal(inspection.transfer.data.encrypted, protectedTransfer);
    const installed = await targetStore.commitImport(inspection.token, inspection.defaultSelectedKeys);
    const completion = await targetTransfers.completeRoomTransferImport(inspection.token, installed.id);
    assert.equal(completion.kind, "data-restored");
    assert.deepEqual(
      await targetDatabase.query(installed.id, "SELECT value FROM records"),
      [{ value: "TRANSFERRED_DATA" }]
    );
  });
}
