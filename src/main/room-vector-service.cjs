"use strict";

// Persist in the room database so existing export, backup and uninstall semantics apply.
const MAX_VECTORS = Infinity;
const MAX_DIMENSIONS = Infinity;
function identifier(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("向量集合名称不能为空");
  return value.trim();
}
function vector(value, dimensions) {
  if (!(Array.isArray(value) || value instanceof Float32Array) || value.length !== dimensions) throw new Error("向量维度与集合不一致");
  if (!Array.from(value).every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("向量必须由有限数字组成");
  let sum = 0;
  for (const item of value) sum += item * item;
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) throw new Error("向量不能为零或溢出");
  return Float32Array.from(value, (n) => n / norm);
}
function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try { statement.bind(params); const result = []; while (statement.step()) result.push(statement.getAsObject()); return result; }
  finally { statement.free(); }
}
class RoomVectorService {
  constructor(database) { this.database = database; }
  async access(roomId, write, action) {
    return this.database.enqueue(roomId, async () => {
      const { db } = await this.database.getState(roomId);
      db.run("CREATE TABLE IF NOT EXISTS __vector_collections (name TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, embedding TEXT NOT NULL)");
      db.run("CREATE TABLE IF NOT EXISTS __vector_items (collection TEXT NOT NULL, id TEXT NOT NULL, vector BLOB NOT NULL, text TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(collection,id))");
      if (write) db.run("BEGIN");
      let result;
      try { result = await action(db); if (write) db.run("COMMIT"); }
      catch (error) { if (write) db.run("ROLLBACK"); throw error; }
      if (write) await this.database.persist(roomId);
      return result;
    });
  }
  collection(db, name, embedding) {
    identifier(name);
    const collection = rows(db, "SELECT * FROM __vector_collections WHERE name=?", [name])[0];
    if (!collection) throw new Error("向量集合不存在，请先创建");
    if (embedding !== undefined && collection.embedding !== embedding) throw new Error("向量模型标识不同，请使用原模型或重新建立集合");
    return collection;
  }
  async create(roomId, options = {}) {
    const name = identifier(options.name);
    const { dimensions, embedding } = options;
    if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error("向量维度必须是正整数");
    if (typeof embedding !== "string" || !embedding.trim()) throw new Error("必须提供向量模型标识 embedding");
    return this.access(roomId, true, (db) => {
      const existing = rows(db, "SELECT * FROM __vector_collections WHERE name=?", [name])[0];
      if (existing && (existing.dimensions !== dimensions || existing.embedding !== embedding)) throw new Error("已有集合的维度或模型标识不同");
      db.run("INSERT OR IGNORE INTO __vector_collections VALUES(?,?,?)", [name, dimensions, embedding]);
      return { name, dimensions, embedding };
    });
  }
  async list(roomId) {
    return this.access(roomId, false, (db) => rows(db, "SELECT c.*, (SELECT COUNT(*) FROM __vector_items i WHERE i.collection=c.name) AS count FROM __vector_collections c ORDER BY c.name"));
  }
  async upsert(roomId, name, items, options = {}) {
    if (!Array.isArray(items) || !items.length) throw new Error("每批至少写入一个向量");
    if (typeof options.embedding !== "string") throw new Error("写入时必须提供 embedding 模型标识");
    return this.access(roomId, true, (db) => {
      const collection = this.collection(db, name, options.embedding);
      const usedIds = new Set();
      for (const item of items) {
        if (!item || typeof item.id !== "string" || !item.id || usedIds.has(item.id)) throw new Error("向量 ID 无效或本批重复");
        usedIds.add(item.id);
        if (typeof item.text !== "string") throw new Error("向量文本块必须是字符串");
        if (item.metadata !== undefined && (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata))) throw new Error("metadata 必须是对象");
        const metadata = JSON.stringify(item.metadata || {});
        const normalized = vector(item.vector, collection.dimensions);
        const bytes = Buffer.alloc(normalized.length * 4);
        normalized.forEach((n, i) => bytes.writeFloatLE(n, i * 4));
        db.run("INSERT INTO __vector_items VALUES(?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET vector=excluded.vector,text=excluded.text,metadata=excluded.metadata", [name, item.id, bytes, item.text, metadata]);
      }
      return { upserted: items.length };
    });
  }
  async search(roomId, name, query, options = {}) {
    const { topK = 8, embedding, filter = {} } = options;
    if (!Number.isInteger(topK) || topK < 1) throw new Error("topK 必须是正整数");
    if (typeof embedding !== "string") throw new Error("检索时必须提供 embedding 模型标识");
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || Object.values(filter).some((v) => v !== null && !["string", "number", "boolean"].includes(typeof v))) throw new Error("filter 只支持元数据字段的精确匹配");
    return this.access(roomId, false, async (db) => {
      const collection = this.collection(db, name, embedding);
      const normalized = vector(query, collection.dimensions);
      const best = [];
      let cursor = 0;
      while (true) {
        const batch = rows(db, "SELECT rowid AS cursor,id,vector,text,metadata FROM __vector_items WHERE collection=? AND rowid>? ORDER BY rowid LIMIT 256", [name, cursor]);
        if (!batch.length) break;
        for (const item of batch) {
          cursor = item.cursor;
          const metadata = JSON.parse(item.metadata);
          if (!Object.entries(filter).every(([key, value]) => Object.hasOwn(metadata, key) && metadata[key] === value)) continue;
          const bytes = Buffer.from(item.vector);
          if (bytes.length !== normalized.length * 4) throw new Error("存储向量已损坏，请重建集合");
          let score = 0;
          for (let i = 0; i < normalized.length; i++) score += normalized[i] * bytes.readFloatLE(i * 4);
          best.push({ id: item.id, text: item.text, metadata, score: Math.max(-1, Math.min(1, score)) });
          best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
          if (best.length > topK) best.pop();
        }
        await new Promise(setImmediate);
      }
      return best;
    });
  }
  async remove(roomId, name, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id)) throw new Error("每批至少删除一个有效 ID");
    return this.access(roomId, true, (db) => { this.collection(db, name); let deleted = 0; for (const id of ids) { db.run("DELETE FROM __vector_items WHERE collection=? AND id=?", [name, id]); deleted += db.getRowsModified(); } return { deleted }; });
  }
  async drop(roomId, name) {
    return this.access(roomId, true, (db) => { this.collection(db, name); db.run("DELETE FROM __vector_items WHERE collection=?", [name]); db.run("DELETE FROM __vector_collections WHERE name=?", [name]); return true; });
  }
}
module.exports = { RoomVectorService, MAX_VECTORS, MAX_DIMENSIONS };
