"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

test("bulk model removal is workbench-only and notifies rooms after success", async () => {
  const handlers = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const notifications = [];
  const deleted = [];
  const aiState = { activeProfile: null, profiles: [] };
  module.exports.registerIpcHandlers({
    mainWindow: { webContents: { id: 1, send: (...args) => notifications.push(args) }, isDestroyed: () => false },
    roomStore: { dataRoot: process.cwd() },
    roomViews: { views: new Map([["room-a", { webContents: { isDestroyed: () => false, send: (...args) => notifications.push(args) } }]]) },
    aiService: {
      deleteProfiles: async (ids) => { deleted.push(ids); return aiState; },
      getPublicProfile: () => null,
      listPublicProfiles: () => []
    }
  });
  const remove = handlers.get("workbench:deleteProviderProfiles");
  await assert.rejects(remove({ sender: { id: 2 } }, ["model-a"]), /只能由工作台/);
  assert.deepEqual(deleted, []);
  assert.deepEqual(notifications, []);
  assert.deepEqual(await remove({ sender: { id: 1 } }, ["model-a", "model-b"]), aiState);
  assert.deepEqual(deleted, [["model-a", "model-b"]]);
  assert.deepEqual(notifications.map(([channel]) => channel), ["room:aiModelsChanged", "workbench:aiStateChanged"]);
});
