"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { RoomMultiplayerService, parseInvitation, PROTOCOL } = require("../src/main/room-multiplayer-service.cjs");
const { createLanCertificate } = require("../src/main/room-lan-certificate.cjs");

const room = { id: "cn.roomillion.lan-test", version: "1.0.0" };
const interfaces = () => ({ test: [{ address: "127.0.0.1", internal: false }], ignored: [{ address: "8.8.8.8", internal: false }, { address: "10.0.0.2", internal: true }] });
function service(t, options = {}) { const value = new RoomMultiplayerService({ networkInterfaces: interfaces, ...options }); t.after(() => value.dispose()); return value; }
async function event(value, owner, type) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const batch = await value.read(owner, { timeoutMs: 1000 });
    const found = batch.events.find(item => item.type === type); if (found) return found;
  }
  throw new Error(`等待事件失败：${type}`);
}
const drain = (value, owner) => value.read(owner, { timeoutMs: 0 });

test("desktop host uses a fresh self-signed certificate with a matching invitation pin", async () => {
  const a = await createLanCertificate(), b = await createLanCertificate();
  const cert = new crypto.X509Certificate(a.cert);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(crypto.createHash("sha256").update(cert.raw).digest("hex"), a.fingerprint);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.ok(Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now());
});

test("desktop creation validates options, needs a LAN address and cleans up cancelled creation", async t => {
  const value = service(t);
  for (const options of [null, [], { name: "" }, { transport: "internet" }, { maxPlayers: 1 }, { maxPlayers: 33 }, { maxPlayers: 2.5 }]) await assert.rejects(value.create("host", room, options));
  assert.equal(value.getStatus("host").role, null);
  const offline = service(t, { networkInterfaces: () => ({ lo: [{ address: "127.0.0.1", internal: true }] }) });
  await assert.rejects(offline.create("host", room), /局域网/);
  const pending = value.create("host", room);
  await assert.rejects(value.create("host", room), /先离开/);
  value.leave("host"); await assert.rejects(pending, /已离开/);
  const created = await value.create("host", room, { name: "局域网测试", maxPlayers: 3 });
  assert.equal(created.role, "host"); assert.equal(created.canHost, true);
  assert.equal(created.invitations.length, 1);
  assert.equal(parseInvitation(created.invitations[0].invitation, room).protocol, PROTOCOL);
});

test("desktop host routes public and private messages and enforces seats and room ownership", async t => {
  const host = service(t), players = service(t);
  const created = await host.create("h", room, { maxPlayers: 3 });
  const invitation = created.invitations[0].invitation;
  const a = await players.join("a", room, { invitation, name: "甲" });
  const b = await players.join("b", room, { invitation, name: "乙" });
  await drain(host, "h"); await drain(players, "a"); await drain(players, "b");
  await assert.rejects(players.join("c", room, { invitation }), /人数已满/);
  await assert.rejects(players.join("c", { ...room, version: "2.0.0" }, { invitation }), /相同 ID/);
  const privateMessage = host.send("h", { role: "seer" }, { to: a.peerId });
  assert.deepEqual(await event(players, "a", "message"), { type: "message", id: privateMessage.id, from: "host", data: { role: "seer" } });
  assert.equal((await players.read("b", { timeoutMs: 60 })).events.length, 0);
  host.send("h", { phase: "day" });
  assert.equal((await event(players, "a", "message")).data.phase, "day");
  assert.equal((await event(players, "b", "message")).data.phase, "day");
  players.send("a", { vote: b.peerId, from: "fake" });
  const received = await event(host, "h", "message");
  assert.equal(received.from, a.peerId); assert.equal(received.data.vote, b.peerId);
  assert.throws(() => host.send("h", {}, { to: "not-a-peer" }), /玩家不存在/);
  assert.throws(() => host.send("h", "x".repeat(65537)), /64 KiB/);
  assert.throws(() => host.send("other", {}), /尚未加入/);
  players.leave("b"); assert.equal((await event(host, "h", "left")).peerId, b.peerId);
  const c = await players.join("c", room, { invitation }); assert.notEqual(c.peerId, b.peerId);
  assert.equal(host.getStatus("h").peers.length, 2);
});

