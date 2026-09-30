"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

test("only workbench windows can copy bounded raw Agent message text", async () => {
  const handlers = new Map();
  const copied = [];
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? {
      clipboard: { writeText: value => copied.push(value) },
      ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) }
    } : localRequire(id), module, module.exports);
  module.exports.registerIpcHandlers({
    mainWindow: { webContents: { id: 1 } },
    agentWindows: { isWorkbenchSender: id => id === 1 || id === 3 },
    roomStore: { dataRoot: process.cwd() }
  });
  const copy = handlers.get("workbench:copyText");
  await assert.rejects(copy({ sender: { id: 2 } }, "private"), /只能由工作台/);
  await assert.rejects(copy({ sender: { id: 1 } }, { content: "wrong" }), /复制内容无效/);
  await assert.rejects(copy({ sender: { id: 1 } }, "x".repeat(2_000_001)), /复制内容无效/);
  assert.deepEqual(copied, []);
  const message = "# 房间方案\n\n- 第一项\n- 第二项";
  assert.equal(await copy({ sender: { id: 3 } }, message), true);
  assert.deepEqual(copied, [message]);
});
