"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createWorkspace, writeFile, describeWorkspace } = require("../src/main/room-draft-workspace.cjs");
const { compare, assertWorkbenchCompatible } = require("../src/main/workbench-compatibility.cjs");
test("draft files persist independently, reject stale revisions and support exact local patches", () => {
  let draft = createWorkspace({ name: "测试房间", description: "测试分文件保存", hostModules: [], capabilities: {} });
  draft = writeFile(draft, { file: "javascript", content: 'const quote = "JSON 不需再次转义";\nconst other = 1;', expectedRevision: 1 });
  assert.throws(() => writeFile(draft, { file: "html", content: "<main></main>", expectedRevision: 1 }), /草稿已更新/);
  assert.throws(() => writeFile(draft, { file: "../secret", content: "a", expectedRevision: 2 }), /只能写入/);
  assert.throws(() => writeFile(draft, { file: "javascript", find: "const", content: "let", expectedRevision: 2 }), /唯一/);
  const patched = writeFile(draft, { file: "javascript", find: "other = 1", content: "other = 2", expectedRevision: 2 });
  assert.match(patched.files.javascript, /other = 2/);
  assert.match(draft.files.javascript, /other = 1/);
  const updated = createWorkspace({ ...draft.metadata, name: "改名房间" }, patched);
  assert.equal(updated.files.javascript, patched.files.javascript);
  assert.equal(describeWorkspace(updated).files.javascript.saved, true);
  assert.equal(describeWorkspace(updated, "javascript").content, patched.files.javascript);
});
test("workbench versions compare prereleases numerically and reject newer required runtimes", () => {
  assert.equal(compare("0.3.0-alpha.10", "0.3.0-alpha.9"), 1);
  assert.equal(compare("0.3.0", "0.3.0-alpha.99"), 1);
  assert.equal(compare("0.3.0-alpha", "0.3.0-alpha.1"), -1);
  assert.throws(() => compare("banana", "0.3.0"), /版本/);
  assert.throws(() => assertWorkbenchCompatible({ runtime: { minimumWorkbench: "0.3.0-alpha.26" } }, "0.3.0-alpha.25"), /请先升级/);
  assert.doesNotThrow(() => assertWorkbenchCompatible({ runtime: { minimumWorkbench: "0.3.0-alpha.26" } }, "0.3.0"));
});
