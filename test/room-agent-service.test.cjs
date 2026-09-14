"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { GitService } = require("../src/main/git-service.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");
const { readProjectFile } = require("../src/main/project-source.cjs");
const { RoomAgentService: ProductionRoomAgentService, compactAgentContext } = require("../src/main/room-agent-service.cjs");
// Unit tests isolate Electron; the real subprocess validator has separate smoke coverage.
class RoomAgentService extends ProductionRoomAgentService {
  constructor(options) { super({ runtimeValidator: async () => ({ passed: true, kind: "unit-test-stub" }), ...options }); }
}
const { getTestGitToolchain } = require("../test-support/bundled-git.cjs");

test("project migration requires assessment, explicit mode and approval; original source and notices survive", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-project-migration-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  await fsp.mkdir(sourceRoot);
  const original = "<main><h1>Original game</h1></main>";
  await fsp.writeFile(path.join(sourceRoot, "index.html"), original);
  await fsp.writeFile(path.join(sourceRoot, "LICENSE"), "Original project copyright and permission");
  const store = await new RoomStore(path.join(root, "data")).init();
  const options = { roomStore: store, aiService: { getPublicProfile: () => ({ id: "test", model: "test", hasSessionKey: true }) } };
  const service = await new RoomAgentService(options).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession()).id);
  const imported = await service.importSourceProject(session.id, sourceRoot);
  assert.equal(imported.sourceProject.files.length, 2);
  assert.equal(JSON.stringify(imported).includes(original), false);
  await assert.rejects(service.importSourceProject(session.id, sourceRoot), /新建房间对话/);
  const pi = await import("@earendil-works/pi-ai");
  const tools = service.createTools(session, { pi });
  const invoke = (name, args) => tools.find(tool => tool.name === name).execute("test", args, new AbortController().signal);
  const plan = { ...Object.fromEntries(["overview", "features", "usage", "data", "permissions", "steps", "acceptance", "limitations"].map(key => [key, "测试迁移方案说明：保留原来的游戏交互。"])), usesAi: false };
  session.workflow.answered = true;
  await assert.rejects(invoke("propose_room_plan", plan), /评估/);
  const assessment = { recommendation: "unsupported", ...Object.fromEntries(["summary", "evidence", "preserved", "changes", "dependencies", "risks", "acceptance"].map(key => [key, "测试评估说明：需检查原项目差异。 "])) };
  await assert.rejects(invoke("assess_project_migration", assessment), /读取项目/);
  await invoke("inspect_source_project", {});
  await invoke("read_source_project_file", { path: "index.html" });
  await invoke("assess_project_migration", assessment);
  await assert.rejects(invoke("propose_room_plan", { ...plan, migrationMode: "adapt" }), /难以迁移/);
  await invoke("assess_project_migration", { ...assessment, recommendation: "refactor" });
  await assert.rejects(invoke("propose_room_plan", { ...plan, migrationMode: "adapt" }), /需要重构/);
  await invoke("propose_room_plan", { ...plan, migrationMode: "refactor" });
  await assert.rejects(invoke("draft_custom_room", { appSpecJson: JSON.stringify(freeBilliardsSpec()) }), /用户确认/);
  service.run = async () => {};
  await service.send(session.id, { approvePlanId: session.workflow.plan.id });
  await assert.rejects(invoke("build_room", {}), /自由房间/);
  await invoke("draft_custom_room", { appSpecJson: JSON.stringify(freeBilliardsSpec()) });
  await invoke("test_custom_room", {});
  await invoke("install_custom_room", {});
  assert.ok(session.roomId);
  assert.equal(await fsp.readFile(path.join(sourceRoot, "index.html"), "utf8"), original);
  const provenancePath = await store.resolveProgramFile(session.roomId, "project-migration.json");
  const provenance = JSON.parse(await fsp.readFile(provenancePath, "utf8"));
  assert.equal(provenance.mode, "refactor");
  assert.equal(provenance.notices[0].content, "Original project copyright and permission");
  // A later non-migration editor must not discard the collected notices.
  const { createCustomRoom } = require("../src/main/custom-room.cjs");
  await createCustomRoom({ spec: freeBilliardsSpec(), roomStore: store, roomId: session.roomId, version: "1.0.1" });
  assert.deepEqual(JSON.parse(await fsp.readFile(await store.resolveProgramFile(session.roomId, "project-migration.json"), "utf8")), provenance);
  const restored = await new RoomAgentService(options).init();
  t.after(() => restored.dispose());
  assert.equal(restored.getSession(session.id).sourceProject.id, imported.sourceProject.id);
  assert.equal((await readProjectFile(restored.requireSession(session.id).sourceProject, "index.html")).content, original);
});

test("split drafts survive restart and new requirements invalidate tests without losing files", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-draft-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const profile = { id: "test", name: "Test", model: "test", hasSessionKey: true };
  const options = { roomStore: store, aiService: { getPublicProfile: () => profile }, gitService: {} };
  const service = await new RoomAgentService(options).init();
  const session = service.requireSession((await service.createSession()).id);
  session.workflow = { phase: "implementing", plan: { id: "plan" }, approvedPlanId: "plan" };
  const pi = await import("@earendil-works/pi-ai");
  const tools = service.createTools(session, { pi });
  const invoke = (name, params) => tools.find(tool => tool.name === name).execute("test", params, new AbortController().signal);
  const spec = freeBilliardsSpec();
  await invoke("begin_custom_room", spec);
  let revision = 1;
  for (const [file, content] of Object.entries(spec.files)) await invoke("write_custom_room_file", { file, content, expectedRevision: revision++ });
  await invoke("test_custom_room", {});
  assert.equal(session.customDraft.tested, true);
  const restored = await new RoomAgentService(options).init();
  const restoredSession = restored.requireSession(session.id);
  assert.equal(restoredSession.customWorkspace.files.javascript, spec.files.javascript);
  assert.equal(restoredSession.workflow.phase, "review");
  restored.run = async () => {};
  await restored.send(session.id, "把标题改短一点，其他不改");
  assert.equal(restoredSession.customDraft.tested, false);
  assert.equal(restoredSession.customWorkspace.files.javascript, spec.files.javascript);
  assert.equal(restoredSession.workflow.approvedPlanId, null);
  await service.dispose(); await restored.dispose();
});

test("room modification can inspect and page through only the installed program copy during clarification", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-current-room-read-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const { createCustomRoom } = require("../src/main/custom-room.cjs");
  const built = await createCustomRoom({ spec: freeBilliardsSpec(), roomStore: store });
  const service = await new RoomAgentService({ roomStore: store, aiService: { getPublicProfile: () => ({ id: "test", model: "test", hasSessionKey: true }) } }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession({ roomId: built.room.id })).id);
  const pi = await import("@earendil-works/pi-ai");
  const tools = service.createTools(session, { pi });
  const inspect = tools.find((tool) => tool.name === "inspect_current_room");
  const read = tools.find((tool) => tool.name === "read_current_room_file");
  assert.ok(inspect && read);
  const firstIndexPage = JSON.parse((await inspect.execute("inspect", { pageSize: 2 }, new AbortController().signal)).content[0].text);
  assert.equal(firstIndexPage.files.length, 2);
  assert.equal(firstIndexPage.complete, false);
  assert.equal(firstIndexPage.nextCursor, 2);
  const remainingIndex = JSON.parse((await inspect.execute("inspect-next", { cursor: firstIndexPage.nextCursor, pageSize: 50 }, new AbortController().signal)).content[0].text);
  const indexedPaths = [...firstIndexPage.files, ...remainingIndex.files].map((file) => file.path);
  assert.ok(indexedPaths.includes("app/app.js"));
  assert.equal(remainingIndex.complete, true);
  const page = JSON.parse((await read.execute("read", { path: "app/app.js", offset: 0 }, new AbortController().signal)).content[0].text);
  assert.match(page.content, /THREE\.Scene/);
  assert.equal(JSON.stringify(page).includes(store.getDataRoot(built.room.id)), false);
  await assert.rejects(() => read.execute("bad", { path: "../../data/room.sqlite" }, new AbortController().signal), /没有该程序文件/);
  session.workflow = { phase: "clarifying", answered: true };
  await tools.find((tool) => tool.name === "propose_room_plan").execute("plan", testPlan, new AbortController().signal);
  assert.equal(session.workflow.phase, "review");
});

