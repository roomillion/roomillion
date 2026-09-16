"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_DIRECTORY_PAGE = 1_000;
const MAX_DIRECTORY_CHUNK = 64 * 1024 ** 2;
const GRANT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function safeRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 1024 || normalized.includes("\0")) throw new Error("文件相对路径无效");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("文件相对路径越界");
  return parts.join("/");
}

function normalizeExtensions(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100) throw new Error("扩展名过滤条件无效");
  return [...new Set(input.map((item) => String(item || "").toLowerCase().replace(/^\./, "")).filter((item) => /^[a-z0-9]{1,16}$/.test(item)))];
}

function naturalCompare(a, b) {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
}

class RoomFileAccessService {
  constructor(dataRoot) {
    this.filePath = path.join(path.resolve(dataRoot), "directory-grants.json");
    this.grants = new Map();
    this.ready = this.init();
  }

  async init() {
    try {
      const stored = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      if (stored?.formatVersion !== 1 || !Array.isArray(stored.grants)) return;
      for (const item of stored.grants) {
        if (!item || typeof item.id !== "string" || typeof item.roomId !== "string" || typeof item.root !== "string") continue;
        if (!['read', 'write', 'readwrite'].includes(item.mode)) continue;
        this.grants.set(item.id, { ...item, touchedAt: Number(item.touchedAt) || Date.now() });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async persist() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify({ formatVersion: 1, grants: [...this.grants.values()] }, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, this.filePath);
  }

  async grant(roomId, directory, mode = "read") {
    await this.ready;
    if (!['read', 'write', 'readwrite'].includes(mode)) throw new Error("目录授权模式无效");
    const root = await fsp.realpath(path.resolve(directory));
    if (!(await fsp.stat(root)).isDirectory()) throw new Error("只能授权文件夹");
    const existing = [...this.grants.values()].find((item) => item.roomId === roomId && item.root === root && item.mode === mode);
    const item = existing || { id: crypto.randomUUID(), roomId, root, mode, createdAt: Date.now(), touchedAt: Date.now() };
    item.touchedAt = Date.now();
    this.grants.set(item.id, item);
    await this.persist();
    return this.publicGrant(item);
  }

  publicGrant(item) {
    return { id: item.id, name: path.basename(item.root), mode: item.mode, createdAt: item.createdAt, touchedAt: item.touchedAt };
  }

  async requireGrant(roomId, grantId, requiredMode = "read") {
    await this.ready;
    const item = this.grants.get(String(grantId || ""));
    if (!item || item.roomId !== roomId) throw new Error("目录授权不存在，请重新选择文件夹");
    if (Date.now() - item.touchedAt > GRANT_TTL_MS) throw new Error("目录授权已过期，请重新选择文件夹");
    if (requiredMode === "read" && !['read', 'readwrite'].includes(item.mode)) throw new Error("该目录没有读取授权");
    if (requiredMode === "write" && !['write', 'readwrite'].includes(item.mode)) throw new Error("该目录没有写入授权");
    let current;
    try { current = await fsp.realpath(item.root); } catch { throw new Error("授权目录已不可用，请重新选择文件夹"); }
    if (current !== item.root) throw new Error("授权目录已变化，请重新选择文件夹");
    item.touchedAt = Date.now();
    return item;
  }

  async listGrants(roomId) {
    await this.ready;
    return [...this.grants.values()].filter((item) => item.roomId === roomId).map((item) => this.publicGrant(item));
  }

  async revoke(roomId, grantId) {
    const item = await this.requireGrant(roomId, grantId, this.grants.get(String(grantId || ""))?.mode === "write" ? "write" : "read");
    this.grants.delete(item.id);
    await this.persist();
    return true;
  }

  async resolveEntry(item, relativePath, { allowMissing = false } = {}) {
    const safePath = safeRelativePath(relativePath);
    const target = path.resolve(item.root, ...safePath.split("/"));
    if (!target.startsWith(`${item.root}${path.sep}`)) throw new Error("文件相对路径越界");
    const parts = safePath.split("/");
    let cursor = item.root;
    for (let index = 0; index < parts.length; index += 1) {
      cursor = path.join(cursor, parts[index]);
      try {
        const stat = await fsp.lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error("目录授权不允许通过链接访问文件");
      } catch (error) {
        if (error.code === "ENOENT" && allowMissing) break;
        throw error;
      }
    }
    return { safePath, target };
  }

  async list(roomId, grantId, options = {}) {
    const item = await this.requireGrant(roomId, grantId, "read");
    const extensions = normalizeExtensions(options.extensions);
    const recursive = options.recursive !== false;
    const cursor = Number(options.cursor || 0);
    const limit = Number(options.limit || 200);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_PAGE) throw new Error("目录分页参数无效");
    const entries = [];
    const walk = async (directory, prefix = "") => {
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new Error("目录文件超过 100000 个，请缩小选择范围");
        if (entry.isSymbolicLink()) continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (recursive) await walk(target, relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).slice(1).toLowerCase();
        if (extensions.length && !extensions.includes(extension)) continue;
        const stat = await fsp.stat(target);
        entries.push({ relativePath: relativePath.replace(/\\/g, "/"), name: entry.name, extension, size: stat.size, modifiedAt: stat.mtimeMs });
      }
    };
    await walk(item.root);
    entries.sort((a, b) => naturalCompare(a.relativePath, b.relativePath));
    const page = entries.slice(cursor, cursor + limit);
    await this.persist();
    return { grant: this.publicGrant(item), entries: page, cursor, nextCursor: cursor + page.length < entries.length ? cursor + page.length : null, total: entries.length };
  }

