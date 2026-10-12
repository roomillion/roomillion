"use strict";

const ACTION_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const EFFECTS = ["read", "write", "destructive", "external"];
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const KEYS = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function json(value) {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > 8 * 1024 ** 2) throw new Error("房间操作数据必须是最多 8 MiB 的 JSON；大文件请使用制品引用");
  return JSON.parse(text);
}
function validateSchema(schema, depth = 0) {
  if (!plain(schema) || depth > 12 || !TYPES.includes(schema.type)) throw new Error("房间操作参数定义需要有效的 type，嵌套最多 12 层");
  for (const key of Object.keys(schema)) if (!KEYS.has(key)) throw new Error(`不支持的房间操作参数定义字段：${key}`);
  if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 2000)) throw new Error("参数说明无效");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error("enum 必须是非空数组");
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || (!/^(minimum|maximum)$/.test(key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)))) throw new Error(`参数约束 ${key} 无效`);
  }
  if (schema.type === "object") {
    if (schema.properties !== undefined && !plain(schema.properties)) throw new Error("properties 必须是对象");
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || ["constructor", "prototype"].includes(key)) throw new Error("参数属性名无效");
      validateSchema(child, depth + 1);
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !Object.hasOwn(schema.properties || {}, key)))) throw new Error("required 需要引用已定义属性");
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error("additionalProperties 必须是布尔值");
  }
  if (schema.type === "array") validateSchema(schema.items, depth + 1);
  return json(schema);
}
function validateValue(schema, value, label = "input", depth = 0) {
  if (depth > 24) throw new Error(`${label} 嵌套过深`);
  const valid = schema.type === "object" ? plain(value) : schema.type === "array" ? Array.isArray(value) : schema.type === "null" ? value === null : schema.type === "integer" ? Number.isSafeInteger(value) : schema.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === schema.type;
  if (!valid) throw new Error(`${label} 应为 ${schema.type}`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${label} 不在允许的选项中`);
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`${label} 超出范围`);
  const length = typeof value === "string" || Array.isArray(value) ? value.length : null;
  const min = typeof value === "string" ? schema.minLength : schema.minItems;
  const max = typeof value === "string" ? schema.maxLength : schema.maxItems;
  if (length !== null && ((min !== undefined && length < min) || (max !== undefined && length > max))) throw new Error(`${label} 长度超出范围`);
  if (schema.type === "array") value.forEach((item, index) => validateValue(schema.items, item, `${label}[${index}]`, depth + 1));
  if (schema.type === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${label} 缺少 ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateValue(schema.properties[key], item, `${label}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`${label} 不支持 ${key}`);
    }
  }
  return value;
}
function validateActions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw new Error("actions 必须是最多 128 项的数组");
  const seen = new Set();
  return value.map(action => {
    if (!plain(action) || !ACTION_ID.test(action.id) || seen.has(action.id)) throw new Error("房间操作 ID 无效或重复");
    seen.add(action.id);
    for (const key of Object.keys(action)) if (!["id", "name", "description", "effect", "inputSchema", "outputSchema"].includes(key)) throw new Error(`不支持的房间操作字段：${key}`);
    if (typeof action.name !== "string" || !action.name.trim() || action.name.length > 100 || typeof action.description !== "string" || !action.description.trim() || action.description.length > 2000 || !EFFECTS.includes(action.effect)) throw new Error("房间操作需要名称、说明和有效的 effect");
    if (action.inputSchema?.type !== "object") throw new Error("房间操作 inputSchema 顶层必须是 object");
    return { ...action, inputSchema: validateSchema(action.inputSchema), ...(action.outputSchema ? { outputSchema: validateSchema(action.outputSchema) } : {}) };
  });
}
module.exports = { ACTION_ID, EFFECTS, json, validateActions, validateSchema, validateValue };
