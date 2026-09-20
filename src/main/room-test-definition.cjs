"use strict";

function normalizeRoomTestDefinition(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") input = JSON.parse(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("room-tests.json 必须是对象");
  if (input.version !== 1) throw new Error("room-tests.json version 必须是 1");
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1) throw new Error("room-tests.json 必须包含至少一个场景");
  const scenarios = input.scenarios.map((scenario, scenarioIndex) => {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) throw new Error(`测试场景 ${scenarioIndex + 1} 无效`);
    const name = String(scenario.name || `场景 ${scenarioIndex + 1}`).slice(0, 100);
    if (!Array.isArray(scenario.actions) || scenario.actions.length < 1 || scenario.actions.length > 100) throw new Error(`测试场景 ${name} 必须包含 1–100 个动作`);
    const actions = scenario.actions.map((action, actionIndex) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error(`测试动作 ${actionIndex + 1} 无效`);
      const type = String(action.type || "");
      if (!["click", "input", "assertText", "assertExists", "wait", "reload"].includes(type)) throw new Error(`不支持的测试动作：${type}`);
      const normalized = { type };
      if (type === "click" && action.count !== undefined) {
        if (!Number.isSafeInteger(action.count) || action.count < 1 || action.count > 30) throw new Error("连续点击 count 必须是 1–30 的整数");
        normalized.count = action.count;
      }
      if (!["wait", "reload"].includes(type)) {
        normalized.selector = String(action.selector || "").slice(0, 300);
        if (!normalized.selector) throw new Error(`测试动作 ${type} 缺少 selector`);
      }
      if (["input", "assertText"].includes(type)) normalized.value = String(action.value ?? "").slice(0, 5000);
      if (type === "wait") normalized.ms = Math.min(5000, Math.max(0, Number(action.ms) || 0));
      return normalized;
    });
    return { name, actions };
  });
  for (const item of Array.isArray(input.mocks?.ai) ? input.mocks.ai : []) {
    if (item?.expectedImageCount !== undefined && (!Number.isSafeInteger(item.expectedImageCount) || item.expectedImageCount < 0 || item.expectedImageCount > 100)) throw new Error("expectedImageCount 必须是 0–100 的整数");
  }
  const ai = Array.isArray(input.mocks?.ai) ? input.mocks.ai.slice(0, 100).map((item) => ({
    text: String(item?.text ?? item ?? "").slice(0, 100_000),
    ...(item?.expectedImageCount === undefined ? {} : { expectedImageCount: item.expectedImageCount }),
    ...(typeof item?.error === "string" && item.error ? { error: item.error.slice(0, 2000) } : {}),
    ...(item?.chunkDelayMs === undefined ? {} : { chunkDelayMs: Math.min(1000, Math.max(0, Number(item.chunkDelayMs) || 0)) })
  })) : [];
  const files = [];
  let fileBytes = 0;
  if (input.mocks?.files !== undefined) {
    if (!Array.isArray(input.mocks.files) || input.mocks.files.length > 20) throw new Error("测试文件必须是最多 20 项的数组");
    const names = new Set();
    for (const file of input.mocks.files) {
      if (!file || typeof file.name !== "string" || !/^[^\\/:*?"<>|\x00-\x1f]{1,120}$/.test(file.name) || /[. ]$/.test(file.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name)) throw new Error("测试文件名必须是安全的单个文件名");
      if (names.has(file.name.toLowerCase())) throw new Error("测试文件名重复");
      names.add(file.name.toLowerCase());
      if ((typeof file.text === "string") === (typeof file.base64 === "string")) throw new Error("测试文件必须且只能提供 text 或 base64");
      if (file.base64 !== undefined && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))) throw new Error("测试文件 base64 无效");
      const bytes = file.base64 === undefined ? Buffer.from(file.text, "utf8") : Buffer.from(file.base64, "base64");
      fileBytes += bytes.length;
      if (fileBytes > 2 * 1024 * 1024) throw new Error("测试文件总计最多 2 MiB");
      files.push({ name: file.name, base64: bytes.toString("base64") });
    }
  }
  return { version: 1, scenarios, mocks: { ai, files } };
}

async function runDeclaredScenarios(webContents, definition) {
  if (!definition) return { passed: true, scenarios: [], skipped: true };
  const completed = [];
  try {
    for (const scenario of definition.scenarios) {
      for (const action of scenario.actions) {
        if (action.type === "reload") {
          // Reload the same installed room; its private database survives while JS memory does not.
          await webContents.loadURL(webContents.getURL());
          await webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const started = Date.now();
            const check = () => {
              const error = document.documentElement.dataset.roomError;
              if (error) return reject(new Error(error));
              if (document.documentElement.dataset.roomReady === 'true') return resolve();
              if (Date.now() - started > 12000) return reject(new Error('重载后初始化未完成'));
              setTimeout(check, 50);
            };
            check();
          })`);
          continue;
        }
        await webContents.executeJavaScript(`(async () => {
          const action = ${JSON.stringify(action)};
          const scenarioName = ${JSON.stringify(scenario.name)};
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          if (action.type === 'wait') { await sleep(action.ms); return; }
          const element = document.querySelector(action.selector);
          if (!element) throw new Error('测试场景“' + scenarioName + '”找不到元素：' + action.selector + '；当前页面：' + String(document.body.innerText || '').slice(-800));
          if (action.type === 'click') { for (let i = 0; i < (action.count || 1); i += 1) element.click(); await sleep(100); }
          if (action.type === 'input') {
            element.value = action.value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (action.type === 'assertText') {
            const actual = String(element.textContent || element.value || '');
            if (!actual.includes(action.value)) throw new Error('测试场景“' + scenarioName + '”文本断言失败：' + action.selector + '；期望包含 ' + JSON.stringify(action.value.slice(0, 120)) + '，实际为 ' + JSON.stringify(actual.slice(0, 300)) + '；当前页面：' + String(document.body.innerText || '').slice(-1000));
          }
          const roomError = document.documentElement.dataset.roomError;
          if (roomError) throw new Error(roomError);
        })()`);
      }
      completed.push(scenario.name);
    }
    return { passed: true, scenarios: completed, skipped: false };
  } catch (error) { return { passed: false, scenarios: completed, skipped: false, error: String(error.message || error).slice(0, 2000) }; }
}

module.exports = { normalizeRoomTestDefinition, runDeclaredScenarios };
