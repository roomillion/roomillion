"use strict";

const { expandHostModules, getRoomModule } = require("./room-module-catalog.cjs");

const ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_TYPES = new Set(["text", "textarea", "number", "date", "select", "boolean"]);
const COMPONENT_TYPES = new Set(["hero", "text", "stats", "form", "table", "cards", "board", "chart", "calculator", "export"]);
const THEMES = new Set(["emerald", "blue", "violet", "amber", "rose", "slate"]);
const LAYOUTS = new Set(["stack", "grid"]);
const CHART_TYPES = new Set(["bar", "line", "doughnut"]);
const AGGREGATES = new Set(["count", "sum", "average", "min", "max"]);
const ACTION_TYPES = new Set(["set-field", "toggle", "delete"]);
const FORMATS = new Set(["xlsx", "csv", "json"]);
const EXPRESSION_OPS = new Set(["add", "subtract", "multiply", "divide", "percent", "min", "max"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maximum, fallback = "") {
  const result = String(value ?? "").trim().slice(0, maximum);
  return result || fallback;
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} 必须是小写英文标识符`);
  return value;
}

function uniqueStrings(values, maximum, label) {
  if (!Array.isArray(values)) throw new Error(`${label} 必须是数组`);
  const normalized = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, maximum);
  if (normalized.length !== values.length) throw new Error(`${label} 包含空值或重复值`);
  return normalized;
}

function validateField(input, index) {
  if (!isPlainObject(input)) throw new Error(`第 ${index + 1} 个字段格式无效`);
  const key = assertId(input.key, `第 ${index + 1} 个字段 key`);
  const label = cleanText(input.label, 40);
  if (!label) throw new Error(`字段 ${key} 缺少标签`);
  if (!FIELD_TYPES.has(input.type)) throw new Error(`字段“${label}”类型无效`);
  const field = { key, label, type: input.type, required: Boolean(input.required) };
  if (input.type === "select") {
    field.options = uniqueStrings(input.options, 12, `字段“${label}”的 options`);
    if (field.options.length < 2) throw new Error(`下拉字段“${label}”至少需要 2 个选项`);
  }
  if (input.placeholder !== undefined) field.placeholder = cleanText(input.placeholder, 80);
  return field;
}

function normalizeSeedValue(field, value) {
  if (field.type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  if (field.type === "boolean") return Boolean(value);
  if (field.type === "select") return field.options.includes(String(value)) ? String(value) : field.options[0];
  return String(value ?? "").slice(0, field.type === "textarea" ? 4000 : 500);
}

function validateDataSource(input, index) {
  if (!isPlainObject(input)) throw new Error(`第 ${index + 1} 个数据源格式无效`);
  const id = assertId(input.id, `第 ${index + 1} 个数据源 id`);
  const label = cleanText(input.label, 40);
  if (!label) throw new Error(`数据源 ${id} 缺少标签`);
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 16) {
    throw new Error(`数据源“${label}”必须包含 1-16 个字段`);
  }
  const fields = input.fields.map(validateField);
  if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error(`数据源“${label}”字段 key 重复`);
  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  const seed = Array.isArray(input.seed) ? input.seed.slice(0, 30).map((row) => {
    if (!isPlainObject(row)) throw new Error(`数据源“${label}”的示例数据格式无效`);
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      const field = fieldMap.get(key);
      if (field) normalized[key] = normalizeSeedValue(field, value);
    }
    return normalized;
  }) : [];
  return { id, label, fields, seed };
}

function validateExpression(input, inputKeys, depth = 0) {
  if (depth > 8) throw new Error("计算表达式嵌套过深");
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (!isPlainObject(input)) throw new Error("计算表达式格式无效");
  if (typeof input.input === "string") {
    if (!inputKeys.has(input.input)) throw new Error(`计算表达式引用了未知输入：${input.input}`);
    return { input: input.input };
  }
  if (!EXPRESSION_OPS.has(input.op)) throw new Error(`不支持的计算操作：${String(input.op)}`);
  if (!Array.isArray(input.args) || input.args.length < 1 || input.args.length > 8) throw new Error(`计算操作 ${input.op} 的参数无效`);
  if (["subtract", "divide", "percent"].includes(input.op) && input.args.length !== 2) {
    throw new Error(`计算操作 ${input.op} 必须有 2 个参数`);
  }
  return { op: input.op, args: input.args.map((argument) => validateExpression(argument, inputKeys, depth + 1)) };
}

function validateCalculator(input) {
  if (!Array.isArray(input.inputs) || input.inputs.length < 1 || input.inputs.length > 12) throw new Error("计算器必须包含 1-12 个输入");
  const inputs = input.inputs.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`第 ${index + 1} 个计算器输入无效`);
    const key = assertId(item.key, `第 ${index + 1} 个计算器输入 key`);
    const label = cleanText(item.label, 40);
    if (!label) throw new Error(`计算器输入 ${key} 缺少标签`);
    const defaultValue = Number(item.defaultValue ?? 0);
    return { key, label, defaultValue: Number.isFinite(defaultValue) ? defaultValue : 0, suffix: cleanText(item.suffix, 16) };
  });
  const inputKeys = new Set(inputs.map((item) => item.key));
  if (inputKeys.size !== inputs.length) throw new Error("计算器输入 key 重复");
  if (!Array.isArray(input.outputs) || input.outputs.length < 1 || input.outputs.length > 12) throw new Error("计算器必须包含 1-12 个输出");
  const outputs = input.outputs.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`第 ${index + 1} 个计算器输出无效`);
    const label = cleanText(item.label, 40);
    if (!label) throw new Error(`第 ${index + 1} 个计算器输出缺少标签`);
    return {
      label,
      expression: validateExpression(item.expression, inputKeys),
      precision: Math.max(0, Math.min(8, Number.isInteger(item.precision) ? item.precision : 2)),
      prefix: cleanText(item.prefix, 16),
      suffix: cleanText(item.suffix, 16)
    };
  });
  return { inputs, outputs };
}

function componentSource(input, sources, label) {
  const source = assertId(input.source, `${label} source`);
  if (!sources.has(source)) throw new Error(`${label} 引用了未知数据源：${source}`);
  return sources.get(source);
}

function componentFields(input, source, property, maximum = 16) {
  const available = new Set(source.fields.map((field) => field.key));
  const requested = input[property] === undefined ? source.fields.map((field) => field.key) : uniqueStrings(input[property], maximum, property);
  for (const field of requested) if (!available.has(field)) throw new Error(`组件引用了未知字段：${field}`);
  return requested;
}

function validateComponent(input, index, sources, actions) {
  if (!isPlainObject(input)) throw new Error(`第 ${index + 1} 个组件格式无效`);
  const id = assertId(input.id, `第 ${index + 1} 个组件 id`);
  if (!COMPONENT_TYPES.has(input.type)) throw new Error(`组件 ${id} 类型无效：${String(input.type)}`);
  const component = { id, type: input.type, title: cleanText(input.title, 60) };
  if (input.span !== undefined) component.span = Math.max(1, Math.min(3, Number(input.span) || 1));
  if (input.type === "hero") {
    component.title = component.title || "欢迎使用";
    component.text = cleanText(input.text, 500);
    component.badge = cleanText(input.badge, 32);
  } else if (input.type === "text") {
    component.content = cleanText(input.content, 8000);
    component.format = input.format === "markdown" ? "markdown" : "plain";
  } else if (input.type === "calculator") {
    Object.assign(component, validateCalculator(input));
  } else {
    const source = componentSource(input, sources, `组件 ${id}`);
    component.source = source.id;
    if (input.type === "form") {
      component.fields = componentFields(input, source, "fields");
      component.submitLabel = cleanText(input.submitLabel, 30, "保存");
    } else if (["table", "cards", "board"].includes(input.type)) {
      component.fields = componentFields(input, source, "fields");
      component.search = Boolean(input.search);
      component.actions = input.actions === undefined ? [] : uniqueStrings(input.actions, 8, "actions");
      for (const actionId of component.actions) if (!actions.has(actionId)) throw new Error(`组件 ${id} 引用了未知动作：${actionId}`);
      if (input.type === "board") {
        component.groupBy = assertId(input.groupBy, `组件 ${id} groupBy`);
        const groupField = source.fields.find((field) => field.key === component.groupBy);
        if (!groupField || groupField.type !== "select") throw new Error(`看板 ${id} 的 groupBy 必须引用 select 字段`);
        component.titleField = input.titleField ? assertId(input.titleField, `组件 ${id} titleField`) : source.fields[0].key;
        if (!source.fields.some((field) => field.key === component.titleField)) throw new Error(`看板 ${id} 的标题字段不存在`);
      }
    } else if (input.type === "stats") {
      if (!Array.isArray(input.metrics) || input.metrics.length < 1 || input.metrics.length > 8) throw new Error(`统计组件 ${id} 必须包含 1-8 个指标`);
      component.metrics = input.metrics.map((metric, metricIndex) => {
        if (!isPlainObject(metric)) throw new Error(`统计组件 ${id} 的第 ${metricIndex + 1} 个指标无效`);
        const aggregate = AGGREGATES.has(metric.aggregate) ? metric.aggregate : "count";
        const normalized = { label: cleanText(metric.label, 40, aggregate === "count" ? "记录数" : "统计值"), aggregate };
        if (aggregate !== "count") {
          normalized.field = assertId(metric.field, `统计组件 ${id} 指标字段`);
          const field = source.fields.find((candidate) => candidate.key === normalized.field);
          if (!field || field.type !== "number") throw new Error(`统计组件 ${id} 的 ${aggregate} 必须引用 number 字段`);
        }
        normalized.prefix = cleanText(metric.prefix, 16);
        normalized.suffix = cleanText(metric.suffix, 16);
        return normalized;
      });
    } else if (input.type === "chart") {
      component.chart = CHART_TYPES.has(input.chart) ? input.chart : "bar";
      component.groupBy = assertId(input.groupBy, `图表 ${id} groupBy`);
      if (!source.fields.some((field) => field.key === component.groupBy)) throw new Error(`图表 ${id} 的分组字段不存在`);
      component.aggregate = ["count", "sum", "average"].includes(input.aggregate) ? input.aggregate : "count";
      if (component.aggregate !== "count") {
        component.valueField = assertId(input.valueField, `图表 ${id} valueField`);
        const field = source.fields.find((candidate) => candidate.key === component.valueField);
        if (!field || field.type !== "number") throw new Error(`图表 ${id} 的数值字段必须是 number`);
      }
    } else if (input.type === "export") {
      component.formats = input.formats === undefined ? ["xlsx", "csv", "json"] : uniqueStrings(input.formats, 3, "formats");
      if (!component.formats.length || component.formats.some((format) => !FORMATS.has(format))) throw new Error(`导出组件 ${id} 格式无效`);
    }
  }
  return component;
}

function validateAction(input, index, sources) {
  if (!isPlainObject(input)) throw new Error(`第 ${index + 1} 个动作格式无效`);
  const id = assertId(input.id, `第 ${index + 1} 个动作 id`);
  if (!ACTION_TYPES.has(input.type)) throw new Error(`动作 ${id} 类型无效`);
  const source = componentSource(input, sources, `动作 ${id}`);
  const action = { id, type: input.type, label: cleanText(input.label, 30, "执行"), source: source.id, tone: ["primary", "success", "danger"].includes(input.tone) ? input.tone : "primary" };
  if (input.type === "set-field" || input.type === "toggle") {
    action.field = assertId(input.field, `动作 ${id} field`);
    const field = source.fields.find((candidate) => candidate.key === action.field);
    if (!field) throw new Error(`动作 ${id} 引用了未知字段`);
    if (input.type === "toggle" && field.type !== "boolean") throw new Error(`动作 ${id} 只能切换 boolean 字段`);
    if (input.type === "set-field") action.value = normalizeSeedValue(field, input.value);
  }
  return action;
}

function legacyDefinitionToComposedSpec(input) {
  const fields = Array.isArray(input.fields) ? input.fields : [];
  return {
    specVersion: "room-spec@1",
    kind: "composed",
    name: input.name,
    description: input.description,
    theme: "emerald",
    data: [{ id: "records", label: "记录", fields }],
    actions: [{ id: "remove", type: "delete", label: "删除", source: "records", tone: "danger" }],
    pages: [{
      id: "main",
      title: input.name || "工作台",
      layout: "grid",
      columns: 2,
      components: [
        { id: "intro", type: "hero", title: input.name, text: input.description, span: 2 },
        { id: "record_form", type: "form", title: "新增记录", source: "records", fields: fields.map((field) => field.key), span: 1 },
        { id: "record_table", type: "table", title: "记录列表", source: "records", fields: fields.map((field) => field.key), actions: ["remove"], search: false, span: 2 }
      ]
    }]
  };
}

function validateComposedRoomSpec(input) {
  if (!isPlainObject(input)) throw new Error("房间规格必须是 JSON 对象");
  const legacy = Array.isArray(input.fields) && !Array.isArray(input.pages);
  const candidate = legacy ? legacyDefinitionToComposedSpec(input) : input;
  if (!legacy && candidate.specVersion !== "room-spec@1") throw new Error("房间规格版本必须是 room-spec@1");
  if (!legacy && candidate.kind !== "composed") throw new Error("room-spec@1 的 kind 必须是 composed");
  const name = cleanText(candidate.name, 60);
  const description = cleanText(candidate.description, 300);
  if (!name) throw new Error("房间规格缺少名称");
  if (description.length < 4) throw new Error("房间规格说明过短");
  if (!Array.isArray(candidate.data) || candidate.data.length > 4) throw new Error("房间最多包含 4 个数据源");
  const data = candidate.data.map(validateDataSource);
  const sources = new Map(data.map((source) => [source.id, source]));
  if (sources.size !== data.length) throw new Error("数据源 id 重复");
  const rawActions = Array.isArray(candidate.actions) ? candidate.actions : [];
  if (rawActions.length > 20) throw new Error("房间最多包含 20 个动作");
  const validatedActions = rawActions.map((action, index) => validateAction(action, index, sources));
  const actionMap = new Map(validatedActions.map((action) => [action.id, action]));
  if (actionMap.size !== validatedActions.length) throw new Error("动作 id 重复");
  if (!Array.isArray(candidate.pages) || candidate.pages.length < 1 || candidate.pages.length > 6) throw new Error("房间必须包含 1-6 个页面");
  const componentIds = new Set();
  const pages = candidate.pages.map((page, pageIndex) => {
    if (!isPlainObject(page)) throw new Error(`第 ${pageIndex + 1} 个页面格式无效`);
    const id = assertId(page.id, `第 ${pageIndex + 1} 个页面 id`);
    const title = cleanText(page.title, 50, `页面 ${pageIndex + 1}`);
    if (!Array.isArray(page.components) || page.components.length < 1 || page.components.length > 20) throw new Error(`页面“${title}”必须包含 1-20 个组件`);
    const components = page.components.map((component, index) => validateComponent(component, index, sources, actionMap));
    for (const component of components) {
      if (componentIds.has(component.id)) throw new Error(`组件 id 重复：${component.id}`);
      componentIds.add(component.id);
    }
    return {
      id,
      title,
      layout: LAYOUTS.has(page.layout) ? page.layout : "grid",
      columns: Math.max(1, Math.min(3, Number(page.columns) || 2)),
      components
    };
  });
  if (new Set(pages.map((page) => page.id)).size !== pages.length) throw new Error("页面 id 重复");
  const spec = {
    specVersion: "room-spec@1",
    kind: "composed",
    name,
    description,
    theme: THEMES.has(candidate.theme) ? candidate.theme : "emerald",
    data,
    actions: validatedActions,
    pages
  };
  spec.hostModules = deriveComposedHostModules(spec);
  return spec;
}

function allComponents(spec) {
  return spec.pages.flatMap((page) => page.components);
}

function deriveComposedHostModules(spec) {
  const selected = new Set();
  for (const source of spec.data) {
    if (source.fields.some((field) => field.type === "date")) selected.add("data.date@1");
    if (source.fields.some((field) => field.type === "number")) selected.add("data.decimal@1");
  }
  for (const component of allComponents(spec)) {
    if (component.type === "chart") selected.add("ui.chart@1");
    if (component.search) selected.add("data.search@1");
    if (component.type === "text" && component.format === "markdown") selected.add("document.markdown@1");
    if (component.type === "calculator") selected.add("data.decimal@1");
    if (component.type === "export") {
      if (component.formats.includes("xlsx")) selected.add("document.spreadsheet@1");
      if (component.formats.includes("csv")) selected.add("data.csv@1");
    }
  }
  return expandHostModules([...selected]);
}

function enrichComposedSpecForPrompt(spec, prompt) {
  const text = String(prompt || "");
  const clone = JSON.parse(JSON.stringify(spec));
  const components = clone.pages.flatMap((page) => page.components);
  const firstSource = clone.data[0];
  if (firstSource && /(?:搜索|查询|检索|查找|筛选|模糊匹配)/i.test(text)) {
    const list = components.find((component) => ["table", "cards", "board"].includes(component.type));
    if (list) list.search = true;
  }
  if (firstSource && /(?:导出|excel|xlsx|csv|电子表格)/i.test(text) && !components.some((component) => component.type === "export")) {
    clone.pages[0].components.push({
      id: "data_export",
      type: "export",
      title: "导出数据",
      source: firstSource.id,
      formats: /csv/i.test(text) && !/(?:excel|xlsx|电子表格)/i.test(text) ? ["csv", "json"] : ["xlsx", "csv", "json"]
    });
  }
  if (firstSource && /(?:图表|趋势|可视化)/i.test(text) && !components.some((component) => component.type === "chart")) {
    const groupField = firstSource.fields.find((field) => ["select", "date", "text"].includes(field.type)) || firstSource.fields[0];
    const valueField = firstSource.fields.find((field) => field.type === "number");
    clone.pages[0].components.push({
      id: "overview_chart",
      type: "chart",
      title: "数据图表",
      source: firstSource.id,
      chart: "bar",
      groupBy: groupField.key,
      aggregate: valueField ? "sum" : "count",
      ...(valueField ? { valueField: valueField.key } : {})
    });
  }
  if (firstSource && /(?:仪表盘|概览|关键指标|统计)/i.test(text) && !components.some((component) => component.type === "stats")) {
    const numberField = firstSource.fields.find((field) => field.type === "number");
    clone.pages[0].components.unshift({
      id: "overview_stats",
      type: "stats",
      title: "数据概览",
      source: firstSource.id,
      metrics: [
        { label: `${firstSource.label}总数`, aggregate: "count" },
        ...(numberField ? [{ label: `${numberField.label}合计`, aggregate: "sum", field: numberField.key }] : [])
      ],
      span: 2
    });
  }
  return validateComposedRoomSpec(clone);
}

function evaluateComposedQuality(spec, prompt) {
  const text = String(prompt || "");
  const components = allComponents(spec);
  const checks = {
    hasRealStructure: components.length >= 2 || components.some((component) => component.type === "calculator"),
    requestedDashboard: !/(?:仪表盘|数据看板|经营看板|统计概览)/i.test(text) || components.some((component) => ["stats", "chart", "board"].includes(component.type)),
    requestedChart: !/(?:图表|趋势|可视化)/i.test(text) || components.some((component) => component.type === "chart"),
    requestedCalculator: !/(?:计算器|测算|换算|计算工具)/i.test(text) || components.some((component) => component.type === "calculator"),
    requestedBoard: !/(?:看板|kanban)/i.test(text) || components.some((component) => component.type === "board"),
    requestedForm: !/(?:录入|登记|表单|新增记录)/i.test(text) || components.some((component) => component.type === "form"),
    requestedSearch: !/(?:搜索|查询|检索|查找|筛选)/i.test(text) || components.some((component) => component.search),
    requestedExport: !/(?:导出|excel|xlsx|csv|电子表格)/i.test(text) || components.some((component) => component.type === "export"),
    requestedMultiplePages: !/(?:多页面|多个页面|分页应用|分别一个页面)/i.test(text) || spec.pages.length > 1
  };
  const labels = {
    hasRealStructure: "房间没有形成可用的组件结构",
    requestedDashboard: "要求仪表盘但缺少统计、图表或看板",
    requestedChart: "要求图表但缺少 chart 组件",
    requestedCalculator: "要求计算器但缺少 calculator 组件",
    requestedBoard: "要求看板但缺少 board 组件",
    requestedForm: "要求录入但缺少 form 组件",
    requestedSearch: "要求搜索但列表组件未启用 search",
    requestedExport: "要求导出但缺少 export 组件",
    requestedMultiplePages: "要求多页面但只生成了一个页面"
  };
  const issues = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => labels[key]);
  return { passed: issues.length === 0, checks, issues };
}

function generatedModuleScripts(hostModules) {
  return hostModules.flatMap((moduleId) => {
    const module = getRoomModule(moduleId);
    return module.assets.filter((asset) => asset.type === "script").map((asset) => `  <script src="/_modules/${moduleId}/${asset.publicName}"></script>`);
  }).join("\n");
}

function generatedModuleStyles(hostModules) {
  return hostModules.flatMap((moduleId) => {
    const module = getRoomModule(moduleId);
    return module.assets.filter((asset) => asset.type === "style").map((asset) => `  <link rel="stylesheet" href="/_modules/${moduleId}/${asset.publicName}">`);
  }).join("\n");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function fieldInputHtml(field) {
  const common = `name="${field.key}" data-field="${field.key}"${field.required ? " required" : ""}`;
  if (field.type === "textarea") return `<label><span>${escapeHtml(field.label)}</span><textarea ${common} placeholder="${escapeHtml(field.placeholder || "请输入内容")}"></textarea></label>`;
  if (field.type === "select") return `<label><span>${escapeHtml(field.label)}</span><select ${common}><option value="">请选择</option>${field.options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}</select></label>`;
  if (field.type === "boolean") return `<label class="checkField"><input type="checkbox" ${common}><span>${escapeHtml(field.label)}</span></label>`;
  return `<label><span>${escapeHtml(field.label)}</span><input type="${field.type}" ${common}${field.type === "number" ? " step=\"any\"" : ""} placeholder="${escapeHtml(field.placeholder || "")}"></label>`;
}

function componentHtml(component, sourceMap, actionMap) {
  const title = component.title ? `<h2>${escapeHtml(component.title)}</h2>` : "";
  const span = ` style="--span:${component.span || 1}"`;
  if (component.type === "hero") return `<section id="${component.id}" class="component hero" data-component="hero"${span}>${component.badge ? `<p class="badge">${escapeHtml(component.badge)}</p>` : ""}<h1>${escapeHtml(component.title)}</h1><p>${escapeHtml(component.text)}</p></section>`;
  if (component.type === "text") return `<section id="${component.id}" class="component card" data-component="text" data-format="${component.format}"${span}>${title}<div class="prose" data-text-content></div></section>`;
  if (component.type === "stats") return `<section id="${component.id}" class="component card" data-component="stats" data-source="${component.source}"${span}>${title}<div class="metricGrid" data-metrics></div></section>`;
  if (component.type === "form") {
    const source = sourceMap.get(component.source);
    const fields = component.fields.map((key) => source.fields.find((field) => field.key === key));
    return `<section id="${component.id}" class="component card" data-component="form" data-source="${component.source}"${span}>${title}<form data-room-form><div class="formGrid">${fields.map(fieldInputHtml).join("")}</div><button type="submit">${escapeHtml(component.submitLabel)}</button></form></section>`;
  }
  if (component.type === "table") {
    const source = sourceMap.get(component.source);
    const fields = component.fields.map((key) => source.fields.find((field) => field.key === key));
    return `<section id="${component.id}" class="component card" data-component="table" data-source="${component.source}"${span}><div class="componentHead">${title}<span data-count></span></div>${component.search ? `<input class="search" type="search" data-search placeholder="搜索${escapeHtml(source.label)}">` : ""}<div class="tableWrap"><table><thead><tr>${fields.map((field) => `<th>${escapeHtml(field.label)}</th>`).join("")} ${component.actions.length ? "<th>操作</th>" : ""}</tr></thead><tbody data-rows></tbody></table></div></section>`;
  }
  if (component.type === "cards") return `<section id="${component.id}" class="component card" data-component="cards" data-source="${component.source}"${span}><div class="componentHead">${title}<span data-count></span></div>${component.search ? `<input class="search" type="search" data-search placeholder="搜索内容">` : ""}<div class="cards" data-rows></div></section>`;
  if (component.type === "board") return `<section id="${component.id}" class="component card" data-component="board" data-source="${component.source}"${span}><div class="componentHead">${title}<span data-count></span></div>${component.search ? `<input class="search" type="search" data-search placeholder="搜索看板">` : ""}<div class="board" data-rows></div></section>`;
  if (component.type === "chart") return `<section id="${component.id}" class="component card" data-component="chart" data-source="${component.source}"${span}>${title}<div class="chartBox"><canvas></canvas><p class="empty" data-empty hidden>暂无可绘制的数据</p></div></section>`;
  if (component.type === "calculator") return `<section id="${component.id}" class="component card calculator" data-component="calculator"${span}>${title}<div class="formGrid">${component.inputs.map((input) => `<label><span>${escapeHtml(input.label)}</span><div class="withSuffix"><input type="number" step="any" data-calc-input="${input.key}" value="${input.defaultValue}">${input.suffix ? `<em>${escapeHtml(input.suffix)}</em>` : ""}</div></label>`).join("")}</div><div class="metricGrid" data-calc-outputs>${component.outputs.map((output, index) => `<article class="metric"><span>${escapeHtml(output.label)}</span><strong data-calc-output="${index}">—</strong></article>`).join("")}</div></section>`;
  if (component.type === "export") return `<section id="${component.id}" class="component card" data-component="export" data-source="${component.source}"${span}>${title}<div class="exportButtons">${component.formats.map((format) => `<button type="button" class="secondary" data-export="${format}">导出 ${format.toUpperCase()}</button>`).join("")}</div></section>`;
  return "";
}

function generatedComposedIndexHtml(spec) {
  const sourceMap = new Map(spec.data.map((source) => [source.id, source]));
  const actionMap = new Map(spec.actions.map((action) => [action.id, action]));
  const nav = spec.pages.length > 1 ? `<nav class="pageNav" aria-label="房间页面">${spec.pages.map((page, index) => `<button type="button" data-page-target="${page.id}"${index === 0 ? " class=\"active\"" : ""}>${escapeHtml(page.title)}</button>`).join("")}</nav>` : "";
  const pages = spec.pages.map((page, index) => `<section class="roomPage ${page.layout}" data-page="${page.id}" style="--columns:${page.columns}"${index === 0 ? "" : " hidden"}>${page.components.map((component) => componentHtml(component, sourceMap, actionMap)).join("\n")}</section>`).join("\n");
  const moduleScripts = generatedModuleScripts(spec.hostModules);
  const moduleStyles = generatedModuleStyles(spec.hostModules);
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(spec.name)}</title>${moduleStyles ? `\n${moduleStyles}` : ""}<link rel="stylesheet" href="./styles.css"></head>
<body data-theme="${spec.theme}"><header class="appBar"><div><p>智变 · 组合房间</p><strong>${escapeHtml(spec.name)}</strong></div>${nav}</header><main>${pages}</main><div id="roomStatus" role="status" aria-live="polite"></div>
<script src="./definition.js"></script>
${moduleScripts ? `${moduleScripts}\n` : ""}<script src="./app.js"></script></body></html>`;
}

