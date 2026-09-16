"use strict";

function normalizeRoomTestDefinition(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") input = JSON.parse(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("room-tests.json 必须是对象");
  if (input.version !== 1) throw new Error("room-tests.json version 必须是 1");
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > 20) throw new Error("room-tests.json 必须包含 1–20 个场景");
  const scenarios = input.scenarios.map((scenario, scenarioIndex) => {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) throw new Error(`测试场景 ${scenarioIndex + 1} 无效`);
    const name = String(scenario.name || `场景 ${scenarioIndex + 1}`).slice(0, 100);
    if (!Array.isArray(scenario.actions) || scenario.actions.length < 1 || scenario.actions.length > 100) throw new Error(`测试场景 ${name} 必须包含 1–100 个动作`);
    const actions = scenario.actions.map((action, actionIndex) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error(`测试动作 ${actionIndex + 1} 无效`);
      const type = String(action.type || "");
      if (!["click", "input", "assertText", "assertExists", "wait"].includes(type)) throw new Error(`不支持的测试动作：${type}`);
      const normalized = { type };
      if (type !== "wait") {
        normalized.selector = String(action.selector || "").slice(0, 300);
        if (!normalized.selector) throw new Error(`测试动作 ${type} 缺少 selector`);
      }
      if (["input", "assertText"].includes(type)) normalized.value = String(action.value ?? "").slice(0, 5000);
      if (type === "wait") normalized.ms = Math.min(5000, Math.max(0, Number(action.ms) || 0));
      return normalized;
    });
    return { name, actions };
  });
  const ai = Array.isArray(input.mocks?.ai) ? input.mocks.ai.slice(0, 100).map((item) => ({ text: String(item?.text ?? item ?? "").slice(0, 100_000) })) : [];
  return { version: 1, scenarios, mocks: { ai } };
}

async function runDeclaredScenarios(webContents, definition) {
  if (!definition) return { passed: true, scenarios: [], skipped: true };
  const script = `(() => {
    const definition = ${JSON.stringify(definition)};
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    return (async () => {
      const completed = [];
      for (const scenario of definition.scenarios) {
        for (const action of scenario.actions) {
          if (action.type === 'wait') { await sleep(action.ms); continue; }
          const element = document.querySelector(action.selector);
          if (!element) throw new Error('测试场景“' + scenario.name + '”找不到元素：' + action.selector);
          if (action.type === 'click') { element.click(); await sleep(100); }
          if (action.type === 'input') { element.value = action.value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }
          if (action.type === 'assertExists' && !element) throw new Error('元素不存在：' + action.selector);
          if (action.type === 'assertText' && !String(element.textContent || element.value || '').includes(action.value)) throw new Error('测试场景“' + scenario.name + '”文本断言失败：' + action.selector);
          const roomError = document.documentElement.dataset.roomError;
          if (roomError) throw new Error(roomError);
        }
        completed.push(scenario.name);
      }
      return { passed: true, scenarios: completed, skipped: false };
    })();
  })()`;
  try { return await webContents.executeJavaScript(script); }
  catch (error) { return { passed: false, scenarios: [], skipped: false, error: String(error.message || error).slice(0, 2000) }; }
}

module.exports = { normalizeRoomTestDefinition, runDeclaredScenarios };
