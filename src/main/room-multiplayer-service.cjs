"use strict";

const tls = require("node:tls");
const net = require("node:net");
const crypto = require("node:crypto");
const os = require("node:os");
const { createLanCertificate } = require("./room-lan-certificate.cjs");

// Native, room-scoped transport. Neither room pages nor the Internet request broker
// receive a raw socket. Desktop and Android share the same pinned TLS protocol.
const PROTOCOL = "roomillion-lan-1";
const MAX_FRAME = 96 * 1024;
const MAX_MESSAGE = 64 * 1024;
const MAX_QUEUE = 1024 * 1024;
function localAddress(value) {
  if (typeof value !== "string" || net.isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254);
}
function parseInvitation(raw, room) {
  if (typeof raw !== "string" || raw.length > 4096 || !/^roomillion-lan:[A-Za-z0-9_-]+$/.test(raw)) throw new Error("加入信息无效，请粘贴主机分享的完整加入信息");
  let value;
  try { value = JSON.parse(Buffer.from(raw.slice(15), "base64url").toString("utf8")); } catch { throw new Error("加入信息无效"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("加入信息无效");
  if (value.protocol !== PROTOCOL || !localAddress(value.host) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint || "") || !/^[a-f0-9]{64}$/.test(value.token || "") || !/^[a-f0-9]{32}$/.test(value.sessionId || "")) throw new Error("加入信息的地址或凭证无效");
  if (value.roomId !== room.id || value.roomVersion !== room.version) throw new Error("主机与本机需要安装相同 ID 和版本的房间");
  return value;
}
function text(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 40 || /[\x00-\x1f]/.test(value)) throw new Error("玩家名称无效");
  return value.trim();
}
class RoomMultiplayerService {
  constructor({ networkInterfaces = os.networkInterfaces } = {}) { this.sessions = new Map(); this.networkInterfaces = networkInterfaces; }
  getStatus(owner) {
    const client = this.sessions.get(owner);
    return client ? client.status() : { supported: true, canHost: true, transport: "lan", role: null, connected: false, peerId: null };
  }
  async create(owner, room, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("联机参数无效");
    if (options.transport !== undefined && options.transport !== "lan") throw new Error("当前版本支持同一局域网联机");
    const name = text(options.name, "联机游戏"), maxPlayers = options.maxPlayers ?? 16;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 32) throw new Error("总人数必须在 2 至 32 之间");
    if (this.sessions.has(owner)) throw new Error("请先离开当前游戏再创建");
    const addresses = [...new Set(Object.values(this.networkInterfaces()).flat().filter(entry => entry && !entry.internal && localAddress(entry.address)).map(entry => entry.address))];
    if (!addresses.length) throw new Error("请先连接可互通的局域网，再创建游戏");
    const host = new LanHost(room, name, maxPlayers);
    this.sessions.set(owner, host);
    try { await host.start(addresses); return host.status(); }
    catch (error) { host.close(); if (this.sessions.get(owner) === host) this.sessions.delete(owner); throw error; }
  }
  async join(owner, room, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("联机参数无效");
    const invitation = parseInvitation(options.invitation, room);
    const name = text(options.name, "电脑玩家");
    if (this.sessions.has(owner)) throw new Error("请先离开当前游戏再加入");
    const client = new LanClient(invitation, name);
    this.sessions.set(owner, client);
    try { await client.connect(); return client.status(); }
    catch (error) { client.close(); if (this.sessions.get(owner) === client) this.sessions.delete(owner); throw error; }
  }
  require(owner) { const client = this.sessions.get(owner); if (!client) throw new Error("尚未加入游戏或创建游戏"); return client; }
  send(owner, data, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("联机发送参数无效");
    const session = this.require(owner);
    if (session instanceof LanHost) return session.send(data, options);
    if (options.to !== undefined && options.to !== "host") throw new Error("玩家只能向主机提交消息");
    return session.send(data);
  }
  read(owner, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("联机读取参数无效");
    const timeoutMs = options?.timeoutMs ?? 15000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 15000) throw new Error("等待读取时间必须在 0 至 15000 毫秒之间");
    return this.require(owner).read(timeoutMs);
  }
  leave(owner) { const client = this.sessions.get(owner); this.sessions.delete(owner); client?.close(); return true; }
  closeRoom(roomId) { for (const [owner, client] of this.sessions) if (client.invitation.roomId === roomId) this.leave(owner); }
  closeUnauthorized(roomId, grants) {
    for (const [owner, session] of this.sessions) if (session.invitation.roomId === roomId && !grants.includes(session instanceof LanHost ? "host" : "join")) this.leave(owner);
  }
  dispose() { for (const owner of this.sessions.keys()) this.leave(owner); }
}
class LanEventQueue {
  constructor() { this.connected = false; this.closed = false; this.queue = []; this.queueBytes = 0; this.waiter = null; }
  event(value) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (this.queueBytes + size > MAX_QUEUE) { this.close(); return false; }
    this.queue.push(value); this.queueBytes += size; this.flush(); return true;
  }
  flush() { if (this.waiter && (this.queue.length || this.closed)) { const waiter = this.waiter; this.waiter = null; clearTimeout(waiter.timer); const events = this.queue.splice(0); this.queueBytes = 0; waiter.resolve({ events, ...this.status() }); } }
  read(timeoutMs) {
    if (this.closed && !this.queue.length) throw new Error("游戏连接已关闭，请重新加入");
    if (this.waiter) throw new Error("同一个游戏只允许一个消息读取循环");
    return new Promise(resolve => { this.waiter = { resolve, timer: setTimeout(() => { const waiter = this.waiter; this.waiter = null; waiter?.resolve({ events: [], ...this.status() }); }, timeoutMs) }; this.flush(); });
  }
}
class LanClient extends LanEventQueue {
  constructor(invitation, name) {
    super(); this.invitation = invitation; this.name = name; this.peerId = null; this.resumeToken = null; this.seen = new Set();
    this.pending = new Map(); this.retry = null; this.socket = null; this.pendingBytes = 0;
  }
  status() { return { supported: true, canHost: true, transport: "lan", role: "client", connected: this.connected, peerId: this.peerId, sessionId: this.invitation.sessionId }; }
  wire(value) {
    if (!this.socket || this.socket.destroyed || this.socket.writableLength > MAX_QUEUE) throw new Error("连接暂不可用，请等待重新连接");
    this.socket.write(JSON.stringify(value) + "\n");
  }
  send(data) {
    const serialized = JSON.stringify(data);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_MESSAGE) throw new Error("联机消息必须是 JSON，且不超过 64 KiB");
    if (!this.connected) throw new Error("连接已断开，请等待重新连接");
    if (this.pending.size >= 128) throw new Error("等待主机接收的消息过多");
    const id = crypto.randomBytes(16).toString("hex");
    const message = { op: "message", id, data: JSON.parse(serialized) };
    const size = Buffer.byteLength(JSON.stringify(message));
    if (this.pendingBytes + size > MAX_QUEUE) throw new Error("等待主机接收的消息过多");
    this.pendingBytes += size;
    this.pending.set(id, message);
    try { this.wire(message); } catch { this.socket?.destroy(); }
    return { id };
  }
  connect() {
    if (this.closed) return Promise.reject(new Error("游戏已离开"));
    return new Promise((resolve, reject) => {
      let welcomed = false, settled = false, buffer = Buffer.alloc(0);
      const socket = tls.connect({ host: this.invitation.host, port: this.invitation.port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
      this.socket = socket;
      const deadline = setTimeout(() => socket.destroy(new Error("连接主机超时，请检查热点和加入信息")), 8000);
      const fail = error => { if (!settled) { settled = true; reject(error); } socket.destroy(); };
      socket.on("secureConnect", () => {
        // A self-signed host certificate is trusted ONLY by the out-of-band invitation.
        const certificate = socket.getPeerCertificate();
        const fingerprint = certificate.raw && crypto.createHash("sha256").update(certificate.raw).digest("hex");
        if (fingerprint !== this.invitation.fingerprint) return fail(new Error("主机证书与加入信息不一致"));
        this.wire({ op: "hello", protocol: PROTOCOL, sessionId: this.invitation.sessionId, token: this.invitation.token,
          roomId: this.invitation.roomId, roomVersion: this.invitation.roomVersion, name: this.name, peerId: this.peerId, resumeToken: this.resumeToken });
      });
      socket.on("data", chunk => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          let end;
          while ((end = buffer.indexOf(10)) >= 0) {
            if (end > MAX_FRAME) throw new Error("主机消息过大");
            const message = JSON.parse(buffer.subarray(0, end).toString("utf8")); buffer = buffer.subarray(end + 1);
            if (message.op === "error") throw new Error(String(message.error || "主机拒绝连接").slice(0, 300));
            if (!welcomed) {
              if (message.op !== "welcome" || !/^[a-f0-9]{32}$/.test(message.peerId || "") || !/^[a-f0-9]{64}$/.test(message.resumeToken || "")) throw new Error("主机握手无效");
              this.peerId = message.peerId; this.resumeToken = message.resumeToken; welcomed = true; this.connected = true;
              clearTimeout(deadline); socket.setTimeout(45000, () => socket.destroy());
              this.event({ type: "connected", peerId: this.peerId });
              for (const pending of this.pending.values()) this.wire(pending);
              settled = true; resolve();
            } else if (message.op === "ping") this.wire({ op: "pong" });
            else if (message.op === "ack") {
              const pending = this.pending.get(message.id);
              if (pending) { this.pendingBytes -= Buffer.byteLength(JSON.stringify(pending)); this.pending.delete(message.id); }
            }
            else if (message.op === "message") {
              if (!/^[a-f0-9]{32}$/.test(message.id || "") || message.from !== "host" || !Object.hasOwn(message, "data") || Buffer.byteLength(JSON.stringify(message.data) ?? "") > MAX_MESSAGE) throw new Error("主机消息无效");
              if (!this.seen.has(message.id)) {
                if (!this.event({ type: "message", id: message.id, from: "host", data: message.data })) return;
                this.seen.add(message.id); if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
              }
              this.wire({ op: "ack", id: message.id });
            } else throw new Error("未知联机消息");
          }
          if (buffer.length > MAX_FRAME) throw new Error("主机消息过大");
        } catch (error) { fail(error); }
      });
      socket.on("error", error => { if (!settled) { settled = true; reject(error); } });
      socket.on("close", () => {
        clearTimeout(deadline); if (!settled) { settled = true; reject(new Error("主机连接已关闭")); }
        this.connected = false;
        if (welcomed && !this.closed) this.event({ type: "disconnected" });
        if (this.peerId && !this.closed) this.retry = setTimeout(() => { this.retry = null; this.connect().catch(() => {}); }, 2000);
      });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.connected && this.socket && !this.socket.destroyed) {
      try { this.socket.end(JSON.stringify({ op: "leave" }) + "\n"); } catch { this.socket.destroy(); }
      const socket = this.socket; setTimeout(() => socket.destroy(), 200).unref();
    } else this.socket?.destroy();
    this.connected = false; clearTimeout(this.retry); this.pending.clear(); this.pendingBytes = 0; this.flush();
  }
}
class LanHost extends LanEventQueue {
  constructor(room, name, maxPlayers) {
    super(); this.name = name; this.maxPlayers = maxPlayers; this.peers = new Map(); this.sockets = new Set(); this.server = null; this.heartbeat = null; this.invitations = [];
    this.invitation = { protocol: PROTOCOL, roomId: room.id, roomVersion: room.version,
      sessionId: crypto.randomBytes(16).toString("hex"), token: crypto.randomBytes(32).toString("hex") };
  }
  status() {
    return { supported: true, canHost: true, transport: "lan", role: "host", connected: this.connected && !this.closed,
      peerId: "host", sessionId: this.invitation.sessionId, invitations: this.invitations.map(entry => ({ ...entry })),
      peers: [...this.peers.values()].map(peer => ({ peerId: peer.id, name: peer.name, connected: Boolean(peer.socket && !peer.socket.destroyed) })) };
  }
  async start(addresses) {
    const certificate = await createLanCertificate();
    if (this.closed) throw new Error("游戏已离开");
    const server = tls.createServer({ key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2", handshakeTimeout: 8000 }, socket => this.accept(socket));
    this.server = server;
    server.maxConnections = this.maxPlayers + 40;
    // Track pre-handshake TCP connections too, so closing the room cannot leave
    // unauthenticated sockets running. Public-source addresses are not LAN players.
    server.on("connection", socket => {
      socket.on("error", () => {});
      if (this.closed || !localAddress(socket.remoteAddress?.replace(/^::ffff:/, ""))) { socket.destroy(); return; }
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("tlsClientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      const cleanup = () => { server.removeListener("error", onError); server.removeListener("listening", onListening); server.removeListener("close", onClose); };
      const onError = error => { cleanup(); reject(new Error(`无法创建局域网游戏：${error.message}`)); };
      const onListening = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("游戏已离开")); };
      server.once("error", onError); server.once("listening", onListening); server.once("close", onClose); server.listen(0, "0.0.0.0");
    });
    server.on("error", () => this.close());
    if (this.closed) { server.close(); throw new Error("游戏已离开"); }
    const port = server.address().port;
    this.invitation.fingerprint = certificate.fingerprint;
    this.invitations = addresses.map(host => ({ host, invitation: "roomillion-lan:" + Buffer.from(JSON.stringify({ ...this.invitation, host, port })).toString("base64url") }));
    this.connected = true;
    this.heartbeat = setInterval(() => {
      for (const peer of this.peers.values()) if (peer.socket) this.tryWrite(peer.socket, { op: "ping" });
    }, 10000); this.heartbeat.unref();
    this.event({ type: "created", peerId: "host" });
  }
  write(socket, message) {
    if (socket.destroyed || socket.writableLength > MAX_QUEUE) throw new Error("玩家连接暂不可用");
    socket.write(JSON.stringify(message) + "\n");
  }
  tryWrite(socket, message) { try { this.write(socket, message); } catch { socket.destroy(); } }
  accept(socket) {
    let buffer = Buffer.alloc(0), peer = null, failed = false;
    socket.setTimeout(8000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      try {
        if (this.closed || failed) return socket.destroy();
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          if (end > MAX_FRAME) throw new Error("玩家消息过大");
          const message = JSON.parse(buffer.subarray(0, end).toString("utf8")); buffer = buffer.subarray(end + 1);
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("玩家消息无效");
          if (!peer) {
            if (message.op !== "hello" || message.protocol !== PROTOCOL || message.sessionId !== this.invitation.sessionId || !sameSecret(message.token, this.invitation.token)) throw new Error("加入凭证无效");
            if (message.roomId !== this.invitation.roomId || message.roomVersion !== this.invitation.roomVersion) throw new Error("房间版本不一致");
            const playerName = text(message.name, "玩家");
            const existing = this.peers.get(message.peerId);
            if (existing) {
              if (!sameSecret(message.resumeToken, existing.resumeToken)) throw new Error("重连凭证无效");
              existing.socket?.destroy(); peer = existing;
            } else {
              if (message.peerId != null) throw new Error("原游戏已结束，请重新加入");
              if (this.peers.size >= this.maxPlayers - 1) throw new Error("游戏人数已满");
              peer = { id: crypto.randomBytes(16).toString("hex"), resumeToken: crypto.randomBytes(32).toString("hex"), name: playerName,
                socket: null, pending: new Map(), pendingBytes: 0, seen: new Set() };
              this.peers.set(peer.id, peer);
            }
            peer.socket = socket; peer.name = playerName;
            this.write(socket, { op: "welcome", peerId: peer.id, resumeToken: peer.resumeToken });
            socket.setTimeout(45000);
            for (const pending of peer.pending.values()) this.write(socket, pending);
            if (!this.event({ type: existing ? "reconnected" : "joined", peerId: peer.id, name: playerName })) return;
          } else {
            if (peer.socket !== socket || this.peers.get(peer.id) !== peer) return socket.destroy();
            if (message.op === "pong") continue;
            if (message.op === "ack") {
              const pending = peer.pending.get(message.id);
              if (pending) { peer.pendingBytes -= Buffer.byteLength(JSON.stringify(pending)); peer.pending.delete(message.id); }
            } else if (message.op === "message") {
              if (!/^[a-f0-9]{32}$/.test(message.id || "") || !Object.hasOwn(message, "data")) throw new Error("玩家消息无效");
              jsonData(message.data);
              if (!peer.seen.has(message.id)) {
                if (!this.event({ type: "message", id: message.id, from: peer.id, data: message.data })) return;
                peer.seen.add(message.id); if (peer.seen.size > 512) peer.seen.delete(peer.seen.values().next().value);
              }
              this.write(socket, { op: "ack", id: message.id });
            } else if (message.op === "leave") {
              this.peers.delete(peer.id); peer.socket = null;
              this.event({ type: "left", peerId: peer.id, name: peer.name }); socket.end();
              const timer = setTimeout(() => socket.destroy(), 200); timer.unref(); return;
            } else throw new Error("未知联机消息");
          }
        }
        if (buffer.length > MAX_FRAME) throw new Error("玩家消息过大");
      } catch (error) {
        failed = true; socket.pause();
        try { socket.end(JSON.stringify({ op: "error", error: String(error.message).slice(0, 300) }) + "\n"); } catch { socket.destroy(); }
        const timer = setTimeout(() => socket.destroy(), 200); timer.unref();
      }
    });
    socket.on("close", () => {
      if (peer?.socket === socket) {
        peer.socket = null;
        if (!this.closed && this.peers.get(peer.id) === peer) this.event({ type: "disconnected", peerId: peer.id, name: peer.name });
      }
    });
  }
  send(data, options) {
    if (this.closed || !this.connected) throw new Error("游戏已关闭，请重新创建");
    const value = jsonData(data), to = options.to ?? "all";
    if (typeof to !== "string") throw new Error("消息接收者无效");
    const destinations = to === "all" ? [...this.peers.values()] : [this.peers.get(to)];
    if (destinations.some(peer => !peer)) throw new Error("玩家不存在");
    const id = crypto.randomBytes(16).toString("hex"), message = { op: "message", id, from: "host", data: value }, size = Buffer.byteLength(JSON.stringify(message));
    if (destinations.some(peer => peer.pending.size >= 128 || peer.pendingBytes + size > MAX_QUEUE)) throw new Error("等待玩家接收的消息过多");
    for (const peer of destinations) {
      peer.pending.set(id, message); peer.pendingBytes += size;
      if (peer.socket) this.tryWrite(peer.socket, message);
    }
    return { id };
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.connected = false; clearInterval(this.heartbeat);
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    for (const peer of this.peers.values()) peer.socket?.destroy();
    this.sockets.clear(); this.peers.clear(); this.invitations = []; this.flush();
  }
}
function jsonData(data) {
  let serialized;
  try { serialized = JSON.stringify(data); } catch { throw new Error("联机消息必须是 JSON，且不超过 64 KiB"); }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_MESSAGE) throw new Error("联机消息必须是 JSON，且不超过 64 KiB");
  return JSON.parse(serialized);
}
function sameSecret(value, expected) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
module.exports = { RoomMultiplayerService, parseInvitation, localAddress, PROTOCOL };
