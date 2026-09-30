"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

test("only workbench windows can change a specialized default and rooms hear about the change", async () => {
  const handlers = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const sent = [];
  const changes = [];
  const state = { intuition: { model: "jev-b", id: "capability-intuition-b" } };
  module.exports.registerIpcHandlers({
    mainWindow: { webContents: { id: 1, send: (...args) => sent.push(args) }, isDestroyed: () => false },
    roomStore: { dataRoot: process.cwd() },
    roomViews: { views: new Map([["room", { webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } }]]) },
    aiService: { getPublicProfile: () => null, listPublicProfiles: () => [] },
    aiCapabilityService: { setDefaultProfile: async (kind, id) => { changes.push([kind, id]); return state; }, getPublicState: () => state },
    diagnostics: { record: async () => {} }
  });
  const setDefault = handlers.get("workbench:setDefaultAiCapabilityProfile");
  await assert.rejects(setDefault({ sender: { id: 2 } }, "intuition", "capability-intuition-b"), /只能由工作台/);
  assert.deepEqual(changes, []);
  assert.equal(await setDefault({ sender: { id: 1 } }, "intuition", "capability-intuition-b"), state);
  assert.deepEqual(changes, [["intuition", "capability-intuition-b"]]);
  assert.deepEqual(sent.map(([channel]) => channel), ["room:aiModelsChanged", "workbench:aiStateChanged"]);
});
