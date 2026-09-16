"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const test = require("node:test");
const { RoomViewManager } = require("../src/main/room-view-manager.cjs");

function fixture() {
  const handlers = new Map();
  const calls = [];
  const mainWindow = { isDestroyed: () => false };
  const detachedWindow = { isDestroyed: () => false };
  const room = { id: "inventory", name: "物资台账" };
  const event = { sender: { id: 123 } };
  const roomViews = Object.assign(Object.create(RoomViewManager.prototype), {
    mainWindow, detachedWindows: new Map(), senderRooms: new Map([[123, room.id]]),
    views: new Map([[room.id, { webContents: { isDestroyed: () => false } }]])
  });
  const state = { allowed: true, response: { canceled: true, filePaths: [] } };
  const dialogApi = Object.fromEntries(["showOpenDialog", "showSaveDialog"].map(method => [method,
    async (parent, options) => { calls.push({ method, parent, options }); return state.response; }
  ]));
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const compile = vm.runInThisContext(`(function(require, module, exports) {${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  compile(id => id === "electron" ? {
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener), removeHandler: channel => handlers.delete(channel) }
  } : localRequire(id), module, module.exports);
  module.exports.registerIpcHandlers({ mainWindow, roomViews, dialogApi,
    roomStore: { getRoom: () => room, hasPermission: () => state.allowed }
  });
  return { handlers, calls, mainWindow, detachedWindow, roomViews, room, event, state };
}

const operations = [
  ["room:exportText", "inventory.csv", "名称,数量\n纸张,3"],
  ["room:exportBinary", "report.bin", new Uint8Array([1, 2, 3])],
  ["room:pickText"], ["room:pickBinary"], ["room:binaryOpen"], ["room:filePickMany"], ["room:directoryOpen"], ["room:largeTextOpen"]
];

test("all eight room file dialogs follow attached, detached and re-docked room; cancellation is explicit", async () => {
  const f = fixture();
  for (const parent of [f.mainWindow, f.detachedWindow, f.mainWindow]) {
    if (parent === f.mainWindow) f.roomViews.detachedWindows.clear();
    else f.roomViews.detachedWindows.set(f.room.id, { window: parent });
    for (const [channel, ...args] of operations) {
      const result = await f.handlers.get(channel)(f.event, ...args);
      if (channel === "room:filePickMany") assert.deepEqual(result, [], channel);
      else assert.equal(result, null, channel);
      assert.equal(f.calls.at(-1).parent, parent, channel);
    }
  }
  assert.equal(f.calls.length, 24);
});

test("unknown senders, revoked permissions and closed rooms never open file dialogs", async () => {
  const f = fixture();
  for (const [channel, ...args] of operations) {
    await assert.rejects(f.handlers.get(channel)({ sender: { id: 999 } }, ...args), /无法识别/);
    f.state.allowed = false;
    await assert.rejects(f.handlers.get(channel)(f.event, ...args), /权限/);
    f.state.allowed = true;
  }
  f.roomViews.views.clear();
  await assert.rejects(f.handlers.get("room:exportText")(f.event, "test.csv", "test"), /窗口已关闭/);
  assert.equal(f.calls.length, 0);
});

test("detached CSV and binary exports preserve file contents", async () => {
  const f = fixture();
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-dialog-test-"));
  try {
    f.roomViews.detachedWindows.set(f.room.id, { window: f.detachedWindow });
    for (const [channel, name, content] of operations.slice(0, 2)) {
      const filePath = path.join(directory, name);
      f.state.response = { canceled: false, filePath };
      assert.equal(await f.handlers.get(channel)(f.event, name, content), filePath);
      assert.deepEqual(await fsp.readFile(filePath), Buffer.from(content));
      assert.equal(f.calls.at(-1).parent, f.detachedWindow);
    }
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("streaming export writes multiple text and binary chunks directly to disk", async () => {
  const f = fixture();
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-stream-export-test-"));
  try {
    const filePath = path.join(directory, "stream.bin");
    f.state.response = { canceled: false, filePath };
    const opened = await f.handlers.get("room:exportBegin")(f.event, "stream.bin");
    await f.handlers.get("room:exportWrite")(f.event, opened.token, "hello");
    await f.handlers.get("room:exportWrite")(f.event, opened.token, new Uint8Array([0, 1, 2]));
    const finished = await f.handlers.get("room:exportFinish")(f.event, opened.token);
    assert.equal(finished.bytes, 8);
    assert.deepEqual(await fsp.readFile(filePath), Buffer.from([104, 101, 108, 108, 111, 0, 1, 2]));
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
});
