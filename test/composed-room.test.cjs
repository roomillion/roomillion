"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RoomStore } = require("../src/main/room-store.cjs");
const {
  createComposedRoom,
  generateRoomFromPrompt,
  updateGeneratedRoomFromPrompt
} = require("../src/main/generated-room.cjs");
const {
  evaluateComposedQuality,
  generatedComposedAppJs,
  generatedComposedIndexHtml,
  parseComposedRoomSpec,
  validateComposedRoomSpec
} = require("../src/main/composed-room.cjs");

function dashboardSpec() {
  return {
    specVersion: "room-spec@1",
    kind: "composed",
    name: "销售经营驾驶舱",
    description: "录入销售数据并查看区域统计、趋势和明细",
    theme: "blue",
    data: [{
      id: "sales",
      label: "销售记录",
      fields: [
        { key: "customer", label: "客户", type: "text", required: true },
        { key: "region", label: "区域", type: "select", required: true, options: ["华东", "华南", "华北"] },
        { key: "amount", label: "销售额", type: "number", required: true },
        { key: "signed_on", label: "签约日期", type: "date", required: true }
      ],
      seed: [{ customer: "示例客户", region: "华东", amount: 12000, signed_on: "2026-08-01" }]
    }],
    actions: [{ id: "remove", type: "delete", label: "删除", source: "sales", tone: "danger" }],
    pages: [{
      id: "overview",
      title: "经营概览",
      layout: "grid",
      columns: 2,
      components: [
        { id: "sales_hero", type: "hero", title: "销售驾驶舱", text: "快速查看本地销售情况", badge: "离线数据", span: 2 },
        { id: "sales_stats", type: "stats", title: "核心指标", source: "sales", metrics: [{ label: "订单数", aggregate: "count" }, { label: "销售额", aggregate: "sum", field: "amount", prefix: "¥" }] },
        { id: "region_chart", type: "chart", title: "区域销售", source: "sales", chart: "bar", groupBy: "region", aggregate: "sum", valueField: "amount" },
        { id: "sales_form", type: "form", title: "登记销售", source: "sales", fields: ["customer", "region", "amount", "signed_on"], submitLabel: "保存销售" },
        { id: "sales_table", type: "table", title: "销售明细", source: "sales", fields: ["customer", "region", "amount", "signed_on"], search: true, actions: ["remove"], span: 2 },
        { id: "sales_export", type: "export", title: "导出数据", source: "sales", formats: ["xlsx", "csv", "json"] }
      ]
    }]
  };
}

function calculatorSpec() {
  return {
    specVersion: "room-spec@1",
    kind: "composed",
    name: "含税报价计算器",
    description: "根据单价、数量和税率即时计算未税价、税额和含税总价",
    theme: "amber",
    data: [],
    actions: [],
    pages: [{
      id: "calculator",
      title: "报价测算",
      layout: "stack",
      columns: 1,
      components: [
        { id: "quote_intro", type: "hero", title: "含税报价计算器", text: "数据只在当前页面计算，不上传网络", badge: "即时计算" },
        {
          id: "quote_calculator",
          type: "calculator",
          title: "输入报价参数",
          inputs: [
            { key: "price", label: "未税单价", defaultValue: 100, suffix: "元" },
            { key: "quantity", label: "数量", defaultValue: 10 },
            { key: "tax_rate", label: "税率", defaultValue: 13, suffix: "%" }
          ],
          outputs: [
            { label: "未税金额", expression: { op: "multiply", args: [{ input: "price" }, { input: "quantity" }] }, precision: 2, prefix: "¥" },
            { label: "税额", expression: { op: "percent", args: [{ op: "multiply", args: [{ input: "price" }, { input: "quantity" }] }, { input: "tax_rate" }] }, precision: 2, prefix: "¥" },
            { label: "含税总价", expression: { op: "add", args: [{ op: "multiply", args: [{ input: "price" }, { input: "quantity" }] }, { op: "percent", args: [{ op: "multiply", args: [{ input: "price" }, { input: "quantity" }] }, { input: "tax_rate" }] }] }, precision: 2, prefix: "¥" }
          ]
        }
      ]
    }]
  };
}

