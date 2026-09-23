"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NetworkService, detectInternetConnectivity } = require("../src/main/network-service.cjs");
const { RoomCredentialService } = require("../src/main/room-credential-service.cjs");

function room({ granted = ["https://api.example.com"] } = {}) {
  return {
    id: "cn.zhibian.network-test",
    permissions: { network: ["https://api.example.com", "http://intranet:8080"] },
    requestedPermissions: { network: ["https://api.example.com", "http://intranet:8080"] },
    grantedPermissions: { network: granted }
  };
}

test("connectivity detection accepts any reachable probe and fails closed", async () => {
  const reachable = await detectInternetConnectivity(async (url) => {
    if (url.endsWith("/online")) return new Response(null, { status: 204 });
    throw new Error("offline");
  }, { endpoints: ["https://probe.example/offline", "https://probe.example/online"], timeoutMs: 100 });
  assert.equal(reachable, true);
  const offline = await detectInternetConnectivity(async () => { throw new Error("offline"); }, {
    endpoints: ["https://probe.example/offline"],
    timeoutMs: 100
  });
  assert.equal(offline, false);
});

test("first launch selects the network switch from connectivity and later preserves the user choice", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-service-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let probes = 0;
  const service = await new NetworkService(root, {
    fetchImpl: async () => new Response("unexpected"),
    connectivityProbe: async () => { probes += 1; return true; }
  }).init();
  assert.equal(service.getPublicState().roomNetworkEnabled, true);
  assert.equal(service.getPublicState().agentWebAvailable, true);
  assert.equal(service.getPublicState().initialDetection, "online");
  assert.match(service.getPublicState().detectedAt, /^\d{4}-/);
  assert.equal(probes, 1);
  await service.setRoomNetworkEnabled(false);
  const reloaded = await new NetworkService(root, {
    fetchImpl: async () => new Response("ok"),
    connectivityProbe: async () => { throw new Error("不应再次探测"); }
  }).init();
  assert.equal(reloaded.getPublicState().roomNetworkEnabled, false);
  assert.equal(reloaded.getPublicState().agentWebAvailable, false);
  assert.equal(reloaded.getPublicState().initialDetection, "online");
  assert.equal(reloaded.getPublicState().aiApiAllowed, true);
});

test("failed first-launch connectivity keeps networking off", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-network-offline-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new NetworkService(root, { connectivityProbe: async () => false }).init();
  assert.equal(service.getPublicState().roomNetworkEnabled, false);
  assert.equal(service.getPublicState().initialDetection, "offline");
  await assert.rejects(service.request(room(), { url: "https://api.example.com/data" }), /主工作台尚未允许/);
});

test("room network request enforces declared and granted origins with bounded JSON responses", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-request-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const calls = [];
  const service = await new NetworkService(root, {
    autoDetect: false,
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
    autoDetect: false,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://other.example/private" } })
  }).init();
  await service.setRoomNetworkEnabled(true);
  await assert.rejects(service.request(room(), { url: "https://api.example.com/start" }), /没有访问 https:\/\/other\.example/);
});

test("room network streams binary responses without a total response ceiling", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-stream-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const payload = new Uint8Array(6 * 1024 * 1024 + 17).map((_, index) => index % 251);
  const service = await new NetworkService(root, { autoDetect: false, fetchImpl: async () => new Response(payload) }).init();
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

test("named credentials inject only into their bound origin and never return plaintext", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-network-credential-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`),
    decryptString: (value) => value.toString().slice("protected:".length)
  };
  const credentials = await new RoomCredentialService(root, { secureStorage }).init();
  await credentials.set({ alias: "book-api", label: "书籍服务", origin: "https://api.example.com", value: "top-secret", remember: true });
  await assert.rejects(credentials.set({ alias: "bad-header", origin: "https://api.example.com", value: "secret\r\ninjected: yes" }), /换行/);
  const calls = [];
  const service = await new NetworkService(root, { autoDetect: false, credentialService: credentials, fetchImpl: async (url, options) => { calls.push({ url: url.toString(), headers: options.headers }); return new Response("ok"); } }).init();
  await service.setRoomNetworkEnabled(true);
  const credentialRoom = {
    ...room(),
    permissions: { network: ["https://api.example.com"], credentials: ["book-api"] },
    requestedPermissions: { network: ["https://api.example.com"], credentials: ["book-api"] },
    grantedPermissions: { network: ["https://api.example.com"], credentials: ["book-api"] }
  };
  const response = await service.request(credentialRoom, { url: "https://api.example.com/books", credentialAlias: "book-api" });
  assert.equal(calls[0].headers.authorization, "Bearer top-secret");
  assert.doesNotMatch(JSON.stringify(response), /top-secret/);
  assert.deepEqual(credentials.listForRoom(credentialRoom).map((item) => ({ alias: item.alias, available: item.available })), [{ alias: "book-api", available: true }]);
  assert.throws(() => credentials.resolveForRoom(credentialRoom, "book-api", "https://other.example/data"), /只能用于/);
  const reloaded = await new RoomCredentialService(root, { secureStorage }).init();
  assert.equal(reloaded.list()[0].available, true);
  assert.doesNotMatch(await fsp.readFile(path.join(root, "room-credentials", "index.json"), "utf8"), /top-secret/);
});