test("room program inspection includes multi-file modules and update drops obsolete grants safely", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-multifile-permissions-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const { createCustomRoom } = require("../src/main/custom-room.cjs");
  const original = freeBilliardsSpec();
  original.capabilities.files = ["pick", "export"];
  const built = await createCustomRoom({ spec: original, roomStore: store });
  const extraPath = await store.resolveProgramFile(built.room.id, "app/store.js");
  await fsp.writeFile(extraPath, "export const marker = 'multi-file';\n", "utf8");
  const service = await new RoomAgentService({ roomStore: store, aiService: { getPublicProfile: () => ({ id: "test", model: "test", hasSessionKey: true }) } }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession({ roomId: built.room.id })).id);
  session.workflow = { phase: "implementing", answered: true, plan: { ...testPlan, id: "plan" }, approvedPlanId: "plan" };
  const pi = await import("@earendil-works/pi-ai");
  const tools = service.createTools(session, { pi });
  const inspected = JSON.parse((await tools.find((tool) => tool.name === "inspect_current_room").execute("inspect", {}, new AbortController().signal)).content[0].text);
  assert.ok(inspected.files.some((file) => file.path === "app/store.js"));
  const source = JSON.parse((await tools.find((tool) => tool.name === "read_current_room_file").execute("read", { path: "app/store.js" }, new AbortController().signal)).content[0].text);
  assert.match(source.content, /multi-file/);
  const updated = freeBilliardsSpec();
  updated.capabilities.files = ["pick"];
  await tools.find((tool) => tool.name === "draft_custom_room").execute("draft", { appSpecJson: JSON.stringify(updated) }, new AbortController().signal);
  await tools.find((tool) => tool.name === "test_custom_room").execute("test", {}, new AbortController().signal);
  await tools.find((tool) => tool.name === "install_custom_room").execute("install", {}, new AbortController().signal);
  assert.deepEqual(store.getRoom(built.room.id).grantedPermissions.files, ["pick"]);
});

test("installed multi-file rooms can be patched, tested in a temporary copy and upgraded in place", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-program-patch-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const { createCustomRoom } = require("../src/main/custom-room.cjs");
  const original = freeBilliardsSpec();
  original.capabilities.files = ["pick"];
  const built = await createCustomRoom({ spec: original, roomStore: store });
  const validationRoots = [];
  const service = await new RoomAgentService({
    roomStore: store,
    aiService: { getPublicProfile: () => ({ id: "test", model: "test", hasSessionKey: true }) },
    installedProgramValidator: async ({ programRoot }) => {
      validationRoots.push(programRoot);
      assert.match(await fsp.readFile(path.join(programRoot, "app", "app.js"), "utf8"), /speed=\.12/);
      return { passed: true, kind: "unit-test-program" };
    }
  }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession({ roomId: built.room.id })).id);
  session.workflow = { phase: "implementing", answered: true, plan: { ...testPlan, id: "plan" }, approvedPlanId: "plan" };
  const pi = await import("@earendil-works/pi-ai");
  const tools = service.createTools(session, { pi });
  const invoke = (name, params = {}) => tools.find((tool) => tool.name === name).execute(name, params, new AbortController().signal);
  await invoke("inspect_current_room");
  await invoke("read_current_room_file", { path: "app/app.js" });
  await invoke("patch_current_room_file", { path: "app/app.js", find: "speed=.08", replacement: "speed=.12", expectedRevision: 1 });
  assert.doesNotMatch(await fsp.readFile(await store.resolveProgramFile(built.room.id, "app/app.js"), "utf8"), /speed=\.12/);
  await invoke("test_current_room_patch");
  assert.equal(validationRoots.length, 1);
  await invoke("install_current_room_patch");
  assert.equal(store.getRoom(built.room.id).version, "1.0.1");
  assert.match(await fsp.readFile(await store.resolveProgramFile(built.room.id, "app/app.js"), "utf8"), /speed=\.12/);
  assert.deepEqual(store.getRoom(built.room.id).grantedPermissions.files, ["pick"]);
  assert.equal(session.programPatch, null);
});

test("Agent context compaction removes old thinking signatures and saved source payloads", () => {
  const huge = "x".repeat(30000);
  const compacted = compactAgentContext([
    { role: "user", content: "旧需求", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: huge, thinkingSignature: huge }, { type: "text", text: "已了解" }], timestamp: 2 },
    { role: "user", content: "开始实施", timestamp: 3 },
    { role: "assistant", content: [{ type: "thinking", thinking: huge, thinkingSignature: huge }, { type: "toolCall", id: "write", name: "write_custom_room_file", arguments: { file: "javascript", content: huge } }], timestamp: 4 },
    { role: "toolResult", toolCallId: "write", toolName: "write_custom_room_file", content: [{ type: "text", text: "saved" }] },
    { role: "assistant", content: [{ type: "text", text: "继续测试" }], timestamp: 5 }
  ]);
  const serialized = JSON.stringify(compacted);
  assert.ok(serialized.length < 5000);
  assert.doesNotMatch(serialized, /thinkingSignature/);
  assert.match(serialized, /内容已由 Harness 保存/);
});

test("slash commands expose harness status, switch models and persist semantic compaction", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-commands-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const profiles = [
    { id: "first", label: "主模型", name: "Provider A", model: "model-a", hasSessionKey: true },
    { id: "second", label: "审查模型", name: "Provider B", model: "model-b", hasSessionKey: true }
  ];
  const aiService = {
    getPublicProfile: (id = "first") => profiles.find((item) => item.id === id) || null,
    listPublicProfiles: () => profiles,
    getModelCapabilities: async () => ({ contextWindow: 128000 }),
    complete: async () => ({ text: "目标\n保留当前修改。\n约束\n不联网。\n已确认决定\n按方案实施。\n进度与证据\n已读取入口。\n问题与风险\n尚未测试。\n下一步\n完成修改并测试。", usage: { input: 20, output: 10, totalTokens: 30 } })
  };
  const service = await new RoomAgentService({ roomStore: store, aiService }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession({ profileId: "first" })).id);
  session.agentMessages = [{ role: "user", content: "旧任务", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "已读取入口" }], stopReason: "stop", timestamp: 2 }];
  assert.match((await service.send(session.id, "/help")).session.messages.at(-1).content, /\/compact/);
  assert.match((await service.send(session.id, "/models")).session.messages.at(-1).content, /model-b/);
  await service.send(session.id, "/model second");
  assert.equal(service.getSession(session.id).profileId, "second");
  assert.match((await service.send(session.id, "/context")).session.messages.at(-1).content, /tokens/);
  const compacted = await service.send(session.id, "/compact");
  assert.equal(compacted.session.context.hasSummary, true);
  assert.equal(compacted.session.context.compaction.count, 1);
  assert.match(service.requireSession(session.id).contextSummary, /下一步/);
});

