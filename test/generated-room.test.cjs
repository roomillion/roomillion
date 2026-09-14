"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { GitService } = require("../src/main/git-service.cjs");
const { getTestGitToolchain } = require("../test-support/bundled-git.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");
const {
  createGeneratedRoom,
  enhanceFieldControls,
  evaluateRoomDefinitionQuality,
  extractJsonObject,
  generateRoomFromPrompt,
  parseGeneratedDefinition,
  selectHostModules,
  updateGeneratedRoomFromPrompt,
  validateAiDefinition,
  validateDefinition
} = require("../src/main/generated-room.cjs");
const {
  GAME3D_HOST_MODULES,
  isGame3dPrompt,
  parseGame3dDefinition,
  validateGame3dDefinition
} = require("../src/main/game3d-room.cjs");

test("3D game prompts route to a bounded offline definition", () => {
  assert.equal(isGame3dPrompt("做一个 3D 迷宫游戏"), true);
  assert.equal(isGame3dPrompt("做一个普通库存台账"), false);
  const definition = validateGame3dDefinition({
    name: "晶体迷宫",
    description: "在迷宫中收集晶体",
    genre: "maze",
    difficulty: "hard",
    theme: "neon",
    instructions: "方向键移动，空格跳跃",
    player: { speed: 999, jumpForce: 0 },
    level: { size: 999, obstacleCount: 999, collectibleCount: 999, timeLimitSeconds: 1 }
  });
  assert.deepEqual(definition.hostModules, GAME3D_HOST_MODULES);
  assert.equal(definition.player.speed, 9);
  assert.equal(definition.level.size, 48);
  assert.equal(definition.level.obstacleCount, 30);
  assert.equal(definition.level.timeLimitSeconds, 45);
});

test("AI creates a shareable 3D game room without embedded or network dependencies", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-generated-game3d-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const calls = [];
  const aiService = { complete: async (options) => {
    calls.push(options);
    return {
      text: JSON.stringify({
        name: "霓虹晶体迷宫",
        description: "穿过立体迷宫收集所有晶体",
        genre: "maze",
        difficulty: "normal",
        theme: "neon",
        instructions: "使用 WASD 移动，空格键跳跃",
        seed: "offline-maze-one",
        player: { speed: 6.2, jumpForce: 7.5 },
        level: { size: 28, obstacleCount: 12, collectibleCount: 8, timeLimitSeconds: 120 }
      }),
      model: "mimo-v2.5",
      usage: { input: 1, output: 1 }
    };
  } };
  const generated = await generateRoomFromPrompt({ prompt: "创建一个 3D 迷宫游戏，收集晶体", aiService, roomStore: store });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].structuredOutput, true);
  assert.equal(generated.definition.kind, "game3d");
  assert.equal(generated.quality.passed, true);
  assert.deepEqual(generated.room.hostModules, GAME3D_HOST_MODULES);
  const root = store.getProgramRoot(generated.room.id);
  const manifest = JSON.parse(await fsp.readFile(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, { network: [] });
  assert.deepEqual(manifest.embeddedDependencies, []);
  const html = await fsp.readFile(path.join(root, "app", "index.html"), "utf8");
  assert.match(html, /_modules\/graphics\.three@1\/three\.min\.js/);
  assert.match(html, /_modules\/physics\.rapier@1\/rapier\.min\.js/);
  assert.doesNotMatch(html, /https?:\/\//i);
  const definition = parseGame3dDefinition(await fsp.readFile(path.join(root, "app", "definition.js"), "utf8"));
  assert.equal(definition.genre, "maze");
});

test("AI JSON is normalized into a safe room definition", () => {
  const parsed = extractJsonObject("```json\n{\"name\":\"会议台账\",\"description\":\"跟踪事项\",\"fields\":[{\"key\":\"Owner Name\",\"label\":\"负责人\",\"type\":\"unknown\"}]}\n```");
  const definition = validateDefinition(parsed);
  assert.equal(definition.fields[0].key, "owner_name");
  assert.equal(definition.fields[0].type, "text");
  assert.deepEqual(definition.hostModules, []);
});

