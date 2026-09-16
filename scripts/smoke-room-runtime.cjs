"use strict";
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RoomStore } = require("../src/main/room-store.cjs");
const { createCustomRoom } = require("../src/main/custom-room.cjs");
const { validateRoomRuntime, validateInstalledProgramRuntime } = require("../src/main/room-runtime-validator.cjs");
const sample = { formatVersion: "room-app@1", kind: "custom", name: "隔离启动检查", description: "仅测试隔离运行与错误拦截", hostModules: [], capabilities: { database: true, ai: false, files: [], network: [] }, files: { html: '<main><h1>隔离运行</h1><button id="save">保存</button></main>', css: "main{min-height:200px}", javascript: 'window.room.storage.set("test", "ok").then(()=>window.room.storage.get("test")).then(v=>{if(v!=="ok")throw new Error("存储未持久化")});document.getElementById("save").addEventListener("click",()=>{});' } };
(async () => {
  const healthy = await validateRoomRuntime({ spec: sample });
  assert.equal(healthy.passed, true, JSON.stringify(healthy));
  const broken = await validateRoomRuntime({ spec: { ...sample, files: { ...sample.files, javascript: 'document.getElementById("missing").addEventListener("click",()=>{});' } } });
  assert.equal(broken.passed, false);
  assert.match(JSON.stringify(broken), /null|addEventListener/);
  const brokenInteraction = await validateRoomRuntime({ spec: { ...sample, files: { ...sample.files, javascript: 'document.getElementById("save").addEventListener("click",()=>{throw new Error("按钮交互失败")});' } } });
  assert.equal(brokenInteraction.passed, false);
  assert.equal(brokenInteraction.checks.at(-1).id, "interactions");
  assert.match(JSON.stringify(brokenInteraction), /按钮交互失败/);
  const declaredSpec = {
    ...sample,
    name: "AI 场景检查",
    capabilities: { ...sample.capabilities, ai: { roles: ["general"], slots: { writer: { role: "general" } } } },
    files: {
      ...sample.files,
      html: '<main><h1>AI 场景</h1><button id="aiRun">AI 处理</button><p id="result"></p></main>',
      javascript: 'document.getElementById("aiRun").addEventListener("click",async()=>{const result=await window.room.ai.generate({slot:"writer",messages:[{role:"user",content:"测试"}]});document.getElementById("result").textContent=result.text;});',
      "room-tests.json": JSON.stringify({ version: 1, mocks: { ai: [{ text: "AI_SCENARIO_OK" }] }, scenarios: [{ name: "模型结果进入界面", actions: [{ type: "click", selector: "#aiRun" }, { type: "wait", ms: 200 }, { type: "assertText", selector: "#result", value: "AI_SCENARIO_OK" }] }] })
    }
  };
  const declared = await validateRoomRuntime({ spec: declaredSpec });
  assert.equal(declared.passed, true, JSON.stringify(declared));
  assert.equal(declared.checks.at(-1).id, "declared-scenarios");
  assert.deepEqual(declared.checks.at(-1).scenarios, ["模型结果进入界面"]);
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-installed-runtime-smoke-"));
  try {
    const store = await new RoomStore(dataRoot).init();
    const built = await createCustomRoom({ spec: sample, roomStore: store });
    const installed = await validateInstalledProgramRuntime({ programRoot: store.getProgramRoot(built.room.id) });
    assert.equal(installed.passed, true, JSON.stringify(installed));
  } finally {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
  await assert.rejects(validateRoomRuntime({ spec: { ...sample, files: { ...sample.files, javascript: 'document.getElementById("save"); while(true) {}' } }, timeoutMs: 6000 }), /超时/);
  console.log("ROOM_RUNTIME_SMOKE_OK startup/reload/interactions/declared scenarios, installed multi-file program, real SQLite, startup and button error rejection, infinite loop timeout");
})().catch(error => { console.error(error); process.exitCode = 1; });
