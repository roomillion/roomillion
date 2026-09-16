"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

test("room import dialog opens in the last successfully inspected package folder", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-import-dialog-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const packageDirectory = path.join(root, "incoming");
  await fsp.mkdir(packageDirectory);
  const packagePath = path.join(packageDirectory, "sample.room");
  await fsp.writeFile(packagePath, "package");
  const calls = [];
  const handlers = new Map();
  const mainWindow = { webContents: { id: 7 }, isDestroyed: () => false };
  let selected = { canceled: false, filePaths: [packagePath] };
  const dialogApi = { showOpenDialog: async (_window, options) => { calls.push(options); return selected; } };
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const compile = vm.runInThisContext(`(function(require, module, exports) {${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  compile((name) => name === "electron" ? {
    dialog: dialogApi,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }
  } : localRequire(name), module, module.exports);
  const unregister = module.exports.registerIpcHandlers({
    mainWindow,
    roomViews: { hide: () => {} },
    roomStore: { dataRoot: path.join(root, "data") },
    dataBackups: { inspectRoomTransfer: async () => ({ room: { id: "sample" } }) },
    dialogApi
  });
  t.after(() => unregister());
  const event = { sender: { id: 7 } };
  await handlers.get("workbench:inspectRoom")(event);
  assert.equal(calls[0].defaultPath, undefined);
  selected = { canceled: true, filePaths: [] };
  await handlers.get("workbench:inspectRoom")(event);
  assert.equal(calls[1].defaultPath, packageDirectory);
});
