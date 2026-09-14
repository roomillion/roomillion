"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const initSqlJs = require("sql.js");
const { DatabaseSync } = require("node:sqlite");
const { assertRoomId } = require("./room-store.cjs");

const FORBIDDEN_SQL = /\b(ATTACH|DETACH|LOAD_EXTENSION|VACUUM\s+INTO)\b/i;

class DiskDatabase {
  constructor(filename) {
    this.native = new DatabaseSync(filename);
    this.native.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    this.rowsModified = 0;
  }
  run(sql, params = []) {
    let result;
    try {
      result = this.native.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
    } catch (error) {
      // node:sqlite 的 Statement 只接受单条语句；迁移脚本等多语句批处理回退到 exec。
      // 有参数的语句绝不能回退，否则会悄悄丢失绑定值。
      if ((Array.isArray(params) ? params.length : 1) > 0) throw error;
      this.native.exec(sql);
      result = { changes: 0, lastInsertRowid: null };
    }
    this.rowsModified = Number(result.changes || 0);
    return { changes: this.rowsModified, lastInsertId: result.lastInsertRowid === null || result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid) };
  }
  prepare(sql) {
    const statement = this.native.prepare(sql);
    let iterator = null, current = null, params = [];
    return {
      bind(values = []) { params = Array.isArray(values) ? values : [values]; },
      step() { if (!iterator) iterator = statement.iterate(...params)[Symbol.iterator](); const next = iterator.next(); current = next.done ? null : next.value; return !next.done; },
      getAsObject() { return current ? { ...current } : {}; },
      free() { iterator = null; current = null; }
    };
  }
  getRowsModified() { return this.rowsModified; }
  close() { this.native.close(); }
}

class RoomDatabaseService {
  constructor(roomStore) {
    this.roomStore = roomStore;
    this.states = new Map();
    this.queues = new Map();
    this.sqlPromise = null;
  }

  async init() {
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const wasmBinary = await fsp.readFile(wasmPath);
    this.sqlPromise = initSqlJs({ wasmBinary });
    await this.sqlPromise;
    return this;
  }

  async getState(roomId) {
    assertRoomId(roomId);
    if (this.states.has(roomId)) return this.states.get(roomId);
    const SQL = await this.sqlPromise;
    const dataRoot = this.roomStore.getDataRoot(roomId);
    const dbPath = path.join(dataRoot, "room.db");
    await fsp.mkdir(dataRoot, { recursive: true });
    await this.recoverInterruptedReplace(dataRoot, dbPath);
    const db = new DiskDatabase(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS __room_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const state = { db, dbPath };
    this.states.set(roomId, state);
    await this.persist(roomId);
    return state;
  }

  async recoverInterruptedReplace(dataRoot, dbPath) {
    const entries = await fsp.readdir(dataRoot, { withFileTypes: true });
    const rollbackNames = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("room.db.rollback-"))
      .map((entry) => entry.name);
    const restoreNames = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("room.db.restore-"))
      .map((entry) => entry.name);
    if (!rollbackNames.length && !restoreNames.length) return false;