function generatedComposedStyles() {
  return `:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#17211d;background:#f3f6f4;color-scheme:light;--accent:#147b5b;--soft:#e7f3ee;--line:#dce6e0;--shadow:0 10px 30px rgba(24,55,44,.07)}*{box-sizing:border-box}body{margin:0;min-height:100vh}body[data-theme=blue]{--accent:#2867c7;--soft:#e8f0ff}body[data-theme=violet]{--accent:#7357c7;--soft:#f0ebff}body[data-theme=amber]{--accent:#a76011;--soft:#fff1dc}body[data-theme=rose]{--accent:#b64064;--soft:#ffeaf0}body[data-theme=slate]{--accent:#405466;--soft:#e8eef2}.appBar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:22px;padding:14px 28px;background:rgba(255,255,255,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.appBar p{margin:0;color:var(--accent);font-size:11px;font-weight:800;letter-spacing:.12em}.appBar strong{font-size:18px}.pageNav{display:flex;gap:8px;overflow:auto}.pageNav button{background:transparent;color:#516159;padding:8px 12px}.pageNav button.active{background:var(--soft);color:var(--accent)}main{max-width:1280px;margin:0 auto;padding:28px}.roomPage.grid{display:grid;grid-template-columns:repeat(var(--columns),minmax(0,1fr));gap:18px}.roomPage.stack{display:flex;flex-direction:column;gap:18px}.roomPage[hidden]{display:none}.component{grid-column:span min(var(--span),var(--columns))}.card,.hero{background:#fff;border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:var(--shadow)}.hero{background:linear-gradient(135deg,var(--soft),#fff);min-height:150px;display:flex;flex-direction:column;justify-content:center}.hero h1{font-size:32px;margin:4px 0 8px}.hero p{max-width:760px;margin:0;color:#52645b;line-height:1.7}.badge{align-self:flex-start!important;background:var(--accent);color:#fff!important;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:800}.card h2{font-size:18px;margin:0 0 16px}.componentHead{display:flex;align-items:center;justify-content:space-between;gap:12px}.componentHead h2{margin:0 0 14px}.componentHead span{color:#718078;font-size:12px}.formGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:16px}label{display:flex;flex-direction:column;gap:7px;font-size:13px;font-weight:700}input,textarea,select{width:100%;border:1px solid #c9d6cf;border-radius:10px;background:#fbfdfc;padding:10px 12px;font:inherit}textarea{min-height:90px;resize:vertical}.checkField{flex-direction:row;align-items:center;margin-top:25px}.checkField input{width:auto}.withSuffix{display:flex;align-items:center;gap:8px}.withSuffix em{font-style:normal;color:#65756d}button{border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:750;padding:10px 15px;cursor:pointer}.secondary{background:var(--soft);color:var(--accent)}.danger{background:#fff0ed;color:#a63f2c}.success{background:#e7f5ed;color:#247044}.search{margin-bottom:14px}.tableWrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e6ece8;padding:11px 9px;vertical-align:top}th{color:#607168;font-size:11px;text-transform:uppercase}.rowActions{display:flex;flex-wrap:wrap;gap:6px}.rowActions button{padding:6px 9px;font-size:11px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.dataCard{border:1px solid var(--line);border-radius:13px;padding:14px}.dataCard h3{margin:0 0 10px}.dataCard dl{margin:0;display:grid;gap:8px}.dataCard dt{color:#748179;font-size:11px}.dataCard dd{margin:2px 0 0;white-space:pre-wrap}.metricGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}.metric{background:var(--soft);border-radius:13px;padding:14px}.metric span{display:block;color:#68776f;font-size:12px}.metric strong{display:block;font-size:24px;margin-top:5px;color:var(--accent)}.chartBox{height:300px;position:relative}.empty{color:#718078}.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:start}.boardColumn{background:#f5f7f6;border-radius:14px;padding:11px;min-height:130px}.boardColumn h3{margin:2px 3px 10px;font-size:14px}.boardItem{background:#fff;border:1px solid var(--line);border-radius:11px;padding:11px;margin-bottom:9px}.boardItem strong{display:block;margin-bottom:8px}.boardItem select{margin:8px 0}.prose{line-height:1.75}.prose>:first-child{margin-top:0}.prose>:last-child{margin-bottom:0}.exportButtons{display:flex;gap:9px;flex-wrap:wrap}#roomStatus{position:fixed;right:22px;bottom:18px;max-width:460px;background:#10251d;color:#fff;border-radius:10px;padding:10px 14px;opacity:0;transform:translateY(8px);transition:.18s;pointer-events:none;font-size:13px}#roomStatus.show{opacity:.94;transform:none}@media(max-width:800px){.appBar{align-items:flex-start;flex-direction:column;padding:12px 18px}.roomPage.grid{grid-template-columns:1fr!important}.component{grid-column:1!important}main{padding:18px}.hero h1{font-size:26px}}`;
}