test("requirements select only existing modules and expand safe dependencies", () => {
  const selected = selectHostModules(validateDefinition({
    name: "经营分析",
    description: "月度经营数据",
    fields: [
      { key: "month", label: "月份", type: "date" },
      { key: "revenue", label: "收入", type: "number" },
      { key: "notes", label: "说明", type: "textarea" }
    ],
    hostModules: ["document.markdown@1"]
  }), "需要图表、搜索并导出 CSV 报表");
  assert.deepEqual(selected.hostModules, [
    "data.date@1",
    "data.decimal@1",
    "data.csv@1",
    "data.search@1",
    "ui.chart@1",
    "security.sanitize@1",
    "document.markdown@1"
  ]);
  assert.throws(() => validateDefinition({
    name: "错误房间",
    fields: [{ key: "name", label: "名称", type: "text" }],
    hostModules: ["left-pad@1"]
  }), /不支持的宿主模块/);
});

test("office requirements choose SheetJS by default and ExcelJS only for rich workbooks", () => {
  const base = validateDefinition({
    name: "办公文档",
    description: "验证自动选库",
    fields: [{ key: "item", label: "事项", type: "text" }]
  });
  const simple = selectHostModules(base, "导入 Excel 工作簿并导出 xlsx");
  assert.equal(simple.hostModules.includes("document.spreadsheet@1"), true);
  assert.equal(simple.hostModules.includes("document.spreadsheet.rich@1"), false);
  assert.equal(simple.hostModules.includes("data.csv@1"), false);

  const rich = selectHostModules(base, "生成带样式、图片、合并单元格和打印设置的 Excel 报表");
  assert.equal(rich.hostModules.includes("document.spreadsheet@1"), true);
  assert.equal(rich.hostModules.includes("document.spreadsheet.rich@1"), true);

  const documents = selectHostModules(base, "生成 PDF 表格报告，预览 Word 文档，制作 PPT，并生成二维码");
  assert.equal(documents.hostModules.includes("font.cjk@1"), true);
  assert.equal(documents.hostModules.includes("document.pdf.table@1"), true);
  assert.equal(documents.hostModules.includes("security.sanitize@1"), true);
  assert.equal(documents.hostModules.includes("archive.zip@1"), true);
  assert.equal(documents.hostModules.includes("document.word.preview@1"), true);
  assert.equal(documents.hostModules.includes("document.presentation.write@1"), true);
  assert.equal(documents.hostModules.includes("utility.qrcode@1"), true);

  const negative = selectHostModules(base, "只要文字清单，不需要图表、搜索或 Excel");
  assert.equal(negative.hostModules.includes("ui.chart@1"), false);
  assert.equal(negative.hostModules.includes("data.search@1"), false);
  assert.equal(negative.hostModules.includes("document.spreadsheet@1"), false);
});

test("AI module hallucinations are ignored before local allowlist selection", () => {
  const parsed = validateAiDefinition({
    name: "导出清单",
    description: "导出记录",
    fields: [{ key: "item", label: "事项", type: "text", required: true }],
    hostModules: ["data.csv@1", "npm.install-anything@1", 42]
  });
  assert.deepEqual(parsed.definition.hostModules, ["data.csv@1"]);
  assert.deepEqual(parsed.ignoredHostModules, ["npm.install-anything@1", "42"]);
});

test("select fields are validated and status controls receive safe offline defaults", () => {
  const parsed = validateAiDefinition({
    name: "事项跟踪",
    description: "跟踪事项处理状态",
    fields: [
      { key: "item", label: "事项", type: "text", required: true },
      { key: "status", label: "处理状态", type: "text", required: true }
    ],
    hostModules: []
  });
  const selected = selectHostModules(enhanceFieldControls(parsed.definition), "跟踪处理状态");
  assert.equal(selected.fields[1].type, "select");
  assert.deepEqual(selected.fields[1].options, ["待处理", "处理中", "已完成"]);
  assert.equal(evaluateRoomDefinitionQuality(selected, "跟踪处理状态").passed, true);
  assert.throws(() => validateDefinition({
    name: "错误下拉",
    fields: [{ key: "status", label: "状态", type: "select", required: true, options: ["同一个"] }]
  }), /至少需要 2 个选项/);
});