test("continue after clarification accepts recommended answers without becoming a new requirement", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-defaults-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const profile = { id: "test", name: "Test", model: "test", hasSessionKey: true };
  const service = await new RoomAgentService({ roomStore: store, aiService: { getPublicProfile: () => profile } }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession()).id);
  session.latestUserGoal = "修复文本分段并增加预览";
  session.messages.push({ id: "u1", role: "user", content: session.latestUserGoal, attachments: [], status: "sent", createdAt: new Date().toISOString() });
  session.workflow = { phase: "clarifying", questions: [{ id: "q1" }], askedAtMessage: 1 };
  let received = "";
  service.run = async (_session, prompt) => { received = prompt; };
  await service.send(session.id, "继续");
  assert.match(received, /接受.*推荐答案/);
  assert.equal(session.latestUserGoal, "修复文本分段并增加预览");
  assert.equal(session.workflow.answered, true);
});

test("implementation can delegate multiple read-only reviews to child Pi agents", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-subagent-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const profile = { id: "test", name: "Test", model: "test", hasSessionKey: true };
  let childTools = [];
  class ChildAgent {
    constructor(options) { this.options = options; this.listeners = []; this.state = { messages: [] }; childTools = options.initialState.tools.map((tool) => tool.name); }
    subscribe(listener) { this.listeners.push(listener); }
    async prompt(task) { this.state.messages.push({ role: "user", content: task }, { role: "assistant", content: [{ type: "text", text: "结论：修改点可行。证据：入口已核对。风险：需回归。建议：先局部修复再测试。" }] }); }
    abort() {}
  }
  const service = await new RoomAgentService({ roomStore: store, aiService: { getPublicProfile: () => profile } }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession()).id);
  session.workflow = { phase: "implementing", plan: { id: "plan" }, approvedPlanId: "plan" };
  const pi = await import("@earendil-works/pi-ai");
  const runtime = { pi, model: { id: "test" }, streamFn: () => {}, agentModule: { Agent: ChildAgent }, harnessState: { subagentCount: 0 } };
  const tool = service.createTools(session, runtime).find((item) => item.name === "delegate_room_task");
  const invoke = () => tool.execute("delegate", { role: "代码审查", task: "检查当前实现可能遗漏的回归场景并给出证据" }, new AbortController().signal);
  assert.match((await invoke()).content[0].text, /修改点可行/);
  assert.deepEqual(childTools.sort(), ["inspect_current_room", "inspect_room_capabilities", "inspect_source_project", "read_current_room_file", "read_source_project_file"].sort());
  assert.equal(session.subagents.at(-1).status, "complete");
  await invoke(); await invoke(); await invoke();
  assert.equal(session.subagents.length, 4);
});

test("AI rooms require explicit test consent and use only the selected model when authorized", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-authorized-ai-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const calls = [];
  const profiles = new Map([
    ["builder", { id: "builder", model: "builder-model", label: "编程模型", hasSessionKey: true }],
    ["room-test", { id: "room-test", model: "room-model", label: "房间测试模型", hasSessionKey: true }]
  ]);
  const aiService = {
    getPublicProfile: (id = "builder") => profiles.get(id) || null,
    complete: async options => {
      calls.push(options);
      return { text: options.prompt.match(/ZB-[a-f0-9]+/)[0], usage: { input: 9, output: 2 }, model: "room-model" };
    }
  };
  const service = await new RoomAgentService({ roomStore: store, aiService }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession({ profileId: "builder" })).id);
  const aiPlan = { ...testPlan, usesAi: true, aiTestPurpose: "验证摘要调用" };
  session.workflow = { phase: "review", answered: true, plan: { ...aiPlan, id: "ai-plan" }, approvedPlanId: null };
  service.run = async () => {};
  await assert.rejects(() => service.send(session.id, { approvePlanId: "ai-plan" }), /明确选择/);
  await service.send(session.id, { approvePlanId: "ai-plan", aiTest: { enabled: true, profileId: "room-test" } });
  const pi = await import("@earendil-works/pi-ai");
  const tools = service.createTools(session, { pi });
  const spec = freeBilliardsSpec();
  spec.capabilities.ai = true;
  spec.files.javascript += `\ndocument.getElementById("restart").addEventListener("dblclick",async()=>{await window.room.ai.generate("测试")});`;
  await tools.find((tool) => tool.name === "draft_custom_room").execute("draft", { appSpecJson: JSON.stringify(spec) }, new AbortController().signal);
  const tested = await tools.find((tool) => tool.name === "test_custom_room").execute("test", {}, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileId, "room-test");
  assert.equal(tested.details.aiTest.passed, true);
});

test("runtime errors block install and tool generation streams report progress and budget stops", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-runtime-gate-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const events = [];
  const service = await new RoomAgentService({ roomStore: store, aiService: { getPublicProfile: () => null }, gitService: {}, onEvent: event => events.push(event), runtimeValidator: async () => ({ passed: false, error: "缺少 DOM 元素" }), runLimits: { maxTokens: 10 } }).init();
  const session = service.requireSession((await service.createSession()).id);
  session.workflow = { phase: "implementing", plan: { id: "plan" }, approvedPlanId: "plan" };
  const pi = await import("@earendil-works/pi-ai");
  const tools = service.createTools(session, { pi });
  const invoke = (name, params) => tools.find(tool => tool.name === name).execute("test", params, new AbortController().signal);
  await invoke("draft_custom_room", { appSpecJson: JSON.stringify(freeBilliardsSpec()) });
  await assert.rejects(invoke("test_custom_room", {}), /缺少 DOM/);
  await assert.rejects(invoke("install_custom_room", {}), /尚未通过测试/);
  assert.equal(store.listRooms().length, 0);
  const run = { tokens: { totalTokens: 0 }, requests: 0, planId: "plan" };
  session.runs = [run];
  const state = { run, seenUsage: new WeakSet() };
  const agent = { abort() { this.aborted = true; }, clearAllQueues() {} };
  await service.handleAgentEvent(session, {}, agent, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "123456" } }, state);
  assert.ok(events.some(event => event.type === "activity" && /6 字符/.test(event.label)));
  await service.handleAgentEvent(session, { pi: { contentText: () => "" } }, agent, { type: "message_end", message: { role: "assistant", content: [], usage: { input: 20, output: 1, totalTokens: 21 } } }, state);
  assert.equal(agent.aborted, true);
  assert.match(run.limitReason, /预算/);
  await service.dispose();
});

test("missing provider usage is normalized before Pi starts the next tool turn", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-missing-usage-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(root).init();
  const service = await new RoomAgentService({ roomStore: store, aiService: { getPublicProfile: () => null } }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession()).id);
  const run = {};
  session.runs = [run];
  const state = { run, seenUsage: new WeakSet() };
  const message = { role: "assistant", content: [{ type: "toolCall", id: "read", name: "read_current_room_file", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() };
  await service.handleAgentEvent(session, { pi: { contentText: () => "" } }, { abort() {}, clearAllQueues() {} }, { type: "message_end", message }, state);
  assert.deepEqual(message.usage, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  });
  assert.equal(run.missingUsage, 1);
  const hydrated = await service.hydrateAgentMessages({ ...session, agentMessages: [{ role: "assistant", content: [], stopReason: "stop" }] });
  assert.equal(hydrated[0].usage.totalTokens, 0);
});

