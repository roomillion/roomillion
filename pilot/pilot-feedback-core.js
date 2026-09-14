(function exposePilotFeedback(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PilotFeedback = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPilotFeedback() {
  "use strict";

  const TASK_KEYS = Object.freeze([
    "firstLaunch",
    "exampleInstall",
    "importPermissions",
    "backupRestore",
    "checkpointRestore",
    "failedModificationRecovery",
    "aiGenerate",
    "diagnosticExport"
  ]);
  const TASK_STATUSES = new Set(["passed", "failed", "skipped"]);
  const VERDICTS = new Set(["PASS", "FAIL", "NOT_RUN"]);

  function cleanText(value, limit) {
    return String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, limit);
  }

  function optionalBoolean(value, field) {
    if (value === true || value === false || value === null) return value;
    throw new Error(`${field} 必须是是、否或未记录`);
  }

  function validateFeedback(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("反馈文件不是对象");
    if (input.kind !== "zhibian-pilot-feedback" || input.formatVersion !== "0.1") throw new Error("反馈格式版本不支持");
    const testerId = cleanText(input.testerId, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(testerId)) throw new Error("测试人编号只能使用字母、数字、下划线和短横线");
    const createdAt = new Date(input.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error("测试时间无效");
    const durationMinutes = Number(input.durationMinutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0 || durationMinutes > 1440) throw new Error("测试耗时无效");
    const automaticVerdict = String(input.automaticVerdict ?? "NOT_RUN");
    if (!VERDICTS.has(automaticVerdict)) throw new Error("自动验收结果无效");
    const tasks = {};
    for (const key of TASK_KEYS) {
      const status = String(input.tasks?.[key] ?? "skipped");
      if (!TASK_STATUSES.has(status)) throw new Error(`任务 ${key} 状态无效`);
      tasks[key] = status;
    }
    return {
      kind: "zhibian-pilot-feedback",
      formatVersion: "0.1",
      testerId,
      createdAt: createdAt.toISOString(),
      durationMinutes,
      automaticVerdict,
      tasks,
      observations: {
        offlineCompleted: optionalBoolean(input.observations?.offlineCompleted ?? null, "断网结果"),
        uacPrompted: optionalBoolean(input.observations?.uacPrompted ?? null, "UAC 结果"),
        smartScreenOrAntivirus: optionalBoolean(input.observations?.smartScreenOrAntivirus ?? null, "安全软件结果"),
        helpNeeded: optionalBoolean(input.observations?.helpNeeded ?? null, "求助结果"),
        permissionConfusing: optionalBoolean(input.observations?.permissionConfusing ?? null, "权限文案结果"),
        firstFailure: cleanText(input.observations?.firstFailure, 500),
        hardestWording: cleanText(input.observations?.hardestWording, 500),
        comment: cleanText(input.observations?.comment, 800)
      }
    };
  }

  function statusMetric(records, key) {
    const eligible = records.filter((record) => record.tasks[key] !== "skipped");
    const passed = eligible.filter((record) => record.tasks[key] === "passed").length;
    return { passed, total: eligible.length, rate: eligible.length ? passed / eligible.length : null };
  }

  function booleanMetric(records, key, desiredValue) {
    const eligible = records.filter((record) => typeof record.observations[key] === "boolean");
    const matching = eligible.filter((record) => record.observations[key] === desiredValue).length;
    return { matching, total: eligible.length, rate: eligible.length ? matching / eligible.length : null };
  }

  function summarizeFeedback(inputs) {
    const records = [];
    const errors = [];
    const seen = new Set();
    for (let index = 0; index < inputs.length; index += 1) {
      try {
        const record = validateFeedback(inputs[index]);
        if (seen.has(record.testerId)) throw new Error(`测试人编号重复：${record.testerId}`);
        seen.add(record.testerId);
        records.push(record);
      } catch (error) {
        errors.push({ index, message: error.message });
      }
    }
    const metrics = {
      firstLaunch: statusMetric(records, "firstLaunch"),
      exampleInstall: statusMetric(records, "exampleInstall"),
      backupRestore: statusMetric(records, "backupRestore"),
      checkpointRestore: statusMetric(records, "checkpointRestore"),
      failedModificationRecovery: statusMetric(records, "failedModificationRecovery"),
      permissionConfusion: booleanMetric(records, "permissionConfusing", true),
      helpNeeded: booleanMetric(records, "helpNeeded", true),
      offlineCompleted: booleanMetric(records, "offlineCompleted", true)
    };
    return {
      kind: "zhibian-pilot-summary",
      formatVersion: "0.1",
      createdAt: new Date().toISOString(),
      sampleSize: records.length,
      invalidFileCount: errors.length,
      errors,
      metrics,
      targets: {
        sampleSize: { required: 5, passed: records.length >= 5 },
        firstLaunch: { required: 0.95, passed: metrics.firstLaunch.rate !== null && metrics.firstLaunch.rate >= 0.95 },
        exampleInstall: { required: 0.90, passed: metrics.exampleInstall.rate !== null && metrics.exampleInstall.rate >= 0.90 },
        backupRestore: { required: 0.95, passed: metrics.backupRestore.rate !== null && metrics.backupRestore.rate >= 0.95 },
        checkpointRestore: { required: 0.95, passed: metrics.checkpointRestore.rate !== null && metrics.checkpointRestore.rate >= 0.95 },
        failedModificationRecovery: { required: 1, passed: metrics.failedModificationRecovery.rate !== null && metrics.failedModificationRecovery.rate === 1 },
        permissionConfusion: { requiredBelow: 0.10, passed: metrics.permissionConfusion.rate !== null && metrics.permissionConfusion.rate < 0.10 }
      }
    };
  }

  return Object.freeze({ TASK_KEYS, summarizeFeedback, validateFeedback });
});
