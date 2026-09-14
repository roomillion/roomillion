"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AiService } = require("../src/main/ai-service.cjs");
const { RoomAgentService } = require("../src/main/room-agent-service.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");

async function main() {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) throw new Error("请通过 MIMO_API_KEY 环境变量提供测试密钥");
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-mimo-agent-"));
  const reportPath = path.resolve(process.env.ZHIBIAN_MIMO_AGENT_REPORT || path.join(__dirname, "..", "release", "mimo-agent-smoke.json"));
  const startedAt = Date.now();
  try {
    const roomStore = await new RoomStore(dataRoot).init();
    const aiService = await new AiService(dataRoot).init();
    await aiService.saveProfile({
      providerId: "xiaomi-token-plan-cn",
      model: "mimo-v2.5",
      apiKey
    });
    const checkpoints = [];
    const eventTypes = [];
    const service = await new RoomAgentService({
      roomStore,
      aiService,
      gitService: {
        captureRoom: async (roomId, label, metadata) => {
          checkpoints.push({ roomId, label, kind: metadata.kind });
          return { roomId, label };
        }
      },
      onEvent: (event) => eventTypes.push(event.type)
    }).init();
    const session = await service.createSession();
    await service.send(session.id, "为培训部门创建一个培训课程与报名管理中心。需要两个页面：概览页显示课程数、报名人数统计和课程类别图表；管理页可以录入课程名称、讲师、类别、日期、容量、报名人数和是否开放，能搜索表格、关闭报名、删除记录，并导出 Excel、CSV 和 JSON。请直接完成并构建房间。");
    const asked = await service.waitForIdle(session.id);
    if (asked.room || !asked.workflow.questions?.length) throw new Error("应先澄清需求，不能提前安装");
    await service.send(session.id, "培训负责人个人在一台电脑使用，约100门课程和1000条报名记录以内，从空白手工录入，功能按原需求，数据本地保存，不需要AI或联网。");
    const reviewed = await service.waitForIdle(session.id);
    if (reviewed.room || reviewed.workflow.phase !== "review") throw new Error("应等待方案确认");
    await service.send(session.id, { approvePlanId: reviewed.workflow.plan.id });
    const completed = await service.waitForIdle(session.id);
    if (completed.status !== "idle") throw new Error(completed.error || `Agent 状态异常：${completed.status}`);
    if (!completed.room) throw new Error("Agent 没有创建房间");
    const buildSteps = completed.steps.filter((step) => step.toolName === "build_room");
    if (!buildSteps.some((step) => step.status === "success")) throw new Error("Agent 没有成功调用 build_room");
    if (completed.room.embeddedDependencies.length !== 0) throw new Error("房间不应打包工作台已有依赖");
    if ((completed.room.grantedPermissions.network || []).length !== 0) throw new Error("房间不应具有网络权限");
    const report = {
      kind: "zhibian-mimo-pi-agent-smoke",
      formatVersion: "0.1",
      createdAt: new Date().toISOString(),
      result: "PASS",
      provider: "xiaomi-token-plan-cn",
      model: "mimo-v2.5",
      elapsedMs: Date.now() - startedAt,
      session: {
        messageCount: completed.messages.length,
        stepCount: completed.steps.length,
        eventTypes: [...new Set(eventTypes)]
      },
      room: {
        id: completed.room.id,
        name: completed.room.name,
        version: completed.room.version,
        hostModules: completed.room.hostModules,
        embeddedDependencyCount: completed.room.embeddedDependencies.length,
        network: completed.room.grantedPermissions.network || []
      },
      buildSteps: buildSteps.map((step) => ({
        status: step.status,
        pageCount: step.details?.pageCount,
        componentTypes: step.details?.componentTypes,
        qualityPassed: step.details?.quality?.passed === true
      })),
      checkpoints: checkpoints.map(({ label, kind }) => ({ label, kind }))
    };
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`MIMO_PI_AGENT_SMOKE_OK ${JSON.stringify(report)}`);
    await service.dispose();
  } finally {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("MIMO_PI_AGENT_SMOKE_FAILED", error.message);
  process.exitCode = 1;
});