test("manual conversation titles persist and automatic titles follow built rooms", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-title-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const options = { roomStore, aiService: { getPublicProfile: () => ({ model: "fake" }) } };
  const service = await new RoomAgentService(options).init();
  const created = await service.createSession();
  const session = service.requireSession(created.id);
  const room = { id: "demo", name: "坦克游戏", version: "1.0.0", hostModules: [] };
  await service.afterRoomBuilt(session, room, {});
  assert.equal(session.title, "坦克游戏");
  await assert.rejects(service.renameSession(session.id, "  "), /1–80/);
  await assert.rejects(service.renameSession(session.id, "字".repeat(81)), /1–80/);
  await service.renameSession(session.id, "我的游戏");
  const restored = await new RoomAgentService(options).init();
  const restoredSession = restored.requireSession(session.id);
  assert.equal(restoredSession.manualTitle, true);
  await restored.afterRoomBuilt(restoredSession, { ...room, name: "新版游戏" }, {});
  assert.equal(restoredSession.title, "我的游戏");
});

function roomSpec({ modified = false } = {}) {
  return {
    specVersion: "room-spec@1",
    kind: "composed",
    name: modified ? "项目风险与问题中心" : "项目问题跟踪中心",
    description: "集中登记、分析和跟踪项目问题，支持离线统计与数据交换",
    theme: modified ? "violet" : "blue",
    data: [{
      id: "issues",
      label: "项目问题",
      fields: [
        { key: "title", label: "问题标题", type: "text", required: true },
        { key: "owner", label: "负责人", type: "text", required: false },
        { key: "status", label: "处理状态", type: "select", required: true, options: ["待处理", "处理中", "已解决"] },
        { key: "priority", label: "优先级", type: "select", required: true, options: ["高", "中", "低"] },
        { key: "cost", label: "影响金额", type: "number", required: false },
        { key: "deadline", label: "截止日期", type: "date", required: false },
        ...(modified ? [{ key: "risk", label: "风险说明", type: "textarea", required: false }] : [])
      ],
      seed: []
    }],
    actions: [
      { id: "resolve", type: "set-field", label: "标记解决", source: "issues", field: "status", value: "已解决", tone: "success" },
      { id: "remove", type: "delete", label: "删除", source: "issues", tone: "danger" }
    ],
    pages: [
      {
        id: "overview",
        title: "项目概览",
        layout: "grid",
        columns: 2,
        components: [
          { id: "intro", type: "hero", title: modified ? "风险与问题中心" : "问题跟踪中心", text: "本地管理项目问题", badge: "离线可用", span: 2 },
          { id: "issue_stats", type: "stats", title: "问题统计", source: "issues", metrics: [{ label: "问题总数", aggregate: "count" }, { label: "影响金额", aggregate: "sum", field: "cost" }] },
          { id: "status_chart", type: "chart", title: "状态分布", source: "issues", chart: "doughnut", groupBy: "status", aggregate: "count" }
        ]
      },
      {
        id: "manage",
        title: "问题管理",
        layout: "grid",
        columns: 2,
        components: [
          { id: "issue_form", type: "form", title: "登记问题", source: "issues", fields: modified ? ["title", "owner", "status", "priority", "cost", "deadline", "risk"] : ["title", "owner", "status", "priority", "cost", "deadline"], submitLabel: "保存问题" },
          { id: "issue_table", type: "table", title: "问题列表", source: "issues", fields: ["title", "owner", "status", "priority", "cost", "deadline"], search: true, actions: ["resolve", "remove"], span: 2 },
          { id: "issue_export", type: "export", title: "导出数据", source: "issues", formats: ["xlsx", "csv", "json"] }
        ]
      }
    ]
  };
}

function freeBilliardsSpec() {
  return {
    formatVersion: "room-app@1",
    kind: "custom",
    name: "自由 3D 台球房间",
    description: "用鼠标击球并可重新开始的离线三维台球游戏",
    theme: "dark",
    hostModules: ["graphics.three@1", "game.audio@1"],
    capabilities: { database: false, files: [], ai: false },
    files: {
      html: `<main><h1>自由 3D 台球</h1><p>点击球桌击球</p><button id="restart" type="button">重新开始</button><div id="viewport"></div></main>`,
      css: `body{margin:0;background:#071510;color:white}main{min-height:100dvh;display:grid;grid-template-rows:auto auto auto 1fr}#viewport{min-height:70vh}canvas{width:100%;height:100%;display:block}@media(max-width:600px){main{font-size:14px}}`,
      javascript: `const viewport=document.getElementById("viewport");const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(50,1,.1,100);camera.position.set(0,7,9);const renderer=new THREE.WebGLRenderer({antialias:true});viewport.appendChild(renderer.domElement);scene.add(new THREE.HemisphereLight(0xffffff,0x224422,2));const ball=new THREE.Mesh(new THREE.SphereGeometry(.3),new THREE.MeshStandardMaterial({color:0xffffff}));scene.add(ball);let speed=0;function resize(){renderer.setSize(Math.max(1,viewport.clientWidth),Math.max(1,viewport.clientHeight));camera.aspect=Math.max(1,viewport.clientWidth)/Math.max(1,viewport.clientHeight);camera.updateProjectionMatrix()}function restart(){ball.position.set(0,0,0);speed=0}renderer.domElement.addEventListener("pointerdown",()=>{speed=.08});document.getElementById("restart").addEventListener("click",restart);window.addEventListener("resize",resize);resize();function frame(){ball.position.x+=speed;speed*=.98;if(Math.abs(ball.position.x)>3)speed*=-1;renderer.render(scene,camera);requestAnimationFrame(frame)}frame();`
    }
  };
}

const testPlan = { ...Object.fromEntries(["overview", "features", "usage", "data", "permissions", "steps", "acceptance", "limitations"].map((key) => [key, `测试方案 ${key}：使用本地数据，不需要联网。`])), usesAi: false };

async function sendApproved(service, sessionId, prompt) {
  await service.send(sessionId, prompt);
  await service.waitForIdle(sessionId);
  await service.send(sessionId, "个人使用，百条数据，其他按你推荐的方案");
  const reviewed = await service.waitForIdle(sessionId);
  assert.equal(reviewed.workflow.phase, "review");
  return service.send(sessionId, { approvePlanId: reviewed.workflow.plan.id });
}

class FakeAgent {
  constructor(options) {
    this.options = options;
    this.listeners = [];
    this.state = { messages: [...(options.initialState.messages || [])], isStreaming: false };
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {};
  }

  async emit(event) {
    for (const listener of this.listeners) await listener(event, new AbortController().signal);
  }

  followUp(message) {
    this.queued = message;
  }

  steer(message) {
    this.steered = message;
  }

  clearAllQueues() {}
  abort() { this.aborted = true; }

