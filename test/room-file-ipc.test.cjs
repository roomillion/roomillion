"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

test("batch-picked binary files need only pickMany, remain room-scoped and stop after revocation", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "room-file-ipc-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "page.png");
  await fsp.writeFile(file, Buffer.from([1, 2, 3, 4]));
  const handlers = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  let allowed = true;
  module.exports.registerIpcHandlers({
    roomViews: { getRoomIdForSender: id => ({ 1: "a", 2: "b" })[id], getDialogParent: () => null },
    roomStore: { getRoom: id => ({ id, name: id }), hasPermission: (_id, domain, value) => allowed && domain === "files" && value === "pickMany" },
    dialogApi: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) }
  });
  const a = { sender: { id: 1 } }, b = { sender: { id: 2 } };
  const [handle] = await handlers.get("room:filePickMany")(a, { extensions: ["png"] });
  assert.equal(typeof handle.token, "string");
  assert.equal(handle.read, undefined);
  const read = handlers.get("room:binaryRead");
  assert.deepEqual(Array.from((await read(a, handle.token, { offset: 1, length: 2 })).data), [2, 3]);
  await assert.rejects(read(b, handle.token), /令牌无效/);
  allowed = false;
  await assert.rejects(read(a, handle.token), /权限/);
  allowed = true;
  await assert.rejects(read(a, handle.token), /令牌无效/);
  await assert.rejects(read({ sender: { id: 99 } }, handle.token), /无法识别/);
});
