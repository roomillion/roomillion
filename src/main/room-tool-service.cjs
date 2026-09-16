"use strict";

const TOOL_ID_PATTERN = /^[a-z][a-z0-9.-]{1,79}@\d+$/;
const MAX_TOOL_INPUT_BYTES = 8 * 1024 * 1024;

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function validateToolId(value) {
  const id = String(value || "").trim();
  if (!TOOL_ID_PATTERN.test(id)) throw new Error(`房间工具 ID 无效：${id || "(空)"}`);
  return id;
}
function roomToolPermissions(room) {
  const requested = new Set(room?.requestedPermissions?.tools || room?.permissions?.tools || []);
  return new Set((room?.grantedPermissions?.tools || []).filter((id) => requested.has(id)));
}
function validateInput(input) {
  const serialized = JSON.stringify(input ?? null);
  if (Buffer.byteLength(serialized) > MAX_TOOL_INPUT_BYTES) throw new Error("房间工具输入超过 8 MiB，请改用 Blob 或制品 ID");
  return clone(input ?? null);
}

class RoomToolService {
  constructor({ documentService = null, blobService = null, tools = [] } = {}) {
    this.tools = new Map();
    if (documentService) this.register({
      id: "document.markdown-to-pdf@1",
      name: "Markdown 转 PDF",
      description: "把 Markdown 文本或 Markdown 制品转换成 PDF 制品。",
      requires: { database: "private" },
      execute: async ({ roomId }, input = {}) => {
        if (typeof input.source === "string") return documentService.renderMarkdown(roomId, input.source, input.options || {});
        if (input.artifactId) return documentService.renderMarkdownArtifact(roomId, String(input.artifactId), input.options || {});
        throw new Error("工具输入需要 source 或 artifactId");
      }
    });
    if (blobService) this.register({
      id: "artifact.list@1",
      name: "列出制品",
      description: "列出当前房间生成的 Markdown、PDF 和其他制品。",
      requires: { database: "private" },
      execute: ({ roomId }, input = {}) => blobService.list(roomId, { ...input, kind: "artifact" })
    });
    for (const tool of tools) this.register(tool);
  }
  register(definition) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("房间工具定义无效");
    const id = validateToolId(definition.id);
    if (this.tools.has(id)) throw new Error(`房间工具重复注册：${id}`);
    if (typeof definition.execute !== "function") throw new Error(`房间工具缺少处理器：${id}`);
    const item = Object.freeze({
      id,
      name: String(definition.name || id).slice(0, 100),
      description: String(definition.description || "").slice(0, 500),
      requires: clone(definition.requires || {}),
      execute: definition.execute
    });
    this.tools.set(id, item);
    return this.publicTool(item);
  }
  publicTool(tool) { return Object.freeze({ id: tool.id, name: tool.name, description: tool.description, requires: clone(tool.requires) }); }
  list(room) {
    const allowed = roomToolPermissions(room);
    return [...allowed].map((id) => this.tools.get(id)).filter(Boolean).map((tool) => this.publicTool(tool));
  }
  assertRequirements(room, tool) {
    if (tool.requires?.database === "private" && room?.grantedPermissions?.database !== "private") throw new Error(`工具 ${tool.id} 需要私有数据权限`);
  }
  async call(room, rawId, input) {
    const id = validateToolId(rawId);
    if (!roomToolPermissions(room).has(id)) throw new Error(`房间没有工具权限：${id}`);
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`当前工作台没有安装工具：${id}`);
    this.assertRequirements(room, tool);
    const result = await tool.execute({ roomId: room.id, room: clone(room) }, validateInput(input));
    return clone(result);
  }
}

module.exports = { MAX_TOOL_INPUT_BYTES, RoomToolService, TOOL_ID_PATTERN, roomToolPermissions, validateToolId };