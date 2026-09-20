"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

test("room AI IPC validates permission and ownership and cancellation wins during setup", async () => {
  const handlers = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const sender = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: () => {} });
  const a = { sender: sender(1) }, b = { sender: sender(2) }, unknown = { sender: sender(99) };
  let allowed = true;
  let signalSeen;
  module.exports.registerIpcHandlers({
    roomViews: { getRoomIdForSender: id => ({ 1: "a", 2: "b" })[id] },
    roomStore: { getRoom: id => ({ id, name: id }), hasPermission: () => allowed },
    aiService: { resolveRoomModelProfile: () => "test", complete: async ({ signal }) => {
      signalSeen = signal;
      signal.throwIfAborted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } }
  });
  const generate = handlers.get("room:aiGenerate"), cancel = handlers.get("room:aiCancel");
  await assert.rejects(cancel(unknown, "test"), /无法识别/);
  allowed = false;
  await assert.rejects(cancel(a, "test"), /权限/);
  await assert.rejects(generate(a, "test", {}), /权限/);
  allowed = true;
  await assert.rejects(generate(a, "test", { requestId: "bad id" }), /标识无效/);
  await assert.rejects(generate(a, "test", { requestId: null }), /标识无效/);
  const pending = generate(a, "test", { requestId: "test" });
  const rejected = assert.rejects(pending, /已取消/);
  assert.deepEqual(await cancel(b, "test"), { cancelled: false });
  assert.deepEqual(await cancel(a, "test"), { cancelled: true });
  await rejected;
  assert.equal(signalSeen.aborted, true);
  assert.deepEqual(await cancel(a, "test"), { cancelled: false });
  assert.equal(a.sender.listenerCount("destroyed"), 0);
  await assert.rejects(generate(a, "test", { requestId: "invalid-options", maxTokens: -1 }), /正整数/);
  assert.equal(a.sender.listenerCount("destroyed"), 0);
});
