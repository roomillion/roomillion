"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NetworkService } = require("../src/main/network-service.cjs");

function room({ granted = ["https://api.example.com"] } = {}) {
  return {
    id: "cn.zhibian.network-test",
    permissions: { network: ["https://api.example.com", "http://intranet:8080"] },
    requestedPermissions: { network: ["https://api.example.com", "http://intranet:8080"] },
    grantedPermissions: { network: granted }
  };
}

test("global room network switch is off by default and persists independently from AI", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-service-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new NetworkService(root, { fetchImpl: async () => new Response("unexpected") }).init();
  assert.deepEqual(service.getPublicState(), {
    roomNetworkEnabled: false,
    aiApiAllowed: true,
    policy: "global-switch-and-room-origin-permission"
  });
  await assert.rejects(service.request(room(), { url: "https://api.example.com/data" }), /主工作台尚未允许/);
  await service.setRoomNetworkEnabled(true);
  const reloaded = await new NetworkService(root, { fetchImpl: async () => new Response("ok") }).init();
  assert.equal(reloaded.getPublicState().roomNetworkEnabled, true);
  assert.equal(reloaded.getPublicState().aiApiAllowed, true);
});

test("room network request enforces declared and granted origins with bounded JSON responses", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-request-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const calls = [];
  const service = await new NetworkService(root, {
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), method: options.method, headers: options.headers, body: options.body });
      return new Response(JSON.stringify({ answer: 42 }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "secret=1" }
      });
    }
  }).init();
  await service.setRoomNetworkEnabled(true);
  const result = await service.request(room(), {
    url: "https://api.example.com/v1/data",
    method: "POST",
    headers: { authorization: "Bearer room-owned-value" },
    body: { question: "life" },
    timeoutMs: 5000
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { answer: 42 });
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["content-type"], "application/json; charset=utf-8");
  assert.equal(calls[0].body, JSON.stringify({ question: "life" }));
  await assert.rejects(service.request(room(), { url: "https://other.example/data" }), /没有访问/);
  await assert.rejects(service.request(room({ granted: [] }), { url: "https://api.example.com/data" }), /没有获得联网权限/);
  await assert.rejects(service.request(room(), { url: "https://user:secret@api.example.com/data" }), /用户名或密码/);
  await assert.rejects(service.request(room(), { url: "https://api.example.com", headers: { cookie: "secret=1" } }), /不能设置请求头/);
});

test("redirects cannot escape the room origin allowlist", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-redirect-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new NetworkService(root, {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://other.example/private" } })
  }).init();
  await service.setRoomNetworkEnabled(true);
  await assert.rejects(service.request(room(), { url: "https://api.example.com/start" }), /没有访问 https:\/\/other\.example/);
});

test("room network streams binary responses without a total response ceiling", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-stream-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const payload = new Uint8Array(6 * 1024 * 1024 + 17).map((_, index) => index % 251);
  const service = await new NetworkService(root, { fetchImpl: async () => new Response(payload) }).init();
  await service.setRoomNetworkEnabled(true);
  const opened = await service.open(room(), { url: "https://api.example.com/blob", timeoutMs: 120000 });
  const chunks = [];
  while (true) {
    const result = await service.read(room(), opened.token, { maxBytes: 700000 });
    chunks.push(Buffer.from(result.data));
    if (result.done) break;
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(payload));
});
