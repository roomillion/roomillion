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
