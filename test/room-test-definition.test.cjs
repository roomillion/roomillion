"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRoomTestDefinition, runDeclaredScenarios } = require("../src/main/room-test-definition.cjs");

test("room test definitions normalize bounded scenarios and AI mocks", () => {
  const definition = normalizeRoomTestDefinition({
    version: 1,
    mocks: { ai: [{ text: "识别结果" }] },
    scenarios: [{ name: "识别一页", actions: [
      { type: "click", selector: "#run" },
      { type: "wait", ms: 999999 },
      { type: "assertText", selector: "#result", value: "识别结果" }
    ] }]
  });
  assert.equal(definition.scenarios[0].actions[1].ms, 5000);
  assert.deepEqual(definition.mocks.ai, [{ text: "识别结果" }]);
  assert.throws(() => normalizeRoomTestDefinition({ version: 2, scenarios: [] }), /version/);
  assert.throws(() => normalizeRoomTestDefinition({ version: 1, scenarios: [{ actions: [{ type: "shell" }] }] }), /不支持/);
});

test("declared scenarios return renderer failures as structured test results", async () => {
  const webContents = { executeJavaScript: async () => { throw new Error("文本断言失败"); } };
  const result = await runDeclaredScenarios(webContents, normalizeRoomTestDefinition({
    version: 1,
    scenarios: [{ name: "失败", actions: [{ type: "assertText", selector: "#output", value: "完成" }] }]
  }));
  assert.equal(result.passed, false);
  assert.match(result.error, /文本断言失败/);
});