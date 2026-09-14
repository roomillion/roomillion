"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeNetworkOrigin } = require("./manifest.cjs");

const NETWORK_SETTINGS_FORMAT = 1;
// Compatibility exports: full responses are now exposed through a chunked stream.
const MAX_REQUEST_BODY_BYTES = Infinity;
const MAX_RESPONSE_BODY_BYTES = Infinity;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_REDIRECTS = 20;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_REQUEST_HEADERS = new Set(["connection", "content-length", "cookie", "host", "origin", "proxy-authenticate", "proxy-authorization", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade"]);

function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function normalizeHeaders(input = {}) {
  if (!isPlainObject(input)) throw new Error("网络请求 headers 必须是普通对象");
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = String(rawName).trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(name)) throw new Error(`网络请求头名称无效：${rawName}`);
    if (BLOCKED_REQUEST_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-")) throw new Error(`房间不能设置请求头：${name}`);
    const value = String(rawValue ?? "");
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error(`网络请求头内容无效：${name}`);
    headers[name] = value;
  }
  return headers;
}
function binaryBody(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}
function normalizeRequest(input) {
  if (!isPlainObject(input)) throw new Error("网络请求参数必须是对象");
  const method = String(input.method || "GET").trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error(`不支持的网络请求方法：${method}`);
  const headers = normalizeHeaders(input.headers);
  let body;
  if (input.body !== undefined && input.body !== null) {
    if (typeof input.body === "string") body = input.body;
    else if (isPlainObject(input.body) || Array.isArray(input.body)) { body = JSON.stringify(input.body); if (!headers["content-type"]) headers["content-type"] = "application/json; charset=utf-8"; }
    else body = binaryBody(input.body);
    if (body === null) throw new Error("网络请求 body 只支持字符串、JSON 或二进制数据");
    if (method === "GET" || method === "HEAD") throw new Error(`${method} 请求不能包含 body`);
  }
  const timeoutMs = input.timeoutMs === undefined ? 120_000 : Math.round(Number(input.timeoutMs));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error("网络请求超时必须是正整数毫秒");
  const maxRedirects = input.maxRedirects === undefined ? MAX_REDIRECTS : Math.round(Number(input.maxRedirects));
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new Error("最大重定向次数必须是非负整数");
  return { url: String(input.url || ""), method, headers, body, timeoutMs, maxRedirects };
}
function allowedOriginsForRoom(room) {
  const requested = new Set((room?.requestedPermissions?.network || room?.permissions?.network || []).map(normalizeNetworkOrigin));
  return [...new Set((room?.grantedPermissions?.network || []).map(normalizeNetworkOrigin))].filter(origin => requested.has(origin));
}
function assertAllowedUrl(rawUrl, allowedOrigins) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("网络请求 URL 无效"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("房间网络只支持 HTTP 和 HTTPS");
  if (url.username || url.password) throw new Error("网络请求 URL 不能包含用户名或密码");
  if (!allowedOrigins.includes(url.origin)) throw new Error(`房间没有访问 ${url.origin} 的权限`);
  return url;
}
function responseHeaders(response) {
  const result = {};
  for (const [name, value] of response.headers.entries()) if (name.toLowerCase() !== "set-cookie") result[name] = value;
  return result;
}

class NetworkService {
  constructor(dataRoot, { fetchImpl = globalThis.fetch } = {}) {
    this.filePath = path.join(path.resolve(dataRoot), "network-settings.json");
    this.fetchImpl = fetchImpl;
    this.state = { formatVersion: NETWORK_SETTINGS_FORMAT, roomNetworkEnabled: false, updatedAt: null };
    this.streams = new Map();
  }
  async init() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      if (parsed?.formatVersion !== NETWORK_SETTINGS_FORMAT || typeof parsed.roomNetworkEnabled !== "boolean") throw new Error("联网设置格式无效");
      this.state = { formatVersion: NETWORK_SETTINGS_FORMAT, roomNetworkEnabled: parsed.roomNetworkEnabled, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null };
    } catch (error) { if (error.code !== "ENOENT") throw error; await this.save(); }
    return this;
  }
  async save() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fsp.writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await fsp.rename(temporaryPath, this.filePath);
  }
  getPublicState() { return Object.freeze({ roomNetworkEnabled: this.state.roomNetworkEnabled, aiApiAllowed: true, policy: "global-switch-and-room-origin-permission" }); }
  getRoomStatus(room) {
    const origins = allowedOriginsForRoom(room);
    return Object.freeze({ workbenchAllowed: this.state.roomNetworkEnabled, roomAllowed: origins.length > 0, available: this.state.roomNetworkEnabled && origins.length > 0, origins, streaming: true });
  }
  async setRoomNetworkEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new Error("联网开关必须是布尔值");
    this.state.roomNetworkEnabled = enabled; this.state.updatedAt = new Date().toISOString(); await this.save(); return this.getPublicState();
  }
  async open(room, input) {
    if (!this.state.roomNetworkEnabled) throw new Error("主工作台尚未允许房间联网");
    const allowedOrigins = allowedOriginsForRoom(room);
    if (!allowedOrigins.length) throw new Error("房间没有获得联网权限");
    const request = normalizeRequest(input);
    let url = assertAllowedUrl(request.url, allowedOrigins), method = request.method, body = request.body;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("网络请求超时")), request.timeoutMs); timeout.unref?.();
    try {
      for (let redirects = 0; redirects <= request.maxRedirects; redirects += 1) {
        let response;
        try { response = await this.fetchImpl(url, { method, headers: request.headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal: controller.signal }); }
        catch (error) { if (controller.signal.aborted) throw new Error("网络请求超时或已取消"); throw new Error(`网络请求失败：${String(error?.message || error).slice(0, 300)}`); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location"); await response.body?.cancel().catch(() => {});
          if (!location) throw new Error("网络服务返回了无目标地址的重定向");
          if (redirects === request.maxRedirects) throw new Error("网络请求重定向次数过多");
          url = assertAllowedUrl(new URL(location, url).toString(), allowedOrigins);
          if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) { method = "GET"; body = undefined; }
          continue;
        }
        const token = crypto.randomUUID();
        this.streams.set(token, { roomId: room.id, reader: response.body?.getReader() || null, pending: Buffer.alloc(0), controller, timeout });
        return Object.freeze({ token, ok: response.ok, status: response.status, statusText: String(response.statusText || ""), url: url.toString(), headers: responseHeaders(response) });
      }
      throw new Error("网络请求重定向次数过多");
    } catch (error) { clearTimeout(timeout); throw error; }
  }
  requireStream(room, token) {
    const stream = this.streams.get(String(token || ""));
    if (!stream || stream.roomId !== room.id) throw new Error("网络响应流不存在或已关闭");
    return stream;
  }
  async read(room, token, options = {}) {
    const stream = this.requireStream(room, token);
    const maxBytes = options.maxBytes === undefined ? 256 * 1024 : Number(options.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("流读取大小必须是正整数");
    while (stream.pending.length < maxBytes && stream.reader) {
      const { done, value } = await stream.reader.read();
      if (done) { stream.reader = null; break; }
      stream.pending = Buffer.concat([stream.pending, Buffer.from(value)]);
    }
    const data = stream.pending.subarray(0, maxBytes); stream.pending = stream.pending.subarray(data.length);
    const done = !stream.reader && stream.pending.length === 0;
    if (done) this.close(room, token);
    return { data: new Uint8Array(data), bytes: data.length, done };
  }
  close(room, token) {
    const stream = this.requireStream(room, token); this.streams.delete(String(token)); clearTimeout(stream.timeout); stream.reader?.cancel().catch(() => {}); stream.controller.abort(); return true;
  }
  closeRoom(roomId) {
    for (const [token, stream] of this.streams) if (stream.roomId === roomId) { this.streams.delete(token); clearTimeout(stream.timeout); stream.reader?.cancel().catch(() => {}); stream.controller.abort(); }
  }
  async request(room, input) {
    const { token, ...metadata } = await this.open(room, input); const chunks = []; let bytes = 0;
    while (true) { const chunk = await this.read(room, token); if (chunk.bytes) { const buffer = Buffer.from(chunk.data); chunks.push(buffer); bytes += buffer.length; } if (chunk.done) break; }
    return Object.freeze({ ...metadata, text: Buffer.concat(chunks, bytes).toString("utf8"), bytes });
  }
}

module.exports = { MAX_REQUEST_BODY_BYTES, MAX_RESPONSE_BODY_BYTES, NetworkService, allowedOriginsForRoom, normalizeHeaders, normalizeRequest };
