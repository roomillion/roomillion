"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tls = require("node:tls");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { RoomMultiplayerService, parseInvitation, PROTOCOL } = require("../src/main/room-multiplayer-service.cjs");
const { certificate } = require("./helpers/lan-test-certificate.cjs");

const room = { id: "cn.roomillion.lan-test", version: "1.0.0" };
const encode = value => "roomillion-lan:" + Buffer.from(JSON.stringify(value)).toString("base64url");
async function host(t) {
  const cert = certificate(), clients = new Map(), received = [];
  const token = crypto.randomBytes(32).toString("hex"), sessionId = crypto.randomBytes(16).toString("hex");
  const sockets = new Set();
  const server = tls.createServer(cert, socket => {
    sockets.add(socket); socket.on("error", () => {});
    let buffer = "", peer;
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (msg.op === "hello") {
          if (msg.token !== token) { socket.end(JSON.stringify({ op: "error", error: "加入凭证无效" }) + "\n"); continue; }
          peer = msg.peerId && clients.get(msg.peerId);
          if (!peer) { peer = { id: crypto.randomBytes(16).toString("hex"), resume: crypto.randomBytes(32).toString("hex") }; clients.set(peer.id, peer); }
          else assert.equal(msg.resumeToken, peer.resume);
          peer.socket = socket;
          socket.write(JSON.stringify({ op: "welcome", peerId: peer.id, resumeToken: peer.resume }) + "\n");
        } else if (msg.op === "message") { received.push({ peer: peer.id, ...msg }); socket.write(JSON.stringify({ op: "ack", id: msg.id }) + "\n"); }
        else if (msg.op === "leave") { clients.delete(peer.id); socket.end(); }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)); });
  const invitation = { protocol: PROTOCOL, host: "127.0.0.1", port: server.address().port, ...room, roomId: room.id, roomVersion: room.version, token, sessionId, fingerprint: cert.fingerprint };
  return { invitation: encode(invitation), raw: invitation, clients, received,
    send(id, data) { const messageId = crypto.randomBytes(16).toString("hex"); clients.get(id).socket.write(JSON.stringify({ op: "message", id: messageId, from: "host", data }) + "\n"); return messageId; } };
}

test("LAN invitations reject public destinations, wrong room versions and malformed credentials", () => {
  const valid = { protocol: PROTOCOL, host: "192.168.43.1", port: 20000, roomId: room.id, roomVersion: room.version, token: "a".repeat(64), sessionId: "b".repeat(32), fingerprint: "c".repeat(64) };
  assert.equal(parseInvitation(encode(valid), room).host, valid.host);
  for (const host of ["8.8.8.8", "localhost", "example.com", "0.0.0.0", "192.168.1.999", "192.168.1.2/path"]) assert.throws(() => parseInvitation(encode({ ...valid, host }), room), /地址或凭证/);
  assert.throws(() => parseInvitation(encode({ ...valid, roomVersion: "2.0.0" }), room), /相同 ID 和版本/);
  assert.throws(() => parseInvitation("roomillion-lan:bad", room), /无效/);
  assert.throws(() => parseInvitation(encode(null), room), /无效/);
  assert.throws(() => parseInvitation(encode({ ...valid, token: "short" }), room), /凭证/);
});

test("desktop LAN clients exchange JSON with a pinned host and private messages stay in their owner queue", async t => {
  const game = await host(t), service = new RoomMultiplayerService(); t.after(() => service.dispose());
  const a = await service.join("room-a:1", room, { invitation: game.invitation, name: "甲" });
  const b = await service.join("room-a:2", room, { invitation: game.invitation, name: "乙" });
  await service.read("room-a:1", { timeoutMs: 0 }); await service.read("room-a:2", { timeoutMs: 0 });
  const id = game.send(a.peerId, { role: "seer" });
  const received = await service.read("room-a:1");
  assert.deepEqual(received.events, [{ type: "message", id, from: "host", data: { role: "seer" } }]);
  assert.deepEqual((await service.read("room-a:2", { timeoutMs: 30 })).events, []);
  service.send("room-a:1", { vote: b.peerId });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(game.received[0].peer, a.peerId);
  assert.equal(game.received[0].data.vote, b.peerId);
  assert.throws(() => service.send("room-a:1", {}, { to: b.peerId }), /只能向主机/);
  assert.throws(() => service.read("other:1", {}), /尚未加入/);
  assert.throws(() => service.send("room-a:1", "x".repeat(65537)), /64 KiB/);
  assert.throws(() => service.read("room-a:1", { timeoutMs: -1 }), /等待读取/);
  assert.equal(service.getStatus("room-a:1").canHost, true);
});

test("desktop rejects a wrong certificate before sending credentials and rejects bad join tokens", async t => {
  const game = await host(t), service = new RoomMultiplayerService(); t.after(() => service.dispose());
  await assert.rejects(service.join("a", room, { invitation: encode({ ...game.raw, fingerprint: "0".repeat(64) }) }), /证书/);
  assert.equal(game.clients.size, 0);
  await assert.rejects(service.join("a", room, { invitation: encode({ ...game.raw, token: "0".repeat(64) }) }), /凭证/);
  assert.equal(service.getStatus("a").role, null);
});

test("desktop reconnects with the same identity and room closure resolves waiting reads", async t => {
  const game = await host(t), service = new RoomMultiplayerService(); t.after(() => service.dispose());
  const joined = await service.join("a", room, { invitation: game.invitation });
  await service.read("a", { timeoutMs: 0 });
  game.clients.get(joined.peerId).socket.destroy();
  assert.equal((await service.read("a")).events[0].type, "disconnected");
  const reconnected = await service.read("a", { timeoutMs: 5000 });
  assert.equal(reconnected.events[0].type, "connected");
  assert.equal(reconnected.peerId, joined.peerId);
  const waiting = service.read("a");
  assert.throws(() => service.read("a"), /一个消息读取循环/);
  service.closeRoom(room.id);
  assert.equal((await waiting).connected, false);
  assert.equal(service.getStatus("a").role, null);
});