test("one-click generation repairs invalid model output and passes the local quality gate", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-generated-repair-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const calls = [];
  const aiService = {
    complete: async (options) => {
      calls.push(options);
      if (calls.length === 1) return { text: "not json", model: "mimo-v2.5", usage: { input: 1, output: 1 } };
      return {
        text: JSON.stringify({
          name: "项目问题台账",
          description: "记录问题、金额和处理进度",
          fields: [
            { key: "title", label: "问题标题", type: "text", required: true },
            { key: "loss_amount", label: "预计损失金额", type: "number", required: false },
            { key: "status", label: "处理状态", type: "select", required: true, options: ["待处理", "处理中", "已完成"] },
            { key: "notes", label: "详细说明", type: "textarea", required: false }
          ],
          hostModules: []
        }),
        model: "mimo-v2.5",
        usage: { input: 2, output: 2 }
      };
    }
  };
  const generated = await generateRoomFromPrompt({
    prompt: "创建问题台账，记录预计损失金额、处理状态和详细说明，支持搜索与 Excel 导出",
    aiService,
    roomStore: store
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].structuredOutput, true);
  assert.equal(calls[0].temperature, 0.1);
  assert.equal(generated.generationAttempts, 2);
  assert.equal(generated.repaired, true);
  assert.equal(generated.quality.passed, true);
  assert.deepEqual(generated.definition.fields.find((field) => field.key === "status").options, ["待处理", "处理中", "已完成"]);
  assert.equal(generated.definition.hostModules.includes("data.search@1"), true);
  assert.equal(generated.definition.hostModules.includes("document.spreadsheet@1"), true);
});

test("generated definition becomes an installed room", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-generated-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const room = await createGeneratedRoom({
    definition: {
      name: "会议台账",
      description: "跟踪会议事项",
      fields: [
        { key: "topic", label: "事项", type: "text", required: true },
        { key: "deadline", label: "截止日期", type: "date" }
      ]
    },
    roomStore: store
  });
  assert.match(room.id, /^local\.generated\./);
  assert.equal(room.name, "会议台账");
  const entry = await fsp.readFile(path.join(store.getProgramRoot(room.id), "app", "index.html"), "utf8");
  assert.match(entry, /智变房间/);
});

test("generated room declares and references only its selected offline modules", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-generated-modules-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const room = await createGeneratedRoom({
    definition: {
      name: "销售报表",
      description: "记录销售金额",
      fields: [{ key: "amount", label: "金额", type: "number" }],
      hostModules: ["data.decimal@1", "data.csv@1", "ui.chart@1", "document.spreadsheet@1"]
    },
    roomStore: store
  });
  assert.deepEqual(room.hostModules, ["data.decimal@1", "data.csv@1", "ui.chart@1", "document.spreadsheet@1"]);
  const manifest = JSON.parse(await fsp.readFile(path.join(store.getProgramRoot(room.id), "manifest.json"), "utf8"));
  assert.deepEqual(manifest.hostModules, room.hostModules);
  assert.deepEqual(manifest.permissions.files, ["pick", "export"]);
  const html = await fsp.readFile(path.join(store.getProgramRoot(room.id), "app", "index.html"), "utf8");
  assert.match(html, /_modules\/data\.decimal@1\/decimal\.js/);
  assert.match(html, /_modules\/data\.csv@1\/papaparse\.min\.js/);
  assert.match(html, /_modules\/ui\.chart@1\/chart\.umd\.js/);
  assert.match(html, /_modules\/document\.spreadsheet@1\/xlsx\.full\.min\.js/);
  assert.doesNotMatch(html, /dayjs\.min\.js/);
  const app = await fsp.readFile(path.join(store.getProgramRoot(room.id), "app", "app.js"), "utf8");
  assert.match(app, /room\.files\.exportBinary/);
  assert.match(app, /window\.XLSX\.write/);
});

