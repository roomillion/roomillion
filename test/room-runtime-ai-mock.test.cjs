"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRoomRuntimeAiMock } = require("../src/main/room-runtime-ai-mock.cjs");

test("AI mock explains missing per-call responses and can reset for formal scenarios", () => {
  const mock = createRoomRuntimeAiMock([{ text: "Hello" }]);
  assert.equal(mock.generate().text, "Hello");
  assert.throws(() => mock.generate(), /第 2 次场景 AI 调用.*只有 1 条/);
  mock.reset();
  assert.equal(mock.generate().text, "Hello");
});

test("delayed AI mock stops output on cancellation and allows a new request", async () => {
  const mock = createRoomRuntimeAiMock([{ text: "123456789", chunkDelayMs: 10 }, { text: "new" }]);
  const controller = new AbortController();
  const chunks = [];
  await assert.rejects(mock.stream({ signal: controller.signal, onTextDelta: delta => {
    chunks.push(delta);
    controller.abort();
  } }), /abort/i);
  assert.deepEqual(chunks, ["123"]);
  assert.equal((await mock.stream()).text, "new");
});

test("AI mock failure consumes one response and a retry can recover", async () => {
  const mock = createRoomRuntimeAiMock([{ error: "模拟服务暂时不可用" }, { text: "重试成功" }]);
  await assert.rejects(mock.stream(), /模拟服务暂时不可用/);
  assert.equal((await mock.stream()).text, "重试成功");
});
