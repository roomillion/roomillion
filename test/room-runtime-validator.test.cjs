"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { runWorker, validateRoomRuntime } = require("../src/main/room-runtime-validator.cjs");

function stalledWorker() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.destroy = () => { child.stderrDestroyed = true; };
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test("runtime check timeout finishes even when the Electron child never emits exit or close", async () => {
  const child = stalledWorker();
  await assert.rejects(runWorker("input.json", null, 20, () => child), /运行检查超时/);
  assert.equal(child.killed, true);
  assert.equal(child.stderrDestroyed, true);
});

test("runtime check abort finishes without waiting for a stuck child process", async () => {
  const child = stalledWorker();
  const controller = new AbortController();
  const pending = runWorker("input.json", controller.signal, 10_000, () => child);
  controller.abort();
  await assert.rejects(pending, /运行检查已停止/);
  assert.equal(child.killed, true);
});

test("runtime check resolves when the browser process exits even if stderr stays open", async () => {
  const child = stalledWorker();
  const pending = runWorker("input.json", null, 10_000, () => child);
  child.emit("exit", 0);
  await pending;
  assert.equal(child.killed, undefined);
  assert.equal(child.stderrDestroyed, true);
});

test("AI text deltas reach room callbacks and complete before the final result", async () => {
  const spec = {
    formatVersion: "room-app@1",
    kind: "custom",
    name: "合成翻译测试房间",
    description: "用模拟模型验证翻译输入和增量译文",
    theme: "light",
    hostModules: [],
    capabilities: { database: false, files: [], ai: true },
    files: {
      html: '<main><textarea id="source"></textarea><button id="translate">翻译</button><output id="target"></output></main>',
      css: 'body{font-family:sans-serif}main{display:grid;gap:1rem;padding:1rem}textarea{min-height:8rem}',
      javascript: `const source = document.getElementById("source");
const target = document.getElementById("target");
document.getElementById("translate").addEventListener("click", async () => {
  target.textContent = "";
  let chunks = 0;
  try {
    const result = await window.room.ai.generate("请翻译：" + source.value, {
      onChunk: delta => { chunks += 1; target.textContent += delta; }
    });
    if (chunks < 2 || target.textContent !== result.text) target.textContent = "增量不完整";
  } catch (error) { target.textContent = "调用失败：" + error.message; }
});`,
      "room-tests.json": JSON.stringify({
        version: 1,
        mocks: { ai: [{ text: "Hello world" }] },
        scenarios: [{ name: "翻译流式输出", actions: [
          { type: "input", selector: "#source", value: "你好，世界" },
          { type: "click", selector: "#translate" },
          { type: "wait", ms: 300 },
          { type: "assertText", selector: "#target", value: "Hello world" }
        ] }]
      })
    }
  };
  const result = await validateRoomRuntime({ spec });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.checks.find(check => check.id === "declared-scenarios")?.passed, true);
});
