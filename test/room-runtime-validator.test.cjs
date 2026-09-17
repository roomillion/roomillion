"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { runWorker } = require("../src/main/room-runtime-validator.cjs");

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
