"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { normalizeNetworkOrigin } = require("./manifest.cjs");

const CREDENTIAL_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,80}$/;
const BLOCKED_HEADERS = new Set(["connection", "content-length", "cookie", "host", "origin", "proxy-authorization", "set-cookie", "transfer-encoding"]);
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function normalizeAlias(value) { const alias = String(value || "").trim(); if (!CREDENTIAL_ALIAS_PATTERN.test(alias)) throw new Error(`凭据别名无效：${alias || "(空)"}`); return alias; }
function roomCredentialAliases(room) {
  const requested = new Set(room?.requestedPermissions?.credentials || room?.permissions?.credentials || []);
  return new Set((room?.grantedPermissions?.credentials || []).filter((alias) => requested.has(alias)));
}

class RoomCredentialService {
  constructor(dataRoot, { secureStorage = null } = {}) {
    this.root = path.join(path.resolve(dataRoot), "room-credentials");
    this.indexPath = path.join(this.root, "index.json");
    this.secretRoot = path.join(this.root, "secrets");
    this.secureStorage = secureStorage;
    this.items = new Map();
    this.values = new Map();
  }
  encryptionAvailable() { try { return Boolean(this.secureStorage?.isEncryptionAvailable?.()); } catch { return false; } }
  secretPath(alias) { return path.join(this.secretRoot, `${normalizeAlias(alias)}.bin`); }
  async init() {
    try {
      const stored = JSON.parse(await fsp.readFile(this.indexPath, "utf8"));
      if (stored?.formatVersion !== 1 || !Array.isArray(stored.items)) throw new Error("房间凭据索引格式无效");
      for (const raw of stored.items) {
        try {
          const item = this.normalizeMetadata(raw);
          this.items.set(item.alias, item);
          if (item.persistent && this.encryptionAvailable()) {
            const encrypted = await fsp.readFile(this.secretPath(item.alias));
            const value = this.secureStorage.decryptString(encrypted);
            if (value) this.values.set(item.alias, value);
          }
        } catch {}
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; await this.saveIndex(); }
    return this;
  }
  normalizeMetadata(input) {
    const alias = normalizeAlias(input?.alias);
    const origin = normalizeNetworkOrigin(input?.origin);
    const headerName = String(input?.headerName || "authorization").trim().toLowerCase();
    if (!HEADER_NAME_PATTERN.test(headerName) || BLOCKED_HEADERS.has(headerName) || headerName.startsWith("sec-") || headerName.startsWith("proxy-")) throw new Error("凭据请求头名称无效");
    const prefix = String(input?.prefix ?? "Bearer ");
    if (prefix.length > 100 || /[^\t\x20-\x7e]/.test(prefix)) throw new Error("凭据前缀无效");
    return { alias, label: String(input?.label || alias).trim().slice(0, 100), origin, headerName, prefix, persistent: input?.persistent === true, updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : new Date().toISOString() };
  }
  publicItem(item) { return Object.freeze({ ...clone(item), available: this.values.has(item.alias), secureStorageAvailable: this.encryptionAvailable() }); }
  list() { return [...this.items.values()].map((item) => this.publicItem(item)); }
  listForRoom(room) { const allowed = roomCredentialAliases(room); return [...allowed].map((alias) => this.items.get(alias)).filter(Boolean).map((item) => this.publicItem(item)); }
  async saveIndex() {
    await fsp.mkdir(this.root, { recursive: true });
    const temporary = `${this.indexPath}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify({ formatVersion: 1, items: [...this.items.values()] }, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, this.indexPath);
  }
  async set(input) {
    const value = String(input?.value || "");
    if (!value || value.length > 32_768) throw new Error("凭据内容必须是 1–32768 个字符");
    if (/[\r\n\0]/.test(value)) throw new Error("凭据内容不能包含换行或空字符");
    const persistent = input?.remember === true;
    if (persistent && !this.encryptionAvailable()) throw new Error("系统安全存储不可用，不能持久保存凭据");
    const item = this.normalizeMetadata({ ...input, persistent, updatedAt: new Date().toISOString() });
    this.items.set(item.alias, item);
    this.values.set(item.alias, value);
    if (persistent) {
      await fsp.mkdir(this.secretRoot, { recursive: true });
      const target = this.secretPath(item.alias), temporary = `${target}.tmp`;
      await fsp.writeFile(temporary, this.secureStorage.encryptString(value));
      await fsp.rename(temporary, target);
    } else await fsp.rm(this.secretPath(item.alias), { force: true });
    await this.saveIndex();
    return this.publicItem(item);
  }
  async remove(rawAlias) {
    const alias = normalizeAlias(rawAlias);
    const existed = this.items.delete(alias);
    this.values.delete(alias);
    await fsp.rm(this.secretPath(alias), { force: true });
    if (existed) await this.saveIndex();
    return existed;
  }
  resolveForRoom(room, rawAlias, rawUrl) {
    const alias = normalizeAlias(rawAlias);
    if (!roomCredentialAliases(room).has(alias)) throw new Error(`房间没有凭据权限：${alias}`);
    const item = this.items.get(alias), value = this.values.get(alias);
    if (!item || !value) throw new Error(`凭据 ${alias} 尚未配置或本次会话不可用`);
    const origin = new URL(String(rawUrl)).origin;
    if (origin !== item.origin) throw new Error(`凭据 ${alias} 只能用于 ${item.origin}`);
    return { name: item.headerName, value: `${item.prefix}${value}` };
  }
}

module.exports = { CREDENTIAL_ALIAS_PATTERN, RoomCredentialService, normalizeAlias, roomCredentialAliases };