"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRoomTestDefinition, runDeclaredScenarios } = require("../src/main/room-test-definition.cjs");

test("room test definitions normalize bounded scenarios and AI mocks", () => {
  const definition = normalizeRoomTestDefinition({
    version: 1,
    mocks: { ai: [{ text: "识别结果" }] },
    scenarios: [{ name: "识别一页", actions: [
      { type: "click", selector: "#run", count: 12 },
      { type: "wait", ms: 999999 },
      { type: "reload" },
      { type: "assertText", selector: "#result", value: "识别结果" }
    ] }]
  });
  assert.equal(definition.scenarios[0].actions[1].ms, 5000);
  assert.equal(definition.scenarios[0].actions[0].count, 12);
  assert.throws(() => normalizeRoomTestDefinition({ version: 1, scenarios: [{ actions: [{ type: "click", selector: "#run", count: 31 }] }] }), /连续点击/);
  assert.deepEqual(definition.scenarios[0].actions[2], { type: "reload" });
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

test("multi-round regression suites retain more than twenty scenarios", async () => {
  const scenarios = Array.from({ length: 25 }, (_, index) => ({ name: `回归 ${index + 1}`, actions: [{ type: "assertExists", selector: "#result" }] }));
  const definition = normalizeRoomTestDefinition({ version: 1, scenarios });
  let calls = 0;
  const result = await runDeclaredScenarios({ executeJavaScript: async () => { calls += 1; } }, definition);
  assert.equal(result.passed, true);
  assert.equal(calls, 25);
  assert.deepEqual(result.scenarios, scenarios.map(scenario => scenario.name));
  assert.throws(() => normalizeRoomTestDefinition({ version: 1, scenarios: [] }), /至少一个/);
  assert.throws(() => normalizeRoomTestDefinition({ version: 1, scenarios: [...scenarios, { actions: [{ type: "shell" }] }] }), /不支持/);
});

test("synthetic test files are bounded inline bytes with safe unique names", () => {
  const definition = files => normalizeRoomTestDefinition({ version: 1, mocks: { files }, scenarios: [{ actions: [{ type: "assertExists", selector: "main" }] }] });
  assert.equal(Buffer.from(definition([{ name: "书页.csv", text: "页码,标题\n1,目录" }]).mocks.files[0].base64, "base64").toString(), "页码,标题\n1,目录");
  for (const name of ["../secret", "C:\\key", "con.png", ".", "x.", "x ", "a/b"]) assert.throws(() => definition([{ name, text: "fake" }]), /文件名/);
  assert.throws(() => definition([{ name: "a.png", text: "x" }, { name: "A.PNG", text: "y" }]), /重复/);
  assert.throws(() => definition([{ name: "a.png", base64: "not base64" }]), /base64/);
  assert.throws(() => definition([{ name: "a.png", text: "x", base64: "eA==" }]), /只能/);
  assert.throws(() => definition([{ name: "a.txt", text: "x".repeat(2 * 1024 * 1024 + 1) }]), /2 MiB/);
  assert.throws(() => definition(Array.from({ length: 21 }, (_, n) => ({ name: `${n}.txt`, text: "x" }))), /20 项/);
});

test("isolated export capture is explicit and type checked", () => {
  const input = { version: 1, scenarios: [{ actions: [{ type: "assertExists", selector: "main" }] }] };
  assert.equal(normalizeRoomTestDefinition(input).mocks.captureExports, false);
  assert.equal(normalizeRoomTestDefinition({ ...input, mocks: { captureExports: true } }).mocks.captureExports, true);
  assert.throws(() => normalizeRoomTestDefinition({ ...input, mocks: { captureExports: "yes" } }), /captureExports/);
});
