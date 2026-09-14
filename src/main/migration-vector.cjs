"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { RoomStore } = require("./room-store.cjs");
const { RoomDatabaseService } = require("./database.cjs");
const { DataBackupService } = require("./data-backup-service.cjs");
const { sha256 } = require("./room-package.cjs");

const VECTOR_KIND = "zhibian-cross-platform-migration";
const VECTOR_FORMAT_VERSION = "0.1";
const TEST_PASSWORD = "zhibian-migration-0.1";
const ROOM_FILE = "migration-room.room";
const DATA_FILE = "migration-data.zdata";
const VECTOR_FILE = "vector.json";
const TARGET_REPORT_FILE = "target-report.json";
const MAX_VECTOR_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LABEL_PATTERN = /^[A-Za-z0-9._+() /-]{1,120}$/;

function runtimeLabel() {
  return `${process.platform}-${process.arch}`;
}

function validateLabel(value, field) {
  if (typeof value !== "string" || !LABEL_PATTERN.test(value)) throw new Error(`${field} 无效`);
  return value;
}

function rowsSha256(rows) {
  return sha256(Buffer.from(JSON.stringify(rows), "utf8"));
}

function assertSafeDirectory(target) {
  if (typeof target !== "string" || target.length === 0 || target.length > 2000) throw new Error("输出目录无效");
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved === path.resolve(process.cwd())) throw new Error("拒绝使用过宽的输出目录");
  return resolved;
}

async function createFreshDirectory(target) {
  const resolved = assertSafeDirectory(target);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  try {
    await fsp.mkdir(resolved);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`输出目录必须不存在：${resolved}`);
    throw error;
  }
  return resolved;
}

