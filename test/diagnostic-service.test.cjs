"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DiagnosticService, sanitizeDiagnosticValue } = require("../src/main/diagnostic-service.cjs");

test("diagnostic sanitizer removes secrets, content, URLs, and absolute paths", () => {
  const sanitized = sanitizeDiagnosticValue({
    apiKey: "SUPER_SECRET_KEY",
    password: "BACKUP_PASSWORD",
    prompt: "CONFIDENTIAL_BUSINESS_PROMPT",
    endpoint: "https://internal-ai.example.test/v1?tenant=secret",
    filePath: "C:\\Users\\alice\\Secret\\report.xlsx",
    safe: "room.import",
    nested: { authorization: "Bearer secret" }
  });
  const encoded = JSON.stringify(sanitized);
  assert.doesNotMatch(encoded, /SUPER_SECRET|BACKUP_PASSWORD|CONFIDENTIAL|internal-ai|alice|Bearer/);
  assert.match(encoded, /room\.import/);
  assert.match(encoded, /已脱敏/);
});

test("diagnostic report contains only room metadata and recent sanitized events", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-diagnostics-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new DiagnosticService(root).init();
  await service.record("ai.test", {
    model: "test-model",
    apiKey: "NEVER_WRITE_THIS_KEY",
    prompt: "NEVER_WRITE_THIS_PROMPT",
    url: "https://internal.example.test/v1"
  });
  const destination = path.join(root, "report.json");
  const result = await service.createReport({
    destinationPath: destination,
    environment: { appVersion: "0.2.0", platform: "win32", userDataPath: "C:\\Users\\alice\\AppData" },
    rooms: [{
      id: "cn.zhibian.test",
      name: "敏感项目名称",
      version: "1.0.0",
      source: "external",
      trust: "unknown",
      grantedPermissions: { database: "private", files: ["export"] }
    }]
  });
  assert.equal(result.eventCount, 1);
  const report = await fsp.readFile(destination, "utf8");
  assert.doesNotMatch(report, /NEVER_WRITE|internal\.example|alice|敏感项目名称/);
  assert.match(report, /cn\.zhibian\.test/);
  assert.match(report, /files\.export/);
});

test("diagnostic preview discloses included and excluded field groups without room names", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-diagnostics-preview-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new DiagnosticService(root).init();
  await service.record("room.open", { roomId: "cn.zhibian.preview" });
  const preview = await service.previewReport({
    environment: { appVersion: "0.2.0", platform: "win32" },
    rooms: [{
      id: "cn.zhibian.preview",
      name: "不可出现在预览中的房间名称",
      version: "1.0.0",
      source: "external",
      trust: "unknown",
      grantedPermissions: { database: "private", files: [], ai: { roles: [] } }
    }]
  });
  assert.equal(preview.roomCount, 1);
  assert.equal(preview.eventCount, 1);
  assert.ok(preview.includedFields.some((field) => field.includes("房间 ID")));
  assert.ok(preview.excludedFields.some((field) => field.includes("业务数据库")));
  assert.doesNotMatch(JSON.stringify(preview), /不可出现在预览中的房间名称/);
});