function composedBrowserRuntime() {
  "use strict";
  const spec = window.ROOM_SPEC;
  const sourceMap = new Map(spec.data.map((source) => [source.id, source]));
  const componentMap = new Map(spec.pages.flatMap((page) => page.components).map((component) => [component.id, component]));
  const actionMap = new Map(spec.actions.map((action) => [action.id, action]));
  const rowsBySource = new Map();
  const charts = new Map();
  let FuseClass = null;
  const status = document.getElementById("roomStatus");

  function notify(message, error) {
    status.textContent = message;
    status.style.background = error ? "#812d22" : "#10251d";
    status.classList.add("show");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => status.classList.remove("show"), 2600);
  }

  function parsedRow(row) {
    try { return { id: row.id, values: JSON.parse(row.payload), createdAt: row.created_at, updatedAt: row.updated_at }; }
    catch { return { id: row.id, values: {}, createdAt: row.created_at, updatedAt: row.updated_at }; }
  }

  function display(field, value) {
    if (field.type === "boolean") return value ? "是" : "否";
    if (field.type === "date" && value && window.dayjs) {
      const parsed = window.dayjs(value);
      if (parsed.isValid()) return parsed.format("YYYY-MM-DD");
    }
    return value === undefined || value === null || value === "" ? "—" : String(value);
  }

  function searchable(row) { return Object.values(row.values).join(" ").toLowerCase(); }
  function filteredRows(element, sourceId) {
    const query = element.querySelector("[data-search]")?.value.trim().toLowerCase() || "";
    const rows = rowsBySource.get(sourceId) || [];
    if (!query) return rows;
    if (FuseClass) {
      const index = rows.map((row) => ({ row, text: searchable(row) }));
      return new FuseClass(index, { keys: ["text"], threshold: 0.36, ignoreLocation: true })
        .search(query)
        .map((result) => result.item.row);
    }
    return rows.filter((row) => searchable(row).includes(query));
  }

  function actionButtons(component, row) {
    const wrapper = document.createElement("div");
    wrapper.className = "rowActions";
    for (const actionId of component.actions || []) {
      const action = actionMap.get(actionId);
      if (!action) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset.action = action.id;
      button.dataset.rowId = String(row.id);
      button.className = action.tone === "danger" ? "danger" : action.tone === "success" ? "success" : "secondary";
      wrapper.appendChild(button);
    }
    return wrapper;
  }

  function renderTable(element, component) {
    const source = sourceMap.get(component.source);
    const rows = filteredRows(element, component.source);
    element.querySelector("[data-count]").textContent = `${rows.length} 条`;
    const root = element.querySelector("[data-rows]");
    root.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const key of component.fields) {
        const field = source.fields.find((candidate) => candidate.key === key);
        const td = document.createElement("td"); td.textContent = display(field, row.values[key]); tr.appendChild(td);
      }
      if (component.actions.length) { const td = document.createElement("td"); td.appendChild(actionButtons(component, row)); tr.appendChild(td); }
      root.appendChild(tr);
    }
  }

  function renderCards(element, component) {
    const source = sourceMap.get(component.source);
    const rows = filteredRows(element, component.source);
    element.querySelector("[data-count]").textContent = `${rows.length} 条`;
    const root = element.querySelector("[data-rows]"); root.replaceChildren();
    for (const row of rows) {
      const article = document.createElement("article"); article.className = "dataCard";
      const list = document.createElement("dl");
      for (const key of component.fields) {
        const field = source.fields.find((candidate) => candidate.key === key);
        const group = document.createElement("div"); const dt = document.createElement("dt"); const dd = document.createElement("dd");
        dt.textContent = field.label; dd.textContent = display(field, row.values[key]); group.append(dt, dd); list.appendChild(group);
      }
      article.append(list, actionButtons(component, row)); root.appendChild(article);
    }
  }

  function renderBoard(element, component) {
    const source = sourceMap.get(component.source);
    const groupField = source.fields.find((field) => field.key === component.groupBy);
    const rows = filteredRows(element, component.source);
    element.querySelector("[data-count]").textContent = `${rows.length} 条`;
    const root = element.querySelector("[data-rows]"); root.replaceChildren();
    for (const option of groupField.options) {
      const column = document.createElement("section"); column.className = "boardColumn";
      const heading = document.createElement("h3"); heading.textContent = `${option} · ${rows.filter((row) => row.values[component.groupBy] === option).length}`; column.appendChild(heading);
      for (const row of rows.filter((candidate) => candidate.values[component.groupBy] === option)) {
        const item = document.createElement("article"); item.className = "boardItem";
        const title = document.createElement("strong"); title.textContent = display(source.fields.find((field) => field.key === component.titleField), row.values[component.titleField]); item.appendChild(title);
        const select = document.createElement("select"); select.dataset.boardStatus = component.groupBy; select.dataset.source = component.source; select.dataset.rowId = String(row.id);
        for (const value of groupField.options) { const optionElement = document.createElement("option"); optionElement.value = value; optionElement.textContent = value; optionElement.selected = value === row.values[component.groupBy]; select.appendChild(optionElement); }
        item.append(select, actionButtons(component, row)); column.appendChild(item);
      }
      root.appendChild(column);
    }
  }

  function metricValue(metric, rows) {
    if (metric.aggregate === "count") return rows.length;
    const values = rows.map((row) => Number(row.values[metric.field])).filter(Number.isFinite);
    if (!values.length) return 0;
    if (metric.aggregate === "sum") return values.reduce((sum, value) => sum + value, 0);
    if (metric.aggregate === "average") return values.reduce((sum, value) => sum + value, 0) / values.length;
    if (metric.aggregate === "min") return Math.min(...values);
    return Math.max(...values);
  }

  function renderStats(element, component) {
    const rows = rowsBySource.get(component.source) || [];
    const root = element.querySelector("[data-metrics]"); root.replaceChildren();
    for (const metric of component.metrics) {
      const item = document.createElement("article"); item.className = "metric";
      const label = document.createElement("span"); label.textContent = metric.label;
      const value = document.createElement("strong"); const calculated = metricValue(metric, rows); value.textContent = `${metric.prefix || ""}${Number.isInteger(calculated) ? calculated : calculated.toFixed(2)}${metric.suffix || ""}`;
      item.append(label, value); root.appendChild(item);
    }
  }

  function renderChart(element, component) {
    if (!window.Chart) return;
    const rows = rowsBySource.get(component.source) || [];
    const groups = new Map();
    for (const row of rows) {
      const key = String(row.values[component.groupBy] ?? "未填写");
      const entry = groups.get(key) || { count: 0, sum: 0 };
      entry.count += 1; entry.sum += Number(row.values[component.valueField]) || 0; groups.set(key, entry);
    }
    const labels = [...groups.keys()].slice(0, 30);
    const values = labels.map((label) => { const entry = groups.get(label); return component.aggregate === "count" ? entry.count : component.aggregate === "average" ? entry.sum / entry.count : entry.sum; });
    charts.get(component.id)?.destroy();
    element.querySelector("[data-empty]").hidden = labels.length > 0;
    charts.set(component.id, new window.Chart(element.querySelector("canvas"), { type: component.chart, data: { labels, datasets: [{ label: component.title || "数据", data: values, backgroundColor: ["#147b5b", "#3a82d4", "#8a63d2", "#d2822f", "#c34d70", "#4f6878"] }] }, options: { responsive: true, maintainAspectRatio: false } }));
  }

  function evaluateExpression(node, values) {
    if (typeof node === "number") return node;
    if (node.input) return Number(values[node.input]) || 0;
    const args = node.args.map((argument) => evaluateExpression(argument, values));
    if (node.op === "add") return args.reduce((sum, value) => sum + value, 0);
    if (node.op === "subtract") return args[0] - args[1];
    if (node.op === "multiply") return args.reduce((result, value) => result * value, 1);
    if (node.op === "divide") return args[1] === 0 ? 0 : args[0] / args[1];
    if (node.op === "percent") return args[0] * args[1] / 100;
    if (node.op === "min") return Math.min(...args);
    return Math.max(...args);
  }

  function renderCalculator(element, component) {
    const values = Object.fromEntries(component.inputs.map((input) => [input.key, element.querySelector(`[data-calc-input="${input.key}"]`).value]));
    component.outputs.forEach((output, index) => {
      const result = evaluateExpression(output.expression, values);
      element.querySelector(`[data-calc-output="${index}"]`).textContent = `${output.prefix || ""}${Number.isFinite(result) ? result.toFixed(output.precision) : "—"}${output.suffix || ""}`;
    });
  }

  function renderText(element, component) {
    const root = element.querySelector("[data-text-content]");
    if (component.format === "markdown" && window.marked && window.DOMPurify) root.innerHTML = window.DOMPurify.sanitize(window.marked.parse(component.content));
    else root.textContent = component.content;
  }

  function renderAll() {
    for (const element of document.querySelectorAll("[data-component]")) {
      const component = componentMap.get(element.id);
      if (!component) continue;
      if (component.type === "table") renderTable(element, component);
      else if (component.type === "cards") renderCards(element, component);
      else if (component.type === "board") renderBoard(element, component);
      else if (component.type === "stats") renderStats(element, component);
      else if (component.type === "chart") renderChart(element, component);
      else if (component.type === "calculator") renderCalculator(element, component);
      else if (component.type === "text") renderText(element, component);
    }
  }

  async function loadSource(sourceId) {
    const rows = await window.room.db.query("SELECT id, payload, created_at, updated_at FROM __zhibian_records WHERE source = ? ORDER BY id DESC", [sourceId]);
    rowsBySource.set(sourceId, rows.map(parsedRow));
  }

  async function refresh(sourceId) {
    if (sourceId) await loadSource(sourceId); else await Promise.all(spec.data.map((source) => loadSource(source.id)));
    renderAll();
  }

  async function updateRow(sourceId, rowId, transform) {
    const row = (rowsBySource.get(sourceId) || []).find((candidate) => candidate.id === Number(rowId));
    if (!row) return;
    const values = transform({ ...row.values });
    await window.room.db.run("UPDATE __zhibian_records SET payload = ?, updated_at = ? WHERE id = ? AND source = ?", [JSON.stringify(values), new Date().toISOString(), Number(rowId), sourceId]);
    await refresh(sourceId);
  }

  async function runAction(actionId, rowId) {
    const action = actionMap.get(actionId);
    if (!action) return;
    if (action.type === "delete") await window.room.db.run("DELETE FROM __zhibian_records WHERE id = ? AND source = ?", [Number(rowId), action.source]);
    else if (action.type === "set-field") await updateRow(action.source, rowId, (values) => ({ ...values, [action.field]: action.value }));
    else if (action.type === "toggle") await updateRow(action.source, rowId, (values) => ({ ...values, [action.field]: !values[action.field] }));
    if (action.type === "delete") await refresh(action.source);
    notify(`${action.label}已完成`);
  }

  async function exportData(component, format) {
    const source = sourceMap.get(component.source);
    const output = (rowsBySource.get(component.source) || []).slice().reverse().map((row) => ({ id: row.id, ...row.values, createdAt: row.createdAt }));
    const baseName = `${spec.name}-${source.label}`;
    if (format === "xlsx" && window.XLSX) {
      const workbook = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(output), source.label.slice(0, 31));
      const content = window.XLSX.write(workbook, { bookType: "xlsx", type: "array" }); const target = await window.room.files.exportBinary(`${baseName}.xlsx`, content); if (target) notify(`已导出到 ${target}`); return;
    }
    const content = format === "csv" && window.Papa ? window.Papa.unparse(output, { escapeFormulae: true }) : JSON.stringify(output, null, 2);
    const target = await window.room.files.exportText(`${baseName}.${format === "csv" ? "csv" : "json"}`, content); if (target) notify(`已导出到 ${target}`);
  }

  function bindEvents() {
    for (const form of document.querySelectorAll("[data-room-form]")) form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const component = componentMap.get(form.closest("[data-component]").id); const values = {};
      for (const field of sourceMap.get(component.source).fields) { const input = form.elements[field.key]; if (input) values[field.key] = field.type === "boolean" ? input.checked : field.type === "number" && input.value !== "" ? Number(input.value) : input.value; }
      const now = new Date().toISOString(); await window.room.db.run("INSERT INTO __zhibian_records(source, payload, created_at, updated_at) VALUES(?, ?, ?, ?)", [component.source, JSON.stringify(values), now, now]); form.reset(); await refresh(component.source); notify("记录已保存");
    });
    document.addEventListener("input", (event) => {
      const componentElement = event.target.closest("[data-component]"); if (!componentElement) return; const component = componentMap.get(componentElement.id);
      if (event.target.matches("[data-search]") && component) { if (component.type === "table") renderTable(componentElement, component); else if (component.type === "cards") renderCards(componentElement, component); else if (component.type === "board") renderBoard(componentElement, component); }
      if (event.target.matches("[data-calc-input]") && component?.type === "calculator") renderCalculator(componentElement, component);
    });
    document.addEventListener("click", (event) => {
      const pageButton = event.target.closest("[data-page-target]");
      if (pageButton) { document.querySelectorAll("[data-page]").forEach((page) => { page.hidden = page.dataset.page !== pageButton.dataset.pageTarget; }); document.querySelectorAll("[data-page-target]").forEach((button) => button.classList.toggle("active", button === pageButton)); return; }
      const actionButton = event.target.closest("[data-action]"); if (actionButton) runAction(actionButton.dataset.action, actionButton.dataset.rowId).catch((error) => notify(error.message, true));
      const exportButton = event.target.closest("[data-export]"); if (exportButton) { const component = componentMap.get(exportButton.closest("[data-component]").id); exportData(component, exportButton.dataset.export).catch((error) => notify(error.message, true)); }
    });
    document.addEventListener("change", (event) => { if (event.target.matches("[data-board-status]")) updateRow(event.target.dataset.source, event.target.dataset.rowId, (values) => ({ ...values, [event.target.dataset.boardStatus]: event.target.value })).catch((error) => notify(error.message, true)); });
  }

  async function initialize() {
    if (spec.hostModules.includes("data.search@1")) {
      const imported = await import("/_modules/data.search@1/fuse.min.mjs");
      FuseClass = imported.default;
    }
    await window.room.db.run("CREATE TABLE IF NOT EXISTS __zhibian_records (source TEXT NOT NULL, id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    await window.room.db.run("CREATE INDEX IF NOT EXISTS __zhibian_records_source ON __zhibian_records(source, id)");
    for (const source of spec.data) {
      const rows = await window.room.db.query("SELECT COUNT(*) AS count FROM __zhibian_records WHERE source = ?", [source.id]);
      if (Number(rows[0]?.count || 0) === 0) for (const values of source.seed) { const now = new Date().toISOString(); await window.room.db.run("INSERT INTO __zhibian_records(source, payload, created_at, updated_at) VALUES(?, ?, ?, ?)", [source.id, JSON.stringify(values), now, now]); }
    }
    bindEvents(); await refresh(); document.documentElement.dataset.roomReady = "true";
  }
  initialize().catch((error) => { notify(error.message, true); document.documentElement.dataset.roomError = error.message; });
}

function generatedComposedAppJs() {
  return `(${composedBrowserRuntime.toString()})();\n`;
}

function parseComposedRoomSpec(text) {
  if (typeof text !== "string" || text.length > 500_000) throw new Error("组合房间规格文件无效");
  const match = text.trim().match(/^window\.ROOM_SPEC\s*=\s*(\{[\s\S]*\})\s*;?$/);
  if (!match) throw new Error("当前房间不是 room-spec@1 组合房间");
  return validateComposedRoomSpec(JSON.parse(match[1]));
}

module.exports = {
  COMPONENT_TYPES,
  deriveComposedHostModules,
  enrichComposedSpecForPrompt,
  evaluateComposedQuality,
  generatedComposedAppJs,
  generatedComposedIndexHtml,
  generatedComposedStyles,
  legacyDefinitionToComposedSpec,
  parseComposedRoomSpec,
  validateComposedRoomSpec
};