test("desktop host rejects bad handshakes, keeps reconnect identity and replays only the pending private message", async t => {
  const host = service(t), players = service(t);
  const created = await host.create("h", room, { maxPlayers: 3 }), invitation = created.invitations[0].invitation;
  const raw = parseInvitation(invitation, room), encode = value => "roomillion-lan:" + Buffer.from(JSON.stringify(value)).toString("base64url");
  await assert.rejects(players.join("bad", room, { invitation: encode({ ...raw, token: "0".repeat(64) }) }), /凭证/);
  await assert.rejects(players.join("bad", room, { invitation: encode({ ...raw, fingerprint: "0".repeat(64) }) }), /证书/);
  assert.equal(host.getStatus("h").peers.length, 0);
  const a = await players.join("a", room, { invitation }); await drain(host, "h"); await drain(players, "a");
  players.sessions.get("a").socket.destroy();
  assert.equal((await event(host, "h", "disconnected")).peerId, a.peerId);
  const message = host.send("h", { role: "wolf" }, { to: a.peerId });
  assert.equal((await event(host, "h", "reconnected")).peerId, a.peerId);
  const replay = await event(players, "a", "message");
  assert.equal(replay.id, message.id); assert.equal(replay.data.role, "wolf");
  assert.equal(players.getStatus("a").peerId, a.peerId);
  assert.equal((await players.read("a", { timeoutMs: 100 })).events.length, 0);
});

test("host close resolves waiting reads, closes pre-handshake sockets and permission changes respect host versus join", async t => {
  const host = service(t), players = service(t);
  const created = await host.create("h", room), raw = parseInvitation(created.invitations[0].invitation, room);
  const a = await players.join("a", room, { invitation: created.invitations[0].invitation });
  assert.ok(a.connected); await drain(host, "h"); await drain(players, "a");
  host.closeUnauthorized(room.id, ["host"]); assert.equal(host.getStatus("h").connected, true);
  players.closeUnauthorized(room.id, ["join"]); assert.equal(players.getStatus("a").connected, true);
  const tcp = require("node:net").connect(raw.port, raw.host);
  await new Promise((resolve, reject) => { tcp.once("connect", resolve); tcp.once("error", reject); });
  const closed = new Promise(resolve => tcp.once("close", resolve));
  const waiting = host.read("h");
  assert.throws(() => host.read("h"), /一个消息读取循环/);
  host.closeUnauthorized(room.id, ["join"]);
  assert.equal((await waiting).connected, false); await closed;
  assert.equal(host.getStatus("h").role, null);
  await assert.rejects(new Promise((resolve, reject) => { const socket = tls.connect({ host: raw.host, port: raw.port, rejectUnauthorized: false }); socket.once("secureConnect", () => { socket.destroy(); resolve(); }); socket.once("error", reject); }), /ECONNREFUSED/);
});

test("desktop host rejects malformed frames, mismatched room handshake and stolen reconnect identity", async t => {
  const host = service(t), players = service(t);
  const created = await host.create("h", room), raw = parseInvitation(created.invitations[0].invitation, room);
  const a = await players.join("a", room, { invitation: created.invitations[0].invitation });
  const hello = { op: "hello", protocol: PROTOCOL, token: raw.token, sessionId: raw.sessionId, roomId: room.id, roomVersion: room.version, name: "攻击测试" };
  async function rejected(frame) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: raw.host, port: raw.port, rejectUnauthorized: false });
      t.after(() => socket.destroy()); let response = "";
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("未拒绝异常帧")); });
      socket.once("secureConnect", () => socket.write(frame + "\n"));
      socket.on("data", chunk => { response += chunk.toString(); if (response.includes("\n")) { socket.destroy(); resolve(JSON.parse(response.split("\n")[0])); } });
      socket.once("error", reject);
    });
  }
  for (const frame of ["null", "not-json", "x".repeat(96 * 1024 + 1), JSON.stringify({ ...hello, roomVersion: "2.0.0" }),
    JSON.stringify({ ...hello, peerId: a.peerId, resumeToken: "0".repeat(64) }), JSON.stringify({ ...hello, token: "字".repeat(64) })]) {
    assert.equal((await rejected(frame)).op, "error");
  }
  assert.equal(host.getStatus("h").peers.length, 1);
  assert.equal(players.getStatus("a").connected, true);
});