test("room-spec@1 selects only required built-in modules and rejects unsafe references", () => {
  const dashboard = validateComposedRoomSpec(dashboardSpec());
  assert.deepEqual(dashboard.hostModules, [
    "data.date@1",
    "data.decimal@1",
    "data.csv@1",
    "data.search@1",
    "ui.chart@1",
    "document.spreadsheet@1"
  ]);
  const calculator = validateComposedRoomSpec(calculatorSpec());
  assert.deepEqual(calculator.hostModules, ["data.decimal@1"]);
  assert.throws(() => validateComposedRoomSpec({ ...calculatorSpec(), specVersion: "room-spec@2" }), /版本必须是 room-spec@1/);
  assert.throws(() => validateComposedRoomSpec({
    ...calculatorSpec(),
    pages: [{ ...calculatorSpec().pages[0], components: [{ ...calculatorSpec().pages[0].components[1], inputs: [{ key: "price", label: "价格" }], outputs: [{ label: "危险", expression: { input: "process" } }] }] }]
  }), /未知输入/);
});

test("compiler emits materially different programs for a dashboard and a calculator", () => {
  const dashboard = validateComposedRoomSpec(dashboardSpec());
  const calculator = validateComposedRoomSpec(calculatorSpec());
  const dashboardHtml = generatedComposedIndexHtml(dashboard);
  const calculatorHtml = generatedComposedIndexHtml(calculator);
  assert.match(dashboardHtml, /data-component="chart"/);
  assert.match(dashboardHtml, /data-component="table"/);
  assert.match(dashboardHtml, /data-room-form/);
  assert.doesNotMatch(dashboardHtml, /data-component="calculator"/);
  assert.match(calculatorHtml, /data-component="calculator"/);
  assert.match(calculatorHtml, /data-calc-input="tax_rate"/);
  assert.doesNotMatch(calculatorHtml, /<table>/);
  assert.notEqual(dashboardHtml, calculatorHtml);
  assert.doesNotMatch(dashboardHtml + calculatorHtml, /https?:\/\//i);
  assert.doesNotThrow(() => new Function(generatedComposedAppJs()));
});

test("AI generation installs a composed room instead of the legacy fixed ledger", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-composed-generate-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const aiService = {
    complete: async () => ({ text: JSON.stringify(dashboardSpec()), model: "mimo-v2.5", usage: { input: 100, output: 500 } })
  };
  const result = await generateRoomFromPrompt({
    prompt: "创建销售经营仪表盘，能录入数据、搜索、看图表并导出 Excel",
    aiService,
    roomStore: store
  });
  assert.equal(result.spec.kind, "composed");
  assert.equal(result.quality.passed, true);
  const root = store.getProgramRoot(result.room.id);
  const definitionText = await fsp.readFile(path.join(root, "app", "definition.js"), "utf8");
  assert.match(definitionText, /^window\.ROOM_SPEC = /);
  assert.doesNotMatch(definitionText, /^window\.ROOM_DEFINITION = /);
  const parsed = parseComposedRoomSpec(definitionText);
  assert.equal(parsed.pages[0].components.some((component) => component.type === "chart"), true);
  const manifest = JSON.parse(await fsp.readFile(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.embeddedDependencies, []);
  assert.deepEqual(manifest.permissions.network, []);
  assert.equal(manifest.hostModules.includes("ui.chart@1"), true);
});

test("AI modifies a composed room as a complete spec while keeping room identity", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-composed-update-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const store = await new RoomStore(tempRoot).init();
  const original = await createComposedRoom({ spec: calculatorSpec(), roomStore: store });
  const changed = calculatorSpec();
  changed.name = "折扣与含税报价计算器";
  changed.pages[0].components[1].inputs.push({ key: "discount", label: "折扣", defaultValue: 95, suffix: "%" });
  changed.pages[0].components[1].outputs.push({
    label: "折后含税价",
    expression: { op: "percent", args: [changed.pages[0].components[1].outputs[2].expression, { input: "discount" }] },
    precision: 2,
    prefix: "¥"
  });
  const aiService = { complete: async () => ({ text: JSON.stringify(changed), model: "mimo-v2.5", usage: null }) };
  const result = await updateGeneratedRoomFromPrompt({ roomId: original.id, prompt: "增加折扣输入和折后含税价", aiService, roomStore: store });
  assert.equal(result.room.id, original.id);
  assert.equal(result.room.version, "1.0.1");
  assert.equal(result.spec.name, "折扣与含税报价计算器");
  assert.match(await fsp.readFile(path.join(store.getProgramRoot(original.id), "app", "index.html"), "utf8"), /data-calc-input="discount"/);
});

test("quality gate checks requested room shape rather than accepting a generic ledger", () => {
  const calculator = validateComposedRoomSpec(calculatorSpec());
  assert.equal(evaluateComposedQuality(calculator, "创建一个报价计算器").passed, true);
  assert.equal(evaluateComposedQuality(calculator, "创建一个带搜索和图表的销售仪表盘").passed, false);
});
