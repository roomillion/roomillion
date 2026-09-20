"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MAX_BLOB_CHUNK = 64 * 1024 ** 2;
const BLOB_ID = /^[a-f0-9]{32}$/;

function toBuffer(content) {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  throw new Error("Blob 内容必须是文本或二进制数据");
}

function safeName(value, fallback = "artifact.bin") {
  return path.basename(String(value || fallback)).replace(/[\u0000-\u001f]/g, "").slice(0, 240) || fallback;
}

class RoomBlobService {
  constructor(roomStore) {
    this.roomStore = roomStore;
    this.writes = new Map();
    this.indexLocks = new Map();
  }

  root(roomId) { return path.join(this.roomStore.getDataRoot(roomId), "blobs"); }
  indexPath(roomId) { return path.join(this.root(roomId), "index.json"); }
  blobPath(roomId, id) {
    if (!BLOB_ID.test(String(id || ""))) throw new Error("Blob ID 无效");
    return path.join(this.root(roomId), `${id}.bin`);
  }

  async loadIndex(roomId) {
    try {
      const value = JSON.parse(await fsp.readFile(this.indexPath(roomId), "utf8"));
      return value?.formatVersion === 1 && Array.isArray(value.items) ? value.items : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async saveIndex(roomId, items) {
    await fsp.mkdir(this.root(roomId), { recursive: true });
    const temporary = `${this.indexPath(roomId)}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify({ formatVersion: 1, items }, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, this.indexPath(roomId));
  }

  async mutateIndex(roomId, operation) {
    const previous = this.indexLocks.get(roomId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.indexLocks.set(roomId, tail);
    await previous;
    try {
      const items = await this.loadIndex(roomId);
      const result = await operation(items);
      await this.saveIndex(roomId, items);
      return result;
    } finally {
      release();
      if (this.indexLocks.get(roomId) === tail) this.indexLocks.delete(roomId);
    }
  }

  publicItem(item) {
    return { id: item.id, name: item.name, mimeType: item.mimeType, kind: item.kind, size: item.size, createdAt: item.createdAt, updatedAt: item.updatedAt, metadata: item.metadata || {} };
  }

  async list(roomId, options = {}) {
    const kind = options.kind ? String(options.kind) : null;
    const items = await this.loadIndex(roomId);
    return items.filter((item) => !kind || item.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt).map((item) => this.publicItem(item));
  }

  async begin(roomId, options = {}) {
    const id = crypto.randomBytes(16).toString("hex");
    const token = crypto.randomUUID();
    const name = safeName(options.name);
    const mimeType = String(options.mimeType || "application/octet-stream").slice(0, 160);
    const kind = ["blob", "artifact"].includes(options.kind) ? options.kind : "blob";
    const metadata = options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata) ? JSON.parse(JSON.stringify(options.metadata)) : {};
    const serialized = JSON.stringify(metadata);
    if (serialized.length > 32_000) throw new Error("Blob 元数据过大");
    await fsp.mkdir(this.root(roomId), { recursive: true });
    const temporaryPath = path.join(this.root(roomId), `${id}.${token}.tmp`);
    const handle = await fsp.open(temporaryPath, "wx");
    this.writes.set(token, { token, roomId, id, name, mimeType, kind, metadata, temporaryPath, handle, size: 0, createdAt: Date.now() });
    return { token, id, name, mimeType, kind, size: 0 };
  }

  requireWrite(roomId, token) {
    const item = this.writes.get(String(token || ""));
    if (!item || item.roomId !== roomId) throw new Error("Blob 写入任务不存在或已关闭");
    return item;
  }

  async write(roomId, token, content) {
    const item = this.requireWrite(roomId, token);
    const buffer = toBuffer(content);
    if (buffer.length > MAX_BLOB_CHUNK) throw new Error("Blob 每个写入块最多 64 MiB");
    if (buffer.length) { await item.handle.write(buffer); item.size += buffer.length; }
    return { id: item.id, bytes: item.size };
  }

  async finish(roomId, token) {
    const item = this.requireWrite(roomId, token);
    this.writes.delete(item.token);
    await item.handle.sync();
    await item.handle.close();
    const target = this.blobPath(roomId, item.id);
    await fsp.rename(item.temporaryPath, target);
    const now = Date.now();
    const record = { id: item.id, name: item.name, mimeType: item.mimeType, kind: item.kind, metadata: item.metadata, size: item.size, createdAt: item.createdAt, updatedAt: now };
    await this.mutateIndex(roomId, items => { items.push(record); });
    return this.publicItem(record);
  }

  async abort(roomId, token) {
    const item = this.requireWrite(roomId, token);
    this.writes.delete(item.token);
    await item.handle.close().catch(() => {});
    await fsp.rm(item.temporaryPath, { force: true });
    return true;
  }

  async put(roomId, options, content) {
    const opened = await this.begin(roomId, options);
    try { await this.write(roomId, opened.token, content); return await this.finish(roomId, opened.token); }
    catch (error) { await this.abort(roomId, opened.token).catch(() => {}); throw error; }
  }

  async read(roomId, id, options = {}) {
    const items = await this.loadIndex(roomId);
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error("Blob 不存在");
    const offset = Number(options.offset || 0);
    const length = Number(options.length || Math.min(MAX_BLOB_CHUNK, item.size - offset));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.size || !Number.isSafeInteger(length) || length < 0 || length > MAX_BLOB_CHUNK) throw new Error("Blob 读取范围无效，每次最多 64 MiB");
    const handle = await fsp.open(this.blobPath(roomId, id), "r");
    try {
      const data = Buffer.alloc(Math.min(length, item.size - offset));
      const { bytesRead } = data.length ? await handle.read(data, 0, data.length, offset) : { bytesRead: 0 };
      return { item: this.publicItem(item), data: new Uint8Array(data.subarray(0, bytesRead)), offset, nextOffset: offset + bytesRead, eof: offset + bytesRead >= item.size };
    } finally { await handle.close(); }
  }

  async getFile(roomId, id) {
    const item = (await this.loadIndex(roomId)).find((entry) => entry.id === id);
    if (!item) throw new Error("Blob 不存在");
    return { item: this.publicItem(item), path: this.blobPath(roomId, id) };
  }

  async remove(roomId, id) {
    return this.mutateIndex(roomId, async items => {
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return false;
      await fsp.rm(this.blobPath(roomId, id), { force: true });
      items.splice(index, 1);
      return true;
    });
  }

  async dispose() {
    const writes = [...this.writes.values()];
    this.writes.clear();
    await Promise.all(writes.map(async (item) => { await item.handle.close().catch(() => {}); await fsp.rm(item.temporaryPath, { force: true }).catch(() => {}); }));
  }
}

module.exports = { RoomBlobService, MAX_BLOB_CHUNK, safeName };