  async planning(prompt) {
    const workflow = JSON.parse(this.options.initialState.systemPrompt.match(/当前工作流：(.*?)。下方/)[1]);
    if (workflow.phase === "implementing") return false;
    const user = { role: "user", content: prompt, timestamp: Date.now() };
    this.state.messages.push(user);
    await this.emit({ type: "agent_start" });
    const inspectCurrent = this.options.initialState.tools.find((item) => item.name === "inspect_current_room");
    const readCurrent = this.options.initialState.tools.find((item) => item.name === "read_current_room_file");
    if (inspectCurrent && readCurrent) {
      try {
        const inspected = await inspectCurrent.execute("inspect-current", {}, new AbortController().signal);
        const available = JSON.parse(inspected.content[0].text).files || [];
        const core = available.find((item) => /(?:^|\/)(?:index\.html|[^/]+\.(?:js|mjs))$/i.test(item.path) && item.readable);
        if (core) await readCurrent.execute("read-current", { path: core.path }, new AbortController().signal);
      } catch {
        // 新房间会话没有当前房间可读。
      }
    }
    const tool = this.options.initialState.tools.find((item) => item.name === (workflow.answered ? "propose_room_plan" : "ask_room_questions"));
    await tool.execute("planning", workflow.answered ? testPlan : { questions: ["谁来使用？推荐个人使用。", "多少数据？推荐百条本地数据。"] }, new AbortController().signal);
    const reply = { role: "assistant", content: [{ type: "text", text: "请查看需求与方案卡片。" }], stopReason: "stop", timestamp: Date.now() };
    this.state.messages.push(reply);
    await this.emit({ type: "message_end", message: reply });
    await this.emit({ type: "agent_end", messages: this.state.messages });
    return true;
  }

  async prompt(prompt) {
    if (await this.planning(prompt)) return;
    prompt += this.state.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "").join("\n");
    this.state.isStreaming = true;
    const user = { role: "user", content: prompt, timestamp: Date.now() };
    this.state.messages.push(user);
    await this.emit({ type: "agent_start" });
    await this.emit({ type: "turn_start" });
    const preface = { role: "assistant", content: [{ type: "text", text: "我来设计并构建这个房间。" }], stopReason: "toolUse", timestamp: Date.now() };
    await this.emit({ type: "message_update", message: preface, assistantMessageEvent: { type: "text_delta", delta: "我来设计并构建这个房间。" } });
    await this.emit({ type: "message_end", message: preface });
    const tool = this.options.initialState.tools.find((item) => item.name === "build_room");
    const args = {
      roomSpecJson: JSON.stringify(roomSpec({ modified: /风险说明/.test(prompt) })),
      summary: /风险说明/.test(prompt) ? "增加风险说明并升级房间" : "构建项目问题跟踪中心"
    };
    const toolCallId = `call_${Date.now()}`;
    await this.emit({ type: "tool_execution_start", toolCallId, toolName: tool.name, args });
    let result;
    try {
      result = await tool.execute(toolCallId, args, new AbortController().signal, (partialResult) => {
        this.emit({ type: "tool_execution_update", toolCallId, toolName: tool.name, args, partialResult });
      });
      await this.emit({ type: "tool_execution_end", toolCallId, toolName: tool.name, result, isError: false });
    } catch (error) {
      result = { content: [{ type: "text", text: error.message }], details: null };
      await this.emit({ type: "tool_execution_end", toolCallId, toolName: tool.name, result, isError: true });
      throw error;
    }
    this.state.messages.push(preface, { role: "toolResult", toolCallId, toolName: tool.name, content: result.content, isError: false, timestamp: Date.now() });
    const final = { role: "assistant", content: [{ type: "text", text: "房间已经完成，可以直接打开，也可以继续告诉我怎么修改。" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 100, output: 50 } };
    this.state.messages.push(final);
    await this.emit({ type: "turn_start" });
    await this.emit({ type: "message_update", message: final, assistantMessageEvent: { type: "text_delta", delta: "房间已经完成，可以直接打开，也可以继续告诉我怎么修改。" } });
    await this.emit({ type: "message_end", message: final });
    this.state.isStreaming = false;
    await this.emit({ type: "agent_end", messages: this.state.messages });
  }
}

class CustomRoomFakeAgent extends FakeAgent {
  async prompt(prompt) {
    if (await this.planning(prompt)) return;
    this.state.isStreaming = true;
    this.state.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    await this.emit({ type: "agent_start" });
    await this.emit({ type: "turn_start" });
    assert.match(this.options.initialState.systemPrompt, /绝不能因为模板不支持就拒绝用户/);
    assert.match(this.options.initialState.systemPrompt, /begin_custom_room → write_custom_room_file → test_custom_room → install_custom_room/);
    assert.match(this.options.initialState.systemPrompt, /多角色房间必须为每个角色保存各自的 profileId/);
    assert.match(this.options.initialState.systemPrompt, /generate\(prompt, \{ profileId \}\)/);
    const { files, ...metadata } = freeBilliardsSpec();
    const invocations = [
      ["begin_custom_room", metadata],
      ...Object.entries(files).map(([file, content]) => ["write_custom_room_file", { file, content }]),
      ["test_custom_room", {}],
      ["install_custom_room", {}]
    ];
    let revision;
    for (const [toolName, args] of invocations) {
      if (toolName === "write_custom_room_file") args.expectedRevision = revision;
      const tool = this.options.initialState.tools.find((item) => item.name === toolName);
      assert.ok(tool, `missing ${toolName}`);
      const toolCallId = `${toolName}_${Date.now()}`;
      await this.emit({ type: "tool_execution_start", toolCallId, toolName, args });
      const result = await tool.execute(toolCallId, args, new AbortController().signal, (partialResult) => {
        this.emit({ type: "tool_execution_update", toolCallId, toolName, args, partialResult });
      });
      await this.emit({ type: "tool_execution_end", toolCallId, toolName, result, isError: false });
      revision = JSON.parse(result.content[0].text).revision || revision;
      this.state.messages.push({ role: "toolResult", toolCallId, toolName, content: result.content, isError: false, timestamp: Date.now() });
    }
    const final = { role: "assistant", content: [{ type: "text", text: "3D 台球自由房间已通过草拟、测试并安装。" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 500, output: 900 } };
    this.state.messages.push(final);
    await this.emit({ type: "message_update", message: final, assistantMessageEvent: { type: "text_delta", delta: "3D 台球自由房间已通过草拟、测试并安装。" } });
    await this.emit({ type: "message_end", message: final });
    this.state.isStreaming = false;
    await this.emit({ type: "agent_end", messages: this.state.messages });
  }
}

class VisionFakeAgent extends FakeAgent {
  async prompt(prompt, images = []) {
    this.receivedPrompt = prompt;
    this.receivedImages = images;
    this.state.isStreaming = true;
    this.state.messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }, ...images],
      timestamp: Date.now()
    });
    await this.emit({ type: "agent_start" });
    await this.emit({ type: "turn_start" });
    const final = {
      role: "assistant",
      content: [{ type: "text", text: "我已结合参考图片理解并处理要求。" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: { input: 20, output: 10 }
    };
    this.state.messages.push(final);
    await this.emit({ type: "message_update", message: final, assistantMessageEvent: { type: "text_delta", delta: "我已结合参考图片理解并处理要求。" } });
    await this.emit({ type: "message_end", message: final });
    this.state.isStreaming = false;
    await this.emit({ type: "agent_end", messages: this.state.messages });
  }
}

