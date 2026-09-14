"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  PermissionService,
  keysForPermissions,
  permissionDiff,
  permissionItems,
  permissionsForKeys
} = require("../src/main/permission-service.cjs");

const requested = {
  database: "private",
  files: ["pick", "export", "largeText"],
  ai: { roles: ["general"] },
  network: [],
  browser: ["navigate", "download"]
};

test("permission keys round-trip and mandatory database remains granted", () => {
  assert.deepEqual(keysForPermissions(requested), ["database.private", "files.pick", "files.export", "files.largeText", "ai.general", "browser.navigate", "browser.download"]);
  assert.deepEqual(permissionsForKeys(requested, ["files.export"]), {
    database: "private",
    files: ["export"]
  });
  assert.throws(() => permissionsForKeys(requested, ["files.system"]), /未申请/);
  assert.throws(() => permissionsForKeys(requested, ["browser.download"]), /同时授予浏览网页权限/);
  assert.deepEqual(permissionsForKeys(requested, ["browser.navigate", "browser.download"]), {
    database: "private",
    browser: ["navigate", "download"]
  });
});

test("external sensitive permissions default off while previous grants remain selected", () => {
  const networkRequested = { ...requested, network: ["https://api.example.com"] };
  const items = permissionItems(networkRequested, { source: "external", previouslyGranted: ["files.pick"] });
  assert.equal(items.find((item) => item.key === "database.private").defaultGranted, true);
  assert.equal(items.find((item) => item.key === "files.pick").defaultGranted, true);
  assert.equal(items.find((item) => item.key === "files.export").defaultGranted, false);
  assert.equal(items.find((item) => item.key === "files.largeText").defaultGranted, false);
  assert.equal(items.find((item) => item.key === "ai.general").defaultGranted, false);
  assert.equal(items.find((item) => item.key === "browser.navigate").defaultGranted, false);
  assert.equal(items.find((item) => item.key === "browser.navigate").risk, "high");
  const network = items.find((item) => item.domain === "network");
  assert.equal(network.defaultGranted, false);
  assert.equal(network.value, "https://api.example.com");
  assert.equal(network.risk, "high");
});

test("permission diff reports new and removed capabilities", () => {
  assert.deepEqual(permissionDiff(
    { database: "private", files: ["export"] },
    { database: "private", files: ["pick"], ai: { roles: ["general"] } }
  ), {
    added: ["files.pick", "ai.general"],
    removed: ["files.export"],
    unchanged: ["database.private"]
  });
});

test("permission ledger persists grants without granting undeclared capabilities", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-permission-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new PermissionService(root).init();
  await service.setGrant({
    roomId: "cn.zhibian.permission-test",
    version: "1.0.0",
    requestedPermissions: requested,
    selectedKeys: ["files.export"],
    source: "external",
    trust: "unknown",
    publisher: null
  });
  assert.equal(service.has("cn.zhibian.permission-test", "database"), true);
  assert.equal(service.has("cn.zhibian.permission-test", "files", "export"), true);
  assert.equal(service.has("cn.zhibian.permission-test", "files", "pick"), false);
  assert.equal(service.has("cn.zhibian.permission-test", "ai"), false);
  assert.equal(service.has("cn.zhibian.permission-test", "network"), false);
  assert.equal(service.has("cn.zhibian.permission-test", "browser"), false);

  const reloaded = await new PermissionService(root).init();
  assert.deepEqual(reloaded.getGrantedKeys("cn.zhibian.permission-test"), ["database.private", "files.export"]);
  const onDisk = await fsp.readFile(path.join(root, "permissions.json"), "utf8");
  assert.doesNotMatch(onDisk, /api[_-]?key/i);
});

test("network origins are granted individually and cannot exceed the manifest declaration", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-network-permission-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new PermissionService(root).init();
  const networkRequested = { network: ["https://api.example.com", "http://intranet:8080"] };
  await service.setGrant({
    roomId: "cn.zhibian.network-permission-test",
    version: "1.0.0",
    requestedPermissions: networkRequested,
    selectedKeys: ["network:https://api.example.com"],
    source: "external",
    trust: "unknown",
    publisher: null
  });
  assert.equal(service.has("cn.zhibian.network-permission-test", "network", "https://api.example.com"), true);
  assert.equal(service.has("cn.zhibian.network-permission-test", "network", "http://intranet:8080"), false);
  assert.throws(() => permissionsForKeys(networkRequested, ["network:https://not-declared.example"]), /未申请/);
});
