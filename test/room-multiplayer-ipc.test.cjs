"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { permissionsForKeys, permissionItems } = require("../src/main/permission-service.cjs");
const { validateManifest } = require("../src/main/manifest.cjs");
const { inspectCustomRoomSpec, customRoomPermissions } = require("../src/main/custom-room.cjs");

test("LAN permission is independent, opt-in for imports and cannot grant an undeclared role", () => {
  const declaration = { multiplayer: ["host", "join"], network: [] };
  assert.deepEqual(permissionsForKeys(declaration, ["multiplayer.join"]), { multiplayer: ["join"] });
  assert.equal(permissionItems(declaration)[0].defaultGranted, false);
  assert.throws(() => permissionsForKeys({ multiplayer: ["join"] }, ["multiplayer.host"]), /未申请/);
  const manifest = { formatVersion: "0.1", id: "cn.test.lan", name: "联机", version: "1.0.0", runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" }, entry: "app/index.html", permissions: declaration, hostModules: [] };
  assert.deepEqual(validateManifest(manifest).permissions.multiplayer, ["host", "join"]);
  for (const multiplayer of [["rawSocket"], ["host", "host"], true]) assert.throws(() => validateManifest({ ...manifest, permissions: { multiplayer } }), /联机权限/);
});

test("AI room compilation preserves LAN declarations and catches undeclared SDK use", () => {
  const { spec } = require("./fixtures/lan-room.cjs");
  const inspected = inspectCustomRoomSpec(spec);
  assert.equal(inspected.report.passed, true);
  assert.deepEqual(customRoomPermissions(inspected.spec).multiplayer, ["host", "join"]);
  const undeclared = inspectCustomRoomSpec({ ...spec, capabilities: { ...spec.capabilities, multiplayer: [] } });
  assert.equal(undeclared.report.passed, false);
  assert.ok(undeclared.report.errors.some(item => item.code === "js.multiplayer-undeclared"));
});

test("LAN IPC binds every connection to its room sender and cleans up on destruction, revocation and shutdown", async () => {
  const handlers = new Map(), calls = [];
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs"), localRequire = createRequire(filename), module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const event = id => ({ sender: Object.assign(new EventEmitter(), { id }) });
  const a = event(1), b = event(2), unknown = event(3);
  let granted = true;
  const service = {
    getStatus: owner => { calls.push(["status", owner]); return { connected: false }; },
    join: async (owner, room, options) => { calls.push(["join", owner, room.id, options]); return { connected: true }; },
    read: async owner => { calls.push(["read", owner]); return { events: [] }; },
    send: async owner => { calls.push(["send", owner]); return {}; },
    leave: owner => { calls.push(["leave", owner]); return true; },
    dispose: () => calls.push(["dispose"])
  };
  const cleanup = module.exports.registerIpcHandlers({ roomStore: { getRoom: id => ({ id, version: "1.0.0", grantedPermissions: granted ? { multiplayer: ["join"] } : {} }) },
    roomViews: { getRoomIdForSender: id => ({ 1: "a", 2: "b" })[id] }, multiplayerService: service });
  await assert.rejects(handlers.get("room:multiplayerJoin")(unknown, {}), /无法识别/);
  await assert.rejects(handlers.get("room:multiplayerCreate")(a, {}), /权限/);
  await handlers.get("room:multiplayerJoin")(a, { invitation: "test" });
  await handlers.get("room:multiplayerRead")(b);
  assert.ok(calls.some(call => call[0] === "join" && call[1] === "a:1" && call[2] === "a"));
  assert.ok(calls.some(call => call[0] === "read" && call[1] === "b:2"));
  a.sender.emit("destroyed"); assert.ok(calls.some(call => call[0] === "leave" && call[1] === "a:1"));
  await handlers.get("room:multiplayerJoin")(b, {});
  granted = false;
  await assert.rejects(handlers.get("room:multiplayerSend")(b, {}), /权限/);
  cleanup();
  assert.equal(b.sender.listenerCount("destroyed"), 0); assert.ok(calls.some(call => call[0] === "dispose"));
});

test("desktop host IPC preserves host-only grants and closes listeners on owner destruction and revocation", async () => {
  const handlers = new Map(), calls = [], sessions = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs"), localRequire = createRequire(filename), module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const sender = Object.assign(new EventEmitter(), { id: 1 }), event = { sender };
  let grants = ["host"];
  const service = {
    getStatus: owner => ({ role: sessions.get(owner) || null }),
    create: async (owner, room, options) => { sessions.set(owner, "host"); calls.push([owner, room.id, options]); return { role: "host" }; },
    leave: owner => { sessions.delete(owner); return true; },
    send: () => ({}), dispose: () => sessions.clear()
  };
  const cleanup = module.exports.registerIpcHandlers({ roomStore: { getRoom: id => ({ id, version: "1.0.0", grantedPermissions: { multiplayer: grants } }) },
    roomViews: { getRoomIdForSender: id => id === 1 ? "host-room" : null }, multiplayerService: service });
  try {
    await handlers.get("room:multiplayerCreate")(event, { maxPlayers: 4 });
    assert.deepEqual(calls[0], ["host-room:1", "host-room", { maxPlayers: 4 }]);
    assert.equal(sender.listenerCount("destroyed"), 1);
    await assert.rejects(handlers.get("room:multiplayerJoin")(event, {}), /权限/);
    assert.equal(sessions.get("host-room:1"), "host");
    sender.emit("destroyed"); assert.equal(sessions.size, 0);
    await handlers.get("room:multiplayerCreate")(event, {});
    grants = ["join"];
    await assert.rejects(handlers.get("room:multiplayerSend")(event, {}), /已撤销/);
    assert.equal(sessions.size, 0);
  } finally { cleanup(); }
  assert.equal(sender.listenerCount("destroyed"), 0);
});