test("planning gate requires clarification, a current plan and explicit UI approval", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-plan-gate-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const pi = await import("@earendil-works/pi-ai");
  const options = {
    roomStore,
    aiService: {
      getPublicProfile: () => ({ model: "fake", hasSessionKey: true }),
      createAgentRuntime: async () => ({ pi, model: { id: "fake" } })
    },
    agentModuleLoader: async () => ({ Agent: FakeAgent })
  };
  const service = await new RoomAgentService(options).init();
  const created = await service.createSession();
  const internal = service.requireSession(created.id);
  const tools = service.createTools(internal, { pi });
  const propose = tools.find((tool) => tool.name === "propose_room_plan");
  const mutating = tools.filter((tool) => !["inspect_room_capabilities", "inspect_source_project", "read_source_project_file", "inspect_current_room", "read_current_room_file", "assess_project_migration", "ask_room_questions", "propose_room_plan"].includes(tool.name));
  for (const tool of mutating) await assert.rejects(() => tool.execute("bypass", {}), /用户确认/);
  await assert.rejects(() => propose.execute("early", testPlan), /等待用户回答/);
  await service.send(created.id, "做一个台账，直接开始不要问我");
  const questioning = await service.waitForIdle(created.id);
  assert.equal(questioning.room, null);
  assert.equal(questioning.workflow.questions.length, 2);
  await assert.rejects(() => propose.execute("self-answer", testPlan), /等待用户回答/);
  await service.send(created.id, "你来推荐，个人使用，百条记录");
  const reviewed = await service.waitForIdle(created.id);
  assert.equal(reviewed.workflow.phase, "review");
  assert.equal(reviewed.room, null);
  const oldId = reviewed.workflow.plan.id;
  for (const tool of mutating) await assert.rejects(() => tool.execute("bypass", {}), /用户确认/);
  await assert.rejects(() => service.send(created.id, { approvePlanId: "fake" }), /失效/);
  await assert.rejects(() => service.send(created.id, { approvePlanId: oldId, prompt: "再加联网" }), /附加新需求/);
  await service.send(created.id, "好的，但是还需要导出 Excel");
  const revised = await service.waitForIdle(created.id);
  assert.equal(revised.room, null);
  assert.notEqual(revised.workflow.plan.id, oldId);
  await assert.rejects(() => service.send(created.id, { approvePlanId: oldId }), /失效/);
  const restored = await new RoomAgentService(options).init();
  assert.equal(restored.getSession(created.id).workflow.plan.id, revised.workflow.plan.id);
  await restored.send(created.id, { approvePlanId: revised.workflow.plan.id });
  const completed = await restored.waitForIdle(created.id);
  assert.ok(completed.room);
  assert.equal(completed.workflow.phase, "complete");
  assert.match(restored.requireSession(created.id).latestUserGoal, /台账/);
  await assert.rejects(() => restored.send(created.id, { approvePlanId: revised.workflow.plan.id }), /失效/);
  await restored.send(created.id, "现在加个筛选功能");
  const next = await restored.waitForIdle(created.id);
  assert.equal(next.workflow.phase, "clarifying");
  assert.equal(next.workflow.plan, undefined);
  assert.equal(next.room.version, completed.room.version);
});

test("long question answers are not silently truncated and stopped runs stay stopped", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-run-ux-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const pi = await import("@earendil-works/pi-ai");
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  class WaitingAgent extends FakeAgent {
    async prompt(prompt) {
      this.state.messages.push({ role: 'user', content: prompt, timestamp: Date.now() });
      await this.emit({ type: 'agent_start' });
      await new Promise((resolve) => { this.finish = resolve; ready(); });
      await this.emit({ type: 'agent_end', messages: this.state.messages });
    }
    abort() { this.finish(); }
  }
  const options = { roomStore, aiService: {
    getPublicProfile: () => ({ model: 'fake', hasSessionKey: true }),
    createAgentRuntime: async () => ({ pi, model: { id: 'fake' } })
  }, agentModuleLoader: async () => ({ Agent: WaitingAgent }) };
  const service = await new RoomAgentService(options).init();
  const session = await service.createSession();
  const answer = '需求答案'.repeat(1500);
  await service.send(session.id, answer);
  await started;
  assert.equal(service.getSession(session.id).messages.at(-1).content, answer);
  assert.equal(service.getSession(session.id).runs.at(-1).status, 'working');
  const queued = await service.send(session.id, "补充：保留现有数据，不要重建");
  assert.equal(queued.queued, true);
  assert.match(service.activeAgents.get(session.id).steered.content, /保留现有数据/);
  assert.equal(service.getSession(session.id).messages.at(-1).status, "queued");
  await service.abort(session.id);
  const stopped = await service.waitForIdle(session.id);
  assert.equal(stopped.runs.at(-1).status, 'stopped');
  assert.equal(stopped.runs.at(-1).reportedRequests, 0);
  assert.equal(stopped.runs.at(-1).estimatedCostUsd, null);
  const restored = await new RoomAgentService(options).init();
  assert.equal(restored.getSession(session.id).runs.at(-1).status, 'stopped');
});

test("interrupted approval and runtime startup failures require confirmation again", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-plan-restart-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const options = { roomStore, aiService: {
    getPublicProfile: () => ({ model: "fake", hasSessionKey: true }),
    createAgentRuntime: async () => { throw new Error("模拟模型初始化失败"); }
  } };
  const service = await new RoomAgentService(options).init();
  const created = await service.createSession();
  const session = service.requireSession(created.id);
  session.workflow = { phase: "implementing", answered: true, plan: { ...testPlan, id: "plan-interrupted" }, approvedPlanId: "plan-interrupted" };
  await service.persist(session);
  const restored = await new RoomAgentService(options).init();
  assert.equal(restored.getSession(created.id).workflow.phase, "review");
  await restored.send(created.id, { approvePlanId: "plan-interrupted" });
  const failed = await restored.waitForIdle(created.id);
  assert.equal(failed.status, "error");
  assert.equal(failed.workflow.phase, "review");
  assert.equal(failed.workflow.approvedPlanId, "plan-interrupted");
  assert.match(failed.error, /初始化失败/);
  assert.equal(restored.activeRuns.size, 0);
  restored.run = async () => {};
  await restored.send(created.id, "为什么安装失败了？");
  restored.activeRuns.delete(created.id);
  assert.equal(restored.getSession(created.id).workflow.plan.id, "plan-interrupted");
  assert.equal(restored.getSession(created.id).workflow.approvedPlanId, "plan-interrupted");
  assert.equal(restored.getSession(created.id).workflow.phase, "review");
  await restored.send(created.id, "继续安装");
  restored.activeRuns.delete(created.id);
  assert.equal(restored.getSession(created.id).workflow.phase, "implementing");
  assert.equal(restored.getSession(created.id).workflow.approvedPlanId, "plan-interrupted");
});

