"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
test("assistant IPC accepts only trusted workbench main frames; rooms register under their own identity", async () => {
  const handlers = new Map(), filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const module = { exports: {} }, localRequire = createRequire(filename), seen = [];
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const frame = {}, workbench = { sender: { id: 10, mainFrame: frame }, senderFrame: frame }, room = { sender: { id: 20 } };
  const unregister = module.exports.registerIpcHandlers({ mainWindow: { webContents: { id: 10 } }, roomStore: { getRoom: id => ({ id, name: id }), hasPermission: () => false }, roomViews: { getRoomIdForSender: id => id === 20 ? "a" : null }, roomActions: { register: (id, sender, ids) => { seen.push({ id, sender: sender.id, ids }); return true; }, setAccess: () => assert.fail("untrusted caller") }, workbenchAssistant: { get: id => ({ id }), require: id => ({ id }) } });
  assert.deepEqual(await handlers.get("workbench:assistantGet")(workbench, "session"), { id: "session" });
  for (const channel of ["workbench:assistantGet", "workbench:assistantSend", "workbench:assistantAccess", "workbench:assistantConfirm", "workbench:assistantAttach", "workbench:assistantSaveArtifact"]) {
    await assert.rejects(Promise.resolve().then(() => handlers.get(channel)(room, "session", "secret")), /工作台/);
    await assert.rejects(Promise.resolve().then(() => handlers.get(channel)({ sender: workbench.sender, senderFrame: {} }, "session", "secret")), /主页面/);
  }
  assert.equal(await handlers.get("room:actionRegister")(room, ["list"]), true);
  assert.deepEqual(seen, [{ id: "a", sender: 20, ids: ["list"] }]);
  await assert.rejects(Promise.resolve().then(() => handlers.get("room:actionRegister")(workbench, ["list"])), /调用方/);
  unregister();
});