test("AI safely updates only the structured definition and increments room version", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-generated-update-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const original = await createGeneratedRoom({
    definition: {
      name: "会议台账",
      description: "跟踪会议事项",
      fields: [{ key: "topic", label: "事项", type: "text", required: true }]
    },
    roomStore: store
  });
  const aiService = {
    complete: async () => ({
      text: JSON.stringify({
        name: "会议行动台账",
        description: "增加负责人和完成日期",
        fields: [
          { key: "topic", label: "事项", type: "text", required: true },
          { key: "owner", label: "负责人", type: "text", required: false },
          { key: "completed_on", label: "完成日期", type: "date", required: false }
        ]
      }),
      model: "fake-model",
      usage: { input: 1, output: 1 }
    })
  };
  const updated = await updateGeneratedRoomFromPrompt({
    roomId: original.id,
    prompt: "增加负责人和完成日期字段",
    aiService,
    roomStore: store
  });
  assert.equal(updated.room.id, original.id);
  assert.equal(updated.room.name, "会议行动台账");
  assert.equal(updated.room.version, "1.0.1");
  assert.equal(store.hasPermission(original.id, "files", "export"), true);
  const definitionText = await fsp.readFile(path.join(store.getProgramRoot(original.id), "app", "definition.js"), "utf8");
  const definition = parseGeneratedDefinition(definitionText);
  assert.deepEqual(definition.fields.map((field) => field.key), ["topic", "owner", "completed_on"]);
});

test("failed AI modification keeps the program intact and leaves a pre-change checkpoint", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-generated-failure-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const original = await createGeneratedRoom({
    definition: {
      name: "不可损坏台账",
      description: "验证失败回退",
      fields: [{ key: "topic", label: "事项", type: "text", required: true }]
    },
    roomStore: store
  });
  const definitionPath = path.join(store.getProgramRoot(original.id), "app", "definition.js");
  const manifestPath = path.join(store.getProgramRoot(original.id), "manifest.json");
  const beforeDefinition = await fsp.readFile(definitionPath, "utf8");
  const beforeManifest = await fsp.readFile(manifestPath, "utf8");
  const git = await new GitService(store, getTestGitToolchain()).init();
  await git.captureRoom(original.id, "AI 修改前", { kind: "ai-before" });

  const invalidAiService = {
    complete: async () => ({ text: "模型返回了无法解析的内容", model: "broken-model", usage: null })
  };
  await assert.rejects(
    () => updateGeneratedRoomFromPrompt({
      roomId: original.id,
      prompt: "增加负责人字段",
      aiService: invalidAiService,
      roomStore: store
    }),
    /没有返回房间定义 JSON/
  );

  assert.equal(await fsp.readFile(definitionPath, "utf8"), beforeDefinition);
  assert.equal(await fsp.readFile(manifestPath, "utf8"), beforeManifest);
  const history = await git.listHistory(original.id);
  assert.ok(history.checkpoints.some((checkpoint) => checkpoint.kind === "ai-before"));
  assert.equal(history.checkpoints.some((checkpoint) => checkpoint.kind === "ai-update"), false);
});

test("single-round AI modification gate honors the sharing flag and reports unsupported formats", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-modify-gate-"));
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
      permissions: {},
      hostModules: [],
      ...(sharing ? { sharing } : {})
    }), "utf8");
    await fsp.writeFile(path.join(source, "app", "index.html"), "<!doctype html><title>t</title>", "utf8");
    const packagePath = path.join(root, `${id}.room`);
    await packDirectory(source, packagePath);
    await store.installPackage(packagePath, { source: "external", selectedKeys: [] });
    return store.getRoom(id);
  };
  const restricted = await buildExternal("cn.example.restricted");
  const shared = await buildExternal("cn.example.shared", { allowAiModification: true });

  await assert.rejects(
    updateGeneratedRoomFromPrompt({ roomId: restricted.id, prompt: "把标题改成红色", aiService: null, roomStore: store }),
    /未开放 AI 修改/
  );
  // 已开放修改但不是声明式生成格式：给出明确指引而不是读取失败的底层报错
  await assert.rejects(
    updateGeneratedRoomFromPrompt({ roomId: shared.id, prompt: "把标题改成红色", aiService: null, roomStore: store }),
    /AI 创建对话/
  );
});