test("each room Agent session persists and uses its selected programming model", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-model-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const pi = await import("@earendil-works/pi-ai");
  const profiles = new Map([
    ["profile-fast", {
      id: "profile-fast",
      providerId: "xiaomi-token-plan-cn",
      name: "MiMo Token Plan（中国）",
      label: "MiMo 快速",
      model: "mimo-v2.5",
      baseUrl: "https://example.invalid",
      hasSessionKey: true
    }],
    ["profile-pro", {
      id: "profile-pro",
      providerId: "xiaomi-token-plan-cn",
      name: "MiMo Token Plan（中国）",
      label: "MiMo Pro",
      model: "mimo-v2.5-pro",
      baseUrl: "https://example.invalid",
      hasSessionKey: true
    }]
  ]);
  const runtimeOptions = [];
  const aiService = {
    getPublicProfile: (profileId = "profile-fast") => profiles.get(profileId) || null,
    getModelCapabilities: async (profileId) => ({
      profileId,
      model: profiles.get(profileId).model,
      input: ["text"],
      supportsImages: false
    }),
    createAgentRuntime: async (options) => {
      runtimeOptions.push(options);
      const profile = profiles.get(options.profileId || "profile-fast");
      return {
        pi,
        model: { id: profile.model, maxTokens: 16000 },
        streamFn: () => { throw new Error("fake agent does not call streamFn"); }
      };
    }
  };
  const options = {
    roomStore,
    aiService,
    gitService: { captureRoom: async () => {} },
    agentModuleLoader: async () => ({ Agent: FakeAgent })
  };
  const service = await new RoomAgentService(options).init();
  const created = await service.createSession({ profileId: "profile-fast" });
  assert.equal(created.profileId, "profile-fast");
  assert.equal(created.provider.model, "mimo-v2.5");
  const switched = await service.setSessionModel(created.id, "profile-pro");
  assert.equal(switched.profileId, "profile-pro");
  assert.equal(switched.provider.model, "mimo-v2.5-pro");
  await sendApproved(service, created.id, "创建一个问题跟踪中心");
  const completed = await service.waitForIdle(created.id);
  assert.equal(completed.status, "idle");
  assert.equal(runtimeOptions.length, 3);
  assert.deepEqual(runtimeOptions.slice(-1), [{
    maxTokens: 16000,
    timeoutMs: 180000,
    profileId: "profile-pro"
  }]);

  const restored = await new RoomAgentService(options).init();
  assert.equal(restored.getSession(created.id).profileId, "profile-pro");
  assert.equal(restored.getSession(created.id).provider.model, "mimo-v2.5-pro");
  await assert.rejects(() => restored.setSessionModel(created.id, "missing-profile"), /不存在/);
});

test("Pi Agent room session builds, updates, streams events and survives restart", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const pi = await import("@earendil-works/pi-ai");
  const events = [];
  const checkpoints = [];
  const aiService = {
    getPublicProfile: () => ({ providerId: "xiaomi-token-plan-cn", name: "MiMo Token Plan（中国）", model: "mimo-v2.5", baseUrl: "https://example.invalid", hasSessionKey: true }),
    createAgentRuntime: async () => ({ pi, model: { id: "mimo-v2.5", maxTokens: 8192 }, streamFn: () => { throw new Error("fake agent does not call streamFn"); } })
  };
  const options = {
    roomStore,
    aiService,
    gitService: { captureRoom: async (roomId, label, metadata) => checkpoints.push({ roomId, label, metadata }) },
    onEvent: (event) => events.push(event),
    agentModuleLoader: async () => ({ Agent: FakeAgent })
  };
  const service = await new RoomAgentService(options).init();
  const created = await service.createSession();
  const accepted = await sendApproved(service, created.id, "做一个有统计、图表、搜索和 Excel 导出的项目问题跟踪中心");
  assert.equal(accepted.accepted, true);
  const first = await service.waitForIdle(created.id);
  assert.equal(first.status, "idle");
  assert.equal(first.room.name, "项目问题跟踪中心");
  assert.equal(first.room.version, "1.0.0");
  assert.equal(first.room.embeddedDependencies.length, 0);
  assert.equal(first.room.grantedPermissions.network?.length || 0, 0);
  assert.ok(first.messages.some((message) => message.role === "assistant"));
  assert.ok(first.steps.some((step) => step.toolName === "build_room" && step.status === "success"));
  assert.ok(events.some((event) => event.type === "message_delta"));
  assert.ok(events.some((event) => event.type === "tool_updated"));
  assert.ok(events.some((event) => event.type === "room_ready"));
  assert.equal(first.runs.length, 3);
  const buildUsage = first.runs.at(-1);
  assert.equal(buildUsage.requests, 2);
  assert.equal(buildUsage.missingUsage, 1);
  assert.equal(buildUsage.tokens.totalTokens, 150);
  assert.equal(buildUsage.reportedFields.input, 1);
  assert.equal(buildUsage.estimatedCostUsd, null);
  assert.equal(buildUsage.status, "complete");
  assert.ok(buildUsage.elapsedMs >= 0);
  assert.ok(events.some((event) => event.type === "usage_updated"));

  await sendApproved(service, created.id, "保留原数据，再增加风险说明字段");
  const updated = await service.waitForIdle(created.id);
  assert.equal(updated.room.id, first.room.id);
  assert.equal(updated.room.version, "1.0.1");
  assert.equal(updated.room.name, "项目风险与问题中心");
  assert.equal(checkpoints.length, 3);
  assert.deepEqual(checkpoints.map((item) => item.label), ["Agent 创建初始版本", "Agent 修改前", "Agent 修改完成"]);
  assert.deepEqual(checkpoints.map((item) => item.metadata.kind), ["generated", "ai-before", "ai-update"]);

  const restoredService = await new RoomAgentService(options).init();
  const restored = restoredService.getSession(created.id);
  assert.equal(restored.roomId, first.room.id);
  assert.deepEqual(restored.runs, updated.runs);
  assert.equal(restored.messages.filter((message) => message.role === "user").length, 6);
  assert.equal(restored.steps.filter((step) => step.status === "success").length, 2);
  assert.equal(await restoredService.unlinkRoom(first.room.id), 1);
  assert.equal(restoredService.getSession(created.id).roomId, null);
});

test("Pi Agent harness freely creates an unsupported 3D billiards room through draft, test and install", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-custom-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const gitService = await new GitService(roomStore, getTestGitToolchain()).init();
  const pi = await import("@earendil-works/pi-ai");
  const requestedRuntimeOptions = [];
  const aiService = {
    getPublicProfile: () => ({ providerId: "xiaomi-token-plan-cn", name: "MiMo Token Plan（中国）", model: "mimo-v2.5", baseUrl: "https://example.invalid", hasSessionKey: true }),
    createAgentRuntime: async (options) => {
      requestedRuntimeOptions.push(options);
      return { pi, model: { id: "mimo-v2.5", maxTokens: 16000 }, streamFn: () => { throw new Error("fake agent does not call streamFn"); } };
    }
  };
  const service = await new RoomAgentService({
    roomStore,
    aiService,
    gitService,
    agentModuleLoader: async () => ({ Agent: CustomRoomFakeAgent })
  }).init();
  const session = await service.createSession();
  await sendApproved(service, session.id, "创建一个真正能玩的 3D 台球游戏，不要记分表，也不要套用收集、迷宫或跑酷模板");
  const result = await service.waitForIdle(session.id);
  assert.equal(result.status, "idle");
  assert.equal(result.room.name, "自由 3D 台球房间");
  assert.deepEqual(result.steps.map((step) => step.toolName), ["begin_custom_room", "write_custom_room_file", "write_custom_room_file", "write_custom_room_file", "test_custom_room", "install_custom_room"]);
  assert.ok(result.steps.every((step) => step.status === "success"));
  assert.equal(result.steps.find(step => step.toolName === "test_custom_room").details.testChecks.every((check) => check.passed), true);
  assert.equal(result.room.hostModules.includes("graphics.three@1"), true);
  assert.deepEqual(result.room.embeddedDependencies, []);
  assert.deepEqual(result.room.grantedPermissions.network || [], []);
  assert.equal(requestedRuntimeOptions.length, 3);
  assert.deepEqual(requestedRuntimeOptions.slice(-1), [{ maxTokens: 16000, timeoutMs: 180000 }]);
  const history = await gitService.listHistory(result.room.id);
  assert.equal(history.checkpoints.length, 1);
  assert.equal(history.checkpoints[0].kind, "generated");
  assert.equal(history.checkpoints[0].label, "Agent 创建初始版本");
  const root = roomStore.getProgramRoot(result.room.id);
  assert.equal(JSON.parse(await fsp.readFile(path.join(root, "app", "room-app.json"), "utf8")).formatVersion, "room-app@1");
  assert.match(await fsp.readFile(path.join(root, "app", "app.js"), "utf8"), /THREE\.WebGLRenderer/);
});

