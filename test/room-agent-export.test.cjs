"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildRoomAgentExport } = require("../src/main/room-agent-export.cjs");

test("AI conversation export keeps transcript and failure evidence without private context or image payloads", () => {
  const session = {
    id: "session-1", title: "扫描书籍", status: "error", error: "模型请求失败",
    provider: { name: "Test", model: "vision", apiKey: "private-key" },
    workflow: { phase: "clarifying", questions: [{ title: "处理哪些书页？", options: ["全部", "部分"], recommended: "全部" }], questionHistory: ["处理哪些书页？"], plan: { features: "批量 OCR", sourceId: "private-source-id" } },
    messages: [
      { id: "m1", role: "user", content: "请创建 OCR 房间", status: "sent", attachments: [
        { id: "image-1", name: "page.jpg", mimeType: "image/jpeg", bytes: 123, data: "base64-secret", path: "D:/private/page.jpg" }
      ] },
      { id: "m2", role: "assistant", content: "正在处理", status: "error" }
    ],
    steps: [{ id: "tool-1", toolName: "test_custom_room", status: "error", error: "按钮测试失败" }],
    runs: [{ id: "run-1", status: "error", model: "vision", tokens: { totalTokens: 42 }, secret: "private-run" }],
    context: { compaction: { count: 1 }, summary: "private-summary" },
    agentMessages: [{ secret: "private-context" }],
    sourceProject: { files: [{ content: "private-source" }] },
    attachments: [{ data: "private-image" }]
  };
  const report = buildRoomAgentExport(session, { appVersion: "0.3", exportedAt: "2026-01-01T00:00:00Z" });
  assert.equal(report.formatVersion, "roomillion-agent-chat@1");
  assert.equal(report.messages[0].content, "请创建 OCR 房间");
  assert.equal(report.messages[0].attachments[0].name, "page.jpg");
  assert.equal(report.steps[0].error, "按钮测试失败");
  assert.equal(report.runs[0].tokens.totalTokens, 42);
  assert.equal(report.session.contextCompaction.count, 1);
  assert.equal(report.session.workflow.questions[0].title, "处理哪些书页？");
  assert.equal(report.session.workflow.plan.features, "批量 OCR");
  const serialized = JSON.stringify(report);
  for (const secret of ["private-key", "base64-secret", "D:/private", "private-run", "private-summary", "private-context", "private-source", "private-source-id", "private-image"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
