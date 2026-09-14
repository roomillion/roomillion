"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AiService } = require("../src/main/ai-service.cjs");
const { generateRoomFromPrompt } = require("../src/main/generated-room.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");

const DEFAULT_PROVIDER_ID = "xiaomi-token-plan-cn";
const DEFAULT_MODEL = "mimo-v2.5";
const DEFAULT_PROMPT = "创建一个项目问题跟踪房间：记录问题标题、责任人、发现日期、优先级、预计损失金额、处理状态和详细说明；支持搜索筛选、统计图表，并能导出 Excel。界面和字段要适合普通办公室人员直接使用。";

function sanitizeError(error, secret) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

function qualityReport(definition) {
  if (definition.kind === "game3d") {
    const modules = new Set(definition.hostModules);
    const checks = {
      meaningfulName: definition.name.length >= 4,
      supportedGenre: ["collector", "maze", "runner"].includes(definition.genre),
      boundedLevel: definition.level.obstacleCount <= 30 && definition.level.collectibleCount <= 20,
      hasThree: modules.has("graphics.three@1"),
      hasRapier: modules.has("physics.rapier@1"),
      hasInput: modules.has("game.input@1"),
      hasAudio: modules.has("game.audio@1"),
      hasAssets: modules.has("game.assets@1")
    };
    return { passed: Object.values(checks).every(Boolean), checks };
  }
  if (definition.kind === "composed") {
    const labels = definition.data.flatMap((source) => source.fields.map((field) => field.label));
    const modules = new Set(definition.hostModules);
    const components = definition.pages.flatMap((page) => page.components);
    const componentTypes = new Set(components.map((component) => component.type));
    const checks = {
      meaningfulName: definition.name.length >= 4,
      realRoomSpec: definition.specVersion === "room-spec@1" && definition.pages.length >= 1,
      enoughFields: definition.data.some((source) => source.fields.length >= 6),
      hasForm: componentTypes.has("form"),
      hasDataView: componentTypes.has("table") || componentTypes.has("cards") || componentTypes.has("board"),
      hasStats: componentTypes.has("stats"),
      hasChart: componentTypes.has("chart") && modules.has("ui.chart@1"),
      hasSearch: components.some((component) => component.search) && modules.has("data.search@1"),
      hasSpreadsheetExport: components.some((component) => component.type === "export" && component.formats.includes("xlsx")) && modules.has("document.spreadsheet@1"),
      officeLabels: ["问题", "责任", "日期", "优先", "损失", "状态", "说明"].filter((keyword) =>
        labels.some((label) => label.includes(keyword))
      ).length >= 5
    };
    return { passed: Object.values(checks).every(Boolean), checks };
  }
  const labels = definition.fields.map((field) => field.label);
  const modules = new Set(definition.hostModules);
  const checks = {
    meaningfulName: definition.name.length >= 4,
    enoughFields: definition.fields.length >= 6,
    hasDate: definition.fields.some((field) => field.type === "date"),
    hasNumber: definition.fields.some((field) => field.type === "number"),
    hasSearch: modules.has("data.search@1"),
    hasChart: modules.has("ui.chart@1"),
    hasSpreadsheet: modules.has("document.spreadsheet@1"),
    officeLabels: ["问题", "责任", "日期", "优先", "损失", "状态", "说明"].filter((keyword) =>
      labels.some((label) => label.includes(keyword))
    ).length >= 5
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

async function main() {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) throw new Error("请通过 MIMO_API_KEY 环境变量提供 Token Plan API Key");
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-mimo-live-"));
  const startedAt = Date.now();
  try {
    const aiService = await new AiService(dataRoot).init();
    const providerId = process.env.MIMO_PROVIDER_ID || DEFAULT_PROVIDER_ID;
    const profile = {
      providerId,
      model: process.env.MIMO_MODEL || DEFAULT_MODEL,
      apiKey,
      rememberKey: false
    };
    if (providerId === "custom-openai-compatible") {
      profile.name = "Xiaomi MiMo Token Plan";
      profile.baseUrl = process.env.MIMO_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1";
    }
    const savedProfile = await aiService.saveProfile(profile);
    const connection = await aiService.testConnection();
    const roomStore = await new RoomStore(dataRoot).init();
    const generation = await generateRoomFromPrompt({
      prompt: process.env.MIMO_ROOM_PROMPT || DEFAULT_PROMPT,
      aiService,
      roomStore
    });
    const programRoot = roomStore.getProgramRoot(generation.room.id);
    const manifest = JSON.parse(await fsp.readFile(path.join(programRoot, "manifest.json"), "utf8"));
    const entryStats = await fsp.stat(path.join(programRoot, ...manifest.entry.split("/")));
    const quality = qualityReport(generation.definition);
    const result = {
      ok: quality.passed && entryStats.isFile(),
      provider: savedProfile.name,
      providerId: savedProfile.providerId,
      providerSource: savedProfile.providerId === DEFAULT_PROVIDER_ID ? "pi-builtin" : "custom",
      model: generation.model,
      connection: { ok: connection.ok, latencyMs: connection.latencyMs },
      elapsedMs: Date.now() - startedAt,
      room: {
        id: generation.room.id,
        name: generation.room.name,
        version: generation.room.version,
        kind: generation.definition.kind || "ledger",
        fieldCount: generation.definition.fields?.length ?? 0,
        fields: generation.definition.fields ?? [],
        dataSourceCount: generation.definition.data?.length ?? 0,
        pageCount: generation.definition.pages?.length ?? 0,
        componentTypes: generation.definition.pages?.flatMap((page) => page.components.map((component) => component.type)) ?? [],
        genre: generation.definition.genre ?? null,
        level: generation.definition.level ?? null,
        hostModules: generation.definition.hostModules,
        permissions: manifest.permissions,
        entryExists: entryStats.isFile()
      },
      ignoredHostModules: generation.ignoredHostModules,
      harness: {
        generationAttempts: generation.generationAttempts,
        repaired: generation.repaired,
        quality: generation.quality
      },
      quality,
      usage: generation.usage ?? null,
      secretPersisted: false
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } finally {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`MIMO_ROOM_SMOKE_FAILED ${sanitizeError(error, process.env.MIMO_API_KEY)}\n`);
  process.exitCode = 1;
});