test("a post-install MinGit failure is reported as a warning without losing the installed room", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-checkpoint-warning-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const pi = await import("@earendil-works/pi-ai");
  const aiService = {
    getPublicProfile: () => ({ providerId: "xiaomi-token-plan-cn", name: "MiMo Token Plan（中国）", model: "mimo-v2.5", baseUrl: "https://example.invalid", hasSessionKey: true }),
    createAgentRuntime: async () => ({ pi, model: { id: "mimo-v2.5", maxTokens: 16000 }, streamFn: () => { throw new Error("fake agent does not call streamFn"); } })
  };
  const options = {
    roomStore,
    aiService,
    gitService: { captureRoom: async () => { throw new Error("模拟 MinGit 写入失败"); } },
    agentModuleLoader: async () => ({ Agent: CustomRoomFakeAgent })
  };
  const service = await new RoomAgentService(options).init();
  const session = await service.createSession();
  await sendApproved(service, session.id, "创建一个真正能玩的 3D 台球游戏");
  const result = await service.waitForIdle(session.id);
  const installStep = result.steps.find((step) => step.toolName === "install_custom_room");
  assert.equal(result.status, "idle");
  assert.ok(result.room);
  assert.equal(installStep.status, "success");
  assert.match(installStep.details.checkpointWarning, /模拟 MinGit 写入失败/);
  assert.equal(roomStore.getRoom(result.room.id)?.id, result.room.id);

  const restoredService = await new RoomAgentService(options).init();
  assert.equal(restoredService.getSession(session.id).roomId, result.room.id);
});

test("multimodal room chat stores image files out of transcript and restores Pi image blocks", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-image-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const sourceImage = path.join(dataRoot, "界面参考.png");
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await fsp.writeFile(sourceImage, imageBytes);
  const roomStore = await new RoomStore(dataRoot).init();
  const pi = await import("@earendil-works/pi-ai");
  let activeAgent;
  class CapturingVisionAgent extends VisionFakeAgent {
    constructor(options) {
      super(options);
      activeAgent = this;
    }
  }
  const aiService = {
    getPublicProfile: () => ({ providerId: "xiaomi-token-plan-cn", name: "MiMo Token Plan（中国）", model: "mimo-v2.5", baseUrl: "https://example.invalid", hasSessionKey: true }),
    getActiveModelCapabilities: async () => ({ model: "mimo-v2.5", input: ["text", "image"], supportsImages: true }),
    createAgentRuntime: async () => ({
      pi,
      model: { id: "mimo-v2.5", input: ["text", "image"], maxTokens: 16000 },
      streamFn: () => { throw new Error("fake agent does not call streamFn"); }
    })
  };
  const options = {
    roomStore,
    aiService,
    agentModuleLoader: async () => ({ Agent: CapturingVisionAgent })
  };
  const service = await new RoomAgentService(options).init();
  const session = await service.createSession();
  await service.send(session.id, {
    prompt: "按照这张参考图创建房间",
    attachments: [{ path: sourceImage, name: "界面参考.png", type: "image/png", size: imageBytes.length }]
  });
  const result = await service.waitForIdle(session.id);
  assert.equal(result.status, "idle");
  assert.equal(result.messages[0].attachments.length, 1);
  assert.equal(result.messages[0].attachments[0].name, "界面参考.png");
  assert.equal(activeAgent.receivedImages.length, 1);
  assert.equal(activeAgent.receivedImages[0].type, "image");
  assert.equal(activeAgent.receivedImages[0].mimeType, "image/png");
  assert.equal(Buffer.from(activeAgent.receivedImages[0].data, "base64").equals(imageBytes), true);

  const attachment = await service.getAttachment(session.id, result.messages[0].attachments[0].id);
  assert.match(attachment.dataUrl, /^data:image\/png;base64,/);
  const transcriptText = await fsp.readFile(path.join(dataRoot, "agent-sessions", `${session.id}.json`), "utf8");
  assert.equal(transcriptText.includes(sourceImage), false);
  assert.equal(transcriptText.includes(imageBytes.toString("base64")), false);
  assert.match(transcriptText, /"type": "image_ref"/);

  const restoredService = await new RoomAgentService(options).init();
  const restoredInternal = restoredService.requireSession(session.id);
  const hydrated = await restoredService.hydrateAgentMessages(restoredInternal);
  const restoredImage = hydrated.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === "image");
  assert.equal(Buffer.from(restoredImage.data, "base64").equals(imageBytes), true);
  const attachmentDirectory = restoredService.attachmentDirectory(session.id);
  await restoredService.deleteSession(session.id);
  await assert.rejects(() => fsp.access(attachmentDirectory));
});

test("room chat rejects images for a text-only model instead of silently dropping them", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-text-only-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const sourceImage = path.join(dataRoot, "reference.png");
  await fsp.writeFile(sourceImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const roomStore = await new RoomStore(dataRoot).init();
  const service = await new RoomAgentService({
    roomStore,
    aiService: {
      getPublicProfile: () => ({ providerId: "custom-openai-compatible", name: "内网文本模型", model: "text-only", baseUrl: "http://127.0.0.1", hasSessionKey: false }),
      getActiveModelCapabilities: async () => ({ model: "text-only", input: ["text"], supportsImages: false })
    }
  }).init();
  const session = await service.createSession();
  await assert.rejects(() => service.send(session.id, {
    prompt: "参考这个界面",
    attachments: [{ path: sourceImage, name: "reference.png" }]
  }), /不支持图片输入/);
  assert.equal(service.getSession(session.id).messages.length, 0);
});

test("Agent sessions accept local rooms or shared rooms whose publisher allows AI modification", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-agent-gate-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(path.join(root, "data")).init();
  const { packDirectory } = require("../src/main/room-package.cjs");
  const buildExternal = async (id, sharing) => {
    const source = path.join(root, `src-${id}`);
    await fsp.mkdir(path.join(source, "app"), { recursive: true });
    await fsp.writeFile(path.join(source, "manifest.json"), JSON.stringify({
      formatVersion: "0.1",
      id,
      name: `外部房间 ${id}`,
      version: "1.0.0",
      runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" },
      entry: "app/index.html",
      permissions: { database: "private" },
      hostModules: [],
      ...(sharing ? { sharing } : {})
    }), "utf8");
    await fsp.writeFile(path.join(source, "app", "index.html"), "<!doctype html><title>t</title>", "utf8");
    const packagePath = path.join(root, `${id}.room`);
    await packDirectory(source, packagePath);
    const inspection = await store.inspectPackage(packagePath, { source: "external" });
    return store.commitImport(inspection.token, ["database.private"]);
  };
  const restricted = await buildExternal("cn.example.restricted");
  const shared = await buildExternal("cn.example.shared", { allowAiModification: true });
  const options = { roomStore: store, aiService: { getPublicProfile: () => ({ id: "test", model: "test", hasSessionKey: true }) } };
  const service = await new RoomAgentService(options).init();
  t.after(() => service.dispose());

  await assert.rejects(service.createSession({ roomId: restricted.id }), /允许修改/);
  await assert.rejects(service.createSession({ roomId: "cn.example.missing" }), /允许修改/);
  const session = await service.createSession({ roomId: shared.id });
  assert.equal(session.roomId, shared.id);
});
