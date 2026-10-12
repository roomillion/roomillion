"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
test("real desktop assistant edits rooms repeatedly, hands Markdown to another room and saves a genuine PDF", { timeout: 90000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [path.resolve(__dirname, "../scripts/smoke-workbench-assistant.cjs")], { cwd: path.resolve(__dirname, ".."), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; const timer = setTimeout(() => { child.kill(); reject(new Error(`助手测试超时\n${output}`)); }, 80000);
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /WORKBENCH_ASSISTANT_SMOKE_OK/);
});
