"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeFeedback, validateFeedback } = require("../pilot/pilot-feedback-core.js");

function feedback(testerId, overrides = {}) {
  return {
    kind: "zhibian-pilot-feedback",
    formatVersion: "0.1",
    testerId,
    createdAt: "2026-08-28T00:00:00.000Z",
    durationMinutes: 20,
    automaticVerdict: "PASS",
    tasks: {
      firstLaunch: "passed",
      exampleInstall: "passed",
      importPermissions: "passed",
      backupRestore: "passed",
      checkpointRestore: "passed",
      failedModificationRecovery: "passed",
      aiGenerate: "passed",
      diagnosticExport: "passed",
      ...overrides.tasks
    },
    observations: {
      offlineCompleted: true,
      uacPrompted: false,
      smartScreenOrAntivirus: false,
      helpNeeded: false,
      permissionConfusing: false,
      firstFailure: "",
      hardestWording: "",
      comment: "",
      ...overrides.observations
    },
    ...overrides,
    tasks: { firstLaunch: "passed", exampleInstall: "passed", importPermissions: "passed", backupRestore: "passed", checkpointRestore: "passed", failedModificationRecovery: "passed", aiGenerate: "passed", diagnosticExport: "passed", ...overrides.tasks },
    observations: { offlineCompleted: true, uacPrompted: false, smartScreenOrAntivirus: false, helpNeeded: false, permissionConfusing: false, firstFailure: "", hardestWording: "", comment: "", ...overrides.observations }
  };
}

test("pilot feedback keeps only bounded anonymous fields", () => {
  const normalized = validateFeedback({ ...feedback("P01"), unexpectedSecret: "DO_NOT_COPY" });
  assert.equal(normalized.testerId, "P01");
  assert.equal("unexpectedSecret" in normalized, false);
  assert.throws(() => validateFeedback(feedback("张三")), /测试人编号/);
});

test("pilot summary calculates phase targets and rejects duplicate testers", () => {
  const inputs = [feedback("P01"), feedback("P02"), feedback("P03"), feedback("P04"), feedback("P05")];
  const summary = summarizeFeedback(inputs);
  assert.equal(summary.sampleSize, 5);
  assert.equal(summary.targets.sampleSize.passed, true);
  assert.equal(summary.targets.firstLaunch.passed, true);
  assert.equal(summary.targets.failedModificationRecovery.passed, true);
  assert.equal(summary.targets.permissionConfusion.passed, true);

  const withDuplicate = summarizeFeedback([...inputs, feedback("P05")]);
  assert.equal(withDuplicate.sampleSize, 5);
  assert.equal(withDuplicate.invalidFileCount, 1);
  assert.match(withDuplicate.errors[0].message, /重复/);
});