    const byNewest = async (names) => {
      const candidates = await Promise.all(names.map(async (name) => ({
        name,
        modified: (await fsp.stat(path.join(dataRoot, name))).mtimeMs
      })));
      return candidates.sort((left, right) => right.modified - left.modified).map((entry) => entry.name);
    };
    const rollbacks = await byNewest(rollbackNames);
    const restores = await byNewest(restoreNames);
    let databaseExists = await fsp.access(dbPath).then(() => true, () => false);
    let recovered = false;
    if (!databaseExists) {
      const candidateName = rollbacks[0] ?? restores[0];
      if (candidateName) {
        await fsp.rename(path.join(dataRoot, candidateName), dbPath);
        databaseExists = true;
        recovered = true;
      }
    }
    if (databaseExists) {
      for (const name of [...rollbacks, ...restores]) {
        const candidatePath = path.join(dataRoot, name);
        if (candidatePath !== dbPath) await fsp.rm(candidatePath, { force: true });
      }
    }
    return recovered;
  }

  async enqueue(roomId, operation) {
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.queues.set(roomId, current.catch(() => {}));
    return current;
  }

  validateSql(sql) {
    if (typeof sql !== "string" || sql.length === 0) throw new Error("SQL 长度无效");
    if (FORBIDDEN_SQL.test(sql)) throw new Error("SQL 包含房间数据库不允许的操作");
  }

  async query(roomId, sql, params = []) {
    return this.enqueue(roomId, async () => {
      this.validateSql(sql);
      const { db } = await this.getState(roomId);
      const statement = db.prepare(sql);
      try {
        statement.bind(params);
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally {
        statement.free();
      }
    });
  }

  async run(roomId, sql, params = []) {
    return this.enqueue(roomId, async () => {
      this.validateSql(sql);
      const { db } = await this.getState(roomId);
      const result = db.run(sql, params);
      const changes = result.changes;
      const lastInsertId = result.lastInsertId;
      await this.persist(roomId);
      return { changes, lastInsertId };
    });
  }

  async storageGet(roomId, key) {
    if (typeof key !== "string" || !key) throw new Error("storage key 无效");
    const rows = await this.query(roomId, "SELECT value FROM __room_kv WHERE key = ?", [key]);
    return rows.length ? JSON.parse(rows[0].value) : null;
  }

  async storageSet(roomId, key, value) {
    if (typeof key !== "string" || !key) throw new Error("storage key 无效");
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("storage value 必须可序列化为 JSON");
    await this.run(
      roomId,
      "INSERT INTO __room_kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, encoded]
    );
    return true;
  }

  async persist(roomId) {
    if (!this.states.has(roomId)) return;
  }

  async exportSnapshot(roomId) {
    assertRoomId(roomId);
    return this.enqueue(roomId, async () => {
      const state = await this.getState(roomId);
      await this.persist(roomId);
      return fsp.readFile(state.dbPath);
    });
  }

  async validateSnapshot(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("数据库快照为空");
    const SQL = await this.sqlPromise;
    let probe;
    try {
      probe = new SQL.Database(new Uint8Array(buffer));
      const result = probe.exec("PRAGMA integrity_check");
      if (result[0]?.values?.[0]?.[0] !== "ok") throw new Error("SQLite 完整性检查未通过");
    } catch (error) {
      throw new Error(`数据库快照无效：${error.message}`);
    } finally {
      probe?.close();
    }
    return true;
  }

  async replaceSnapshot(roomId, buffer, backupPath) {
    assertRoomId(roomId);
    await this.validateSnapshot(buffer);
    return this.enqueue(roomId, async () => {
      const dataRoot = this.roomStore.getDataRoot(roomId);
      const dbPath = path.join(dataRoot, "room.db");
      const token = crypto.randomBytes(8).toString("hex");
      const temporaryPath = path.join(dataRoot, `room.db.restore-${token}`);
      const rollbackPath = path.join(dataRoot, `room.db.rollback-${token}`);
      await fsp.mkdir(dataRoot, { recursive: true });

      const state = this.states.get(roomId);
      if (state) {
        await this.persist(roomId);
        state.db.close();
        this.states.delete(roomId);
      }

      let hadPrevious = false;
      try {
        await fsp.writeFile(temporaryPath, buffer, { flag: "wx" });
        try {
          await fsp.access(dbPath);
          hadPrevious = true;
        } catch {}
        if (hadPrevious) {
          await fsp.mkdir(path.dirname(backupPath), { recursive: true });
          await fsp.copyFile(dbPath, backupPath);
          await fsp.rename(dbPath, rollbackPath);
        }
        await fsp.rename(temporaryPath, dbPath);
        await fsp.rm(rollbackPath, { force: true });
        return { backupCreated: hadPrevious };
      } catch (error) {
        await fsp.rm(temporaryPath, { force: true });
        if (await fsp.access(rollbackPath).then(() => true, () => false)) {
          await fsp.rm(dbPath, { force: true });
          await fsp.rename(rollbackPath, dbPath);
        }
        throw error;
      }
    });
  }

  async closeRoom(roomId) {
    if (!this.states.has(roomId)) return;
    await this.enqueue(roomId, async () => {
      await this.persist(roomId);
      this.states.get(roomId)?.db.close();
      this.states.delete(roomId);
    });
  }

  async closeAll() {
    for (const roomId of [...this.states.keys()]) await this.closeRoom(roomId);
  }
}

module.exports = { FORBIDDEN_SQL, RoomDatabaseService };
