"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_CHUNK_BYTES = 64 * 1024 ** 2;
class BinaryFileService {
  constructor() { this.tokens = new Map(); }
  async open(roomId, filePath) {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) throw new Error("只能分块读取普通文件");
    for (const [token, item] of this.tokens) if (Date.now() - item.touched > 30 * 60 * 1000) this.tokens.delete(token);
    const token = crypto.randomUUID();
    this.tokens.set(token, { roomId, filePath, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, touched: Date.now() });
    return { token, name: path.basename(filePath), size: stats.size, maxChunkBytes: MAX_CHUNK_BYTES };
  }
  async read(roomId, token, options = {}) {
    const item = this.tokens.get(token);
    if (!item || item.roomId !== roomId || Date.now() - item.touched > 30 * 60 * 1000) throw new Error("文件令牌无效或已过期，请重新选择文件");
    const { offset = 0, length = MAX_CHUNK_BYTES } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.size || !Number.isInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) throw new Error("读取范围无效，每次最多 64 MiB");
    item.touched = Date.now();
    const file = await fsp.open(item.filePath, "r");
    try {
      const unchanged = (stat) => stat.size === item.size && stat.mtimeMs === item.mtimeMs && stat.ino === item.ino;
      if (!unchanged(await file.stat())) throw new Error("源文件已变化，请重新选择");
      const data = Buffer.alloc(Math.min(length, item.size - offset));
      let total = 0;
      while (total < data.length) { const { bytesRead } = await file.read(data, total, data.length - total, offset + total); if (!bytesRead) break; total += bytesRead; }
      if (!unchanged(await file.stat()) || total !== data.length) throw new Error("源文件已变化，请重新选择");
      return { data: new Uint8Array(data), offset, nextOffset: offset + total, eof: offset + total === item.size };
    } finally { await file.close(); }
  }
  close(roomId, token) { const item = this.tokens.get(token); if (item?.roomId !== roomId) return false; return this.tokens.delete(token); }
  closeRoom(roomId) { for (const [token, item] of this.tokens) if (item.roomId === roomId) this.tokens.delete(token); }
}
module.exports = { BinaryFileService, MAX_FILE_BYTES, MAX_CHUNK_BYTES };
