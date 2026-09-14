"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AiService } = require("../src/main/ai-service.cjs");
const { GitService } = require("../src/main/git-service.cjs");
const { RoomAgentService } = require("../src/main/room-agent-service.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");
const { getTestGitToolchain } = require("../test-support/bundled-git.cjs");

async function main() {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) throw new Error("请通过 MIMO_API_KEY 环境变量提供测试密钥");
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-mimo-custom-room-"));
  const reportPath = path.resolve(process.env.ZHIBIAN_MIMO_CUSTOM_REPORT || path.join(__dirname, "..", "release", "mimo-custom-room-smoke.json"));
  const startedAt = Date.now();
  let service;
  try {
    const roomStore = await new RoomStore(dataRoot).init();
    const aiService = await new AiService(dataRoot).init();
    await aiService.saveProfile({ providerId: "xiaomi-token-plan-cn", model: "mimo-v2.5", apiKey });
    const gitService = await new GitService(roomStore, getTestGitToolchain()).init();
    const eventTypes = [];
    service = await new RoomAgentService({ roomStore, aiService, gitService, onEvent: (event) => eventTypes.push(event.type) }).init();
    const session = await service.createSession();
    await service.send(session.id, "创建一个真正能玩的离线 3D 台球游戏，不要做成记分表，也不要套用收集、迷宫或跑酷模板。鼠标可以瞄准并控制力度，球有碰撞、摩擦、球桌边界和入袋判定；显示回合和得分，提供操作说明、重新开局，并适配窗口大小。请直接完成、测试并安装房间。");
    const asked = await service.waitForIdle(session.id);
    if (asked.room || !asked.workflow.questions?.length) throw new Error("应先澄清需求，不能提前安装");
    await service.send(session.id, "我个人单机娱乐，不需要保存数据、联网或AI。鼠标瞄准和力度，简单球体碰撞、入袋计分、重开即可，不需要复杂比赛规则，先做精简可玩版。");
    const reviewed = await service.waitForIdle(session.id);
    if (reviewed.room || reviewed.workflow.phase !== "review") throw new Error("应等待方案确认");
    await service.send(session.id, { approvePlanId: reviewed.workflow.plan.id });
    const completed = await service.waitForIdle(session.id);
    if (completed.status !== "idle") throw new Error(completed.error || `Agent 状态异常：${completed.status}`);
    if (!completed.room) throw new Error("Agent 没有创建自由房间");
    const expectedTools = ["begin_custom_room", "write_custom_room_file", "test_custom_room", "install_custom_room"];
    for (const toolName of expectedTools) {
      if (!completed.steps.some((step) => step.toolName === toolName && step.status === "success")) throw new Error(`Agent 没有成功完成 ${toolName}`);
    }
    if (completed.steps.some((step) => step.toolName === "build_3d_room" && step.status === "success")) throw new Error("台球不应退化为固定 3D 模板");
    if (completed.room.embeddedDependencies.length !== 0) throw new Error("工作台已有模块不应重复打包进自由房间");
    if ((completed.room.grantedPermissions.network || []).length !== 0) throw new Error("自由房间不应拥有普通网络权限");
    if (!completed.room.hostModules.includes("graphics.three@1")) throw new Error("3D 台球没有选择工作台内置 Three.js");
    const root = roomStore.getProgramRoot(completed.room.id);
    const metadata = JSON.parse(await fsp.readFile(path.join(root, "app", "room-app.json"), "utf8"));
    const javascript = await fsp.readFile(path.join(root, "app", "app.js"), "utf8");
    const html = await fsp.readFile(path.join(root, "app", "index.html"), "utf8");
    if (metadata.formatVersion !== "room-app@1" || metadata.kind !== "custom") throw new Error("产物不是 room-app@1 自由房间");
    for (const pattern of [/THREE\.WebGLRenderer/, /requestAnimationFrame/, /(?:pointer|mouse)/i, /(?:restart|reset|重新|重开)/i]) {
      if (!pattern.test(`${html}\n${javascript}`)) throw new Error(`自由房间缺少必要实现：${pattern}`);
    }
    const installStep = completed.steps.find((step) => step.toolName === "install_custom_room" && step.status === "success");
    if (!installStep?.details?.testChecks?.every((check) => check.passed)) throw new Error("安装结果没有通过全部 Harness 契约测试");
    if (installStep.details.checkpointWarning) throw new Error(`MinGit 检查点创建失败：${installStep.details.checkpointWarning}`);
    const history = await gitService.listHistory(completed.room.id);
    if (history.checkpoints[0]?.kind !== "generated") throw new Error("自由房间没有创建 generated 类型的 MinGit 检查点");
    const report = {
      kind: "zhibian-mimo-custom-room-smoke",
      formatVersion: "0.1",
      createdAt: new Date().toISOString(),
      result: "PASS",
      provider: "xiaomi-token-plan-cn",
      model: "mimo-v2.5",
      elapsedMs: Date.now() - startedAt,
      session: {
        messageCount: completed.messages.length,
        stepCount: completed.steps.length,
        tools: completed.steps.map((step) => ({ toolName: step.toolName, status: step.status })),
        eventTypes: [...new Set(eventTypes)]
      },
      room: {
        id: completed.room.id,
        name: completed.room.name,
        version: completed.room.version,
        formatVersion: metadata.formatVersion,
        hostModules: completed.room.hostModules,
        embeddedDependencyCount: completed.room.embeddedDependencies.length,
        network: completed.room.grantedPermissions.network || [],
        sourceCharacters: javascript.length
      },
      git: {
        version: history.gitVersion,
        checkpointCount: history.checkpoints.length,
        latestKind: history.checkpoints[0].kind
      },
      harnessChecks: installStep.details.testChecks
    };
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`MIMO_CUSTOM_ROOM_SMOKE_OK ${JSON.stringify(report)}`);
  } finally {
    if (service) await service.dispose();
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("MIMO_CUSTOM_ROOM_SMOKE_FAILED", error.message);
  process.exitCode = 1;
});