  async getFile(roomId, grantId, relativePath) {
    const item = await this.requireGrant(roomId, grantId, "read");
    const { safePath, target } = await this.resolveEntry(item, relativePath);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("只能读取普通文件");
    return { relativePath: safePath, path: target, size: stat.size, modifiedAt: stat.mtimeMs };
  }

  async read(roomId, grantId, relativePath, options = {}) {
    const item = await this.requireGrant(roomId, grantId, "read");
    const { safePath, target } = await this.resolveEntry(item, relativePath);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("只能读取普通文件");
    const offset = Number(options.offset || 0);
    const length = Number(options.length || Math.min(MAX_DIRECTORY_CHUNK, stat.size - offset));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size || !Number.isSafeInteger(length) || length < 0 || length > MAX_DIRECTORY_CHUNK) throw new Error("目录文件读取范围无效，每次最多 64 MiB");
    const handle = await fsp.open(target, "r");
    try {
      const data = Buffer.alloc(Math.min(length, stat.size - offset));
      const { bytesRead } = data.length ? await handle.read(data, 0, data.length, offset) : { bytesRead: 0 };
      return { relativePath: safePath, data: new Uint8Array(data.subarray(0, bytesRead)), offset, nextOffset: offset + bytesRead, eof: offset + bytesRead >= stat.size, size: stat.size };
    } finally { await handle.close(); }
  }

  async copyInto(roomId, grantId, relativePath, sourcePath) {
    const item = await this.requireGrant(roomId, grantId, "write");
    const { safePath, target } = await this.resolveEntry(item, relativePath, { allowMissing: true });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.roomillion-${crypto.randomUUID()}.tmp`;
    await fsp.copyFile(sourcePath, temporary);
    await fsp.rename(temporary, target);
    const stat = await fsp.stat(target);
    await this.persist();
    return { relativePath: safePath, bytes: stat.size, modifiedAt: stat.mtimeMs };
  }

  async write(roomId, grantId, relativePath, content) {
    const item = await this.requireGrant(roomId, grantId, "write");
    const { safePath, target } = await this.resolveEntry(item, relativePath, { allowMissing: true });
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : ArrayBuffer.isView(content) ? Buffer.from(content.buffer, content.byteOffset, content.byteLength) : content instanceof ArrayBuffer ? Buffer.from(content) : null;
    if (!buffer) throw new Error("目录写入内容必须是文本或二进制数据");
    if (buffer.length > MAX_DIRECTORY_CHUNK) throw new Error("单次目录写入最多 64 MiB；大文件请分块生成制品后导出");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.roomillion-${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, buffer);
    await fsp.rename(temporary, target);
    const stat = await fsp.stat(target);
    await this.persist();
    return { relativePath: safePath, bytes: stat.size, modifiedAt: stat.mtimeMs };
  }
}

module.exports = { RoomFileAccessService, MAX_DIRECTORY_CHUNK, MAX_DIRECTORY_ENTRIES, safeRelativePath };