async function writeJsonExclusive(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function readJsonLimited(filePath) {
  const stats = await fsp.stat(filePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_VECTOR_BYTES) throw new Error("迁移向量元数据大小无效");
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function fileSha256(filePath) {
  return sha256(await fsp.readFile(filePath));
}

function validateVector(input, expectedPhase) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("迁移向量格式无效");
  if (input.kind !== VECTOR_KIND || input.formatVersion !== VECTOR_FORMAT_VERSION) throw new Error("不支持的迁移向量版本");
  if (input.phase !== expectedPhase) throw new Error(`迁移向量阶段应为 ${expectedPhase}`);
  if (!input.room || typeof input.room !== "object" || typeof input.room.id !== "string" || typeof input.room.version !== "string") {
    throw new Error("迁移向量缺少房间信息");
  }
  if (!input.files || !SHA256_PATTERN.test(input.files.roomSha256) || !SHA256_PATTERN.test(input.files.dataSha256)) {
    throw new Error("迁移向量文件哈希无效");
  }
  if (!input.expected || !Number.isInteger(input.expected.rowCount) || input.expected.rowCount < 1 || !SHA256_PATTERN.test(input.expected.rowsSha256)) {
    throw new Error("迁移向量预期结果无效");
  }
  validateLabel(input.sourceRuntime, "sourceRuntime");
  if (expectedPhase === "return") validateLabel(input.targetRuntime, "targetRuntime");
  if (input.testPassword !== TEST_PASSWORD) throw new Error("迁移向量测试密码标识无效");
  return input;
}

async function loadVector(inputRoot, expectedPhase) {
  const root = path.resolve(inputRoot);
  const vectorPath = path.join(root, VECTOR_FILE);
  const vector = validateVector(await readJsonLimited(vectorPath), expectedPhase);
  const roomPath = path.join(root, ROOM_FILE);
  const dataPath = path.join(root, DATA_FILE);
  const actualRoomSha256 = await fileSha256(roomPath);
  const actualDataSha256 = await fileSha256(dataPath);
  if (actualRoomSha256 !== vector.files.roomSha256) throw new Error("迁移房间包 SHA-256 不匹配");
  if (actualDataSha256 !== vector.files.dataSha256) throw new Error("迁移数据包 SHA-256 不匹配");
  return {
    root,
    vectorPath,
    vectorSha256: await fileSha256(vectorPath),
    vector,
    roomPath,
    dataPath
  };
}

async function createServices(dataRoot) {
  const store = await new RoomStore(dataRoot).init();
  const database = await new RoomDatabaseService(store).init();
  const backups = await new DataBackupService(store, database).init();
  return { store, database, backups };
}

async function queryProbeRows(database, roomId) {
  return database.query(
    roomId,
    "SELECT sequence, origin, text_value, numeric_value FROM migration_probe ORDER BY sequence"
  );
}

async function installAndRestore(services, loaded) {
  const room = await services.store.installPackage(loaded.roomPath, {
    source: "external",
    selectedKeys: ["database.private"]
  });
  if (room.id !== loaded.vector.room.id || room.version !== loaded.vector.room.version) {
    throw new Error("安装后的房间身份与迁移向量不一致");
  }
  const inspection = await services.backups.inspectBackup(loaded.dataPath, room.id);
  await services.backups.restoreBackup(inspection.token, TEST_PASSWORD);
  const rows = await queryProbeRows(services.database, room.id);
  if (rows.length !== loaded.vector.expected.rowCount || rowsSha256(rows) !== loaded.vector.expected.rowsSha256) {
    throw new Error("恢复后的业务数据与迁移向量不一致");
  }
  return { room, rows };
}

async function createSourceVector({ roomPackagePath, outputRoot, sourceRuntime = runtimeLabel() }) {
  validateLabel(sourceRuntime, "sourceRuntime");
  const roomStats = await fsp.stat(roomPackagePath);
  if (!roomStats.isFile()) throw new Error("源房间包不是普通文件");
  const requestedOutput = assertSafeDirectory(outputRoot);
  const sourceRoomSha256 = await fileSha256(roomPackagePath);
  try {
    const existingStats = await fsp.stat(requestedOutput);
    if (!existingStats.isDirectory()) throw new Error("已有迁移向量路径不是目录");
    const existing = await loadVector(requestedOutput, "source");
    if (existing.vector.sourceRuntime !== sourceRuntime || existing.vector.files.roomSha256 !== sourceRoomSha256) {
      throw new Error("已有迁移源与当前平台或房间包不一致，请换用新的输出目录");
    }
    return { outputRoot: requestedOutput, vector: existing.vector, rows: null, reused: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const output = await createFreshDirectory(requestedOutput);
  const workRoot = await fsp.mkdtemp(path.join(path.dirname(output), ".zhibian-migration-source-"));
  let services;
  try {
    services = await createServices(path.join(workRoot, "data"));
    const room = await services.store.installPackage(roomPackagePath, {
      source: "local-generated",
      selectedKeys: ["database.private"]
    });
    await services.database.run(room.id, "CREATE TABLE migration_probe(sequence INTEGER PRIMARY KEY, origin TEXT NOT NULL, text_value TEXT NOT NULL, numeric_value INTEGER NOT NULL)");
    await services.database.run(
      room.id,
      "INSERT INTO migration_probe(sequence, origin, text_value, numeric_value) VALUES(?, ?, ?, ?)",
      [1, sourceRuntime, "Windows 生成：中文、ASCII、emoji 🚀", 20260829]
    );
    const rows = await queryProbeRows(services.database, room.id);
    const roomPath = path.join(output, ROOM_FILE);
    const dataPath = path.join(output, DATA_FILE);
    await services.store.exportRoom(room.id, roomPath);
    await services.backups.createBackup(room.id, TEST_PASSWORD, dataPath);
    const vector = {
      kind: VECTOR_KIND,
      formatVersion: VECTOR_FORMAT_VERSION,
      phase: "source",
      createdAt: new Date().toISOString(),
      sourceRuntime,
      room: { id: room.id, name: room.name, version: room.version },
      files: {
        room: ROOM_FILE,
        roomSha256: await fileSha256(roomPath),
        data: DATA_FILE,
        dataSha256: await fileSha256(dataPath)
      },
      expected: { rowCount: rows.length, rowsSha256: rowsSha256(rows) },
      testPassword: TEST_PASSWORD,
      notice: "仅用于公开迁移验收，不得承载真实业务数据。"
    };
    await writeJsonExclusive(path.join(output, VECTOR_FILE), vector);
    return { outputRoot: output, vector, rows, reused: false };
  } catch (error) {
    await fsp.rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await services?.database.closeAll();
    await fsp.rm(workRoot, { recursive: true, force: true });
  }
}

async function consumeTargetVector({ inputRoot, outputRoot, targetRuntime = runtimeLabel() }) {
  validateLabel(targetRuntime, "targetRuntime");
  const loaded = await loadVector(inputRoot, "source");
  const output = await createFreshDirectory(outputRoot);
  const workRoot = await fsp.mkdtemp(path.join(path.dirname(output), ".zhibian-migration-target-"));
  let services;
  try {
    services = await createServices(path.join(workRoot, "data"));
    const restored = await installAndRestore(services, loaded);
    await services.database.run(
      restored.room.id,
      "INSERT INTO migration_probe(sequence, origin, text_value, numeric_value) VALUES(?, ?, ?, ?)",
      [2, targetRuntime, "Linux/UOS 写入：往返迁移确认 ✓", 2]
    );
    const rows = await queryProbeRows(services.database, restored.room.id);
    const roomPath = path.join(output, ROOM_FILE);
    const dataPath = path.join(output, DATA_FILE);
    await services.store.exportRoom(restored.room.id, roomPath);
    await services.backups.createBackup(restored.room.id, TEST_PASSWORD, dataPath);
    const vector = {
      kind: VECTOR_KIND,
      formatVersion: VECTOR_FORMAT_VERSION,
      phase: "return",
      createdAt: new Date().toISOString(),
      sourceRuntime: loaded.vector.sourceRuntime,
      targetRuntime,
      sourceVectorSha256: loaded.vectorSha256,
      room: { id: restored.room.id, name: restored.room.name, version: restored.room.version },
      files: {
        room: ROOM_FILE,
        roomSha256: await fileSha256(roomPath),
        data: DATA_FILE,
        dataSha256: await fileSha256(dataPath)
      },
      expected: { rowCount: rows.length, rowsSha256: rowsSha256(rows) },
      testPassword: TEST_PASSWORD,
      notice: "仅用于公开迁移验收，不得承载真实业务数据。"
    };
    if (vector.files.roomSha256 !== loaded.vector.files.roomSha256) throw new Error("目标平台重新导出的房间包哈希发生变化");
    await writeJsonExclusive(path.join(output, VECTOR_FILE), vector);
    const report = {
      kind: "zhibian-migration-target-report",
      formatVersion: VECTOR_FORMAT_VERSION,
      result: "PASS",
      createdAt: new Date().toISOString(),
      sourceRuntime: vector.sourceRuntime,
      targetRuntime,
      roomSha256Stable: true,
      sourceRowsSha256: loaded.vector.expected.rowsSha256,
      returnRowsSha256: vector.expected.rowsSha256,
      returnRowCount: vector.expected.rowCount,
      networkRequired: false
    };
    await writeJsonExclusive(path.join(output, TARGET_REPORT_FILE), report);
    return { outputRoot: output, vector, report, rows };
  } catch (error) {
    await fsp.rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await services?.database.closeAll();
    await fsp.rm(workRoot, { recursive: true, force: true });
  }
}

async function verifyReturnVector({ sourceRoot, returnRoot, reportPath, returnRuntime = runtimeLabel() }) {
  validateLabel(returnRuntime, "returnRuntime");
  const source = await loadVector(sourceRoot, "source");
  const returned = await loadVector(returnRoot, "return");
  if (returned.vector.sourceVectorSha256 !== source.vectorSha256) throw new Error("回传向量不属于指定的源向量");
  if (returned.vector.files.roomSha256 !== source.vector.files.roomSha256) throw new Error("往返后的房间包哈希不一致");
  const workRoot = await fsp.mkdtemp(path.join(path.dirname(path.resolve(returnRoot)), ".zhibian-migration-return-"));
  let services;
  try {
    services = await createServices(path.join(workRoot, "data"));
    const restored = await installAndRestore(services, returned);
    if (restored.rows.length !== 2 || restored.rows[0].origin !== source.vector.sourceRuntime || restored.rows[1].origin !== returned.vector.targetRuntime) {
      throw new Error("往返记录的来源平台顺序不正确");
    }
    const report = {
      kind: "zhibian-migration-return-report",
      formatVersion: VECTOR_FORMAT_VERSION,
      result: "PASS",
      createdAt: new Date().toISOString(),
      sourceRuntime: source.vector.sourceRuntime,
      targetRuntime: returned.vector.targetRuntime,
      returnRuntime,
      room: returned.vector.room,
      roomSha256Stable: true,
      rowsSha256: returned.vector.expected.rowsSha256,
      rowCount: restored.rows.length,
      networkRequired: false
    };
    if (reportPath) {
      const resolvedReport = path.resolve(reportPath);
      await fsp.mkdir(path.dirname(resolvedReport), { recursive: true });
      await writeJsonExclusive(resolvedReport, report);
    }
    return { report, rows: restored.rows };
  } finally {
    await services?.database.closeAll();
    await fsp.rm(workRoot, { recursive: true, force: true });
  }
}

module.exports = {
  DATA_FILE,
  ROOM_FILE,
  TARGET_REPORT_FILE,
  TEST_PASSWORD,
  VECTOR_FILE,
  VECTOR_FORMAT_VERSION,
  VECTOR_KIND,
  consumeTargetVector,
  createSourceVector,
  loadVector,
  rowsSha256,
  runtimeLabel,
  verifyReturnVector
};
