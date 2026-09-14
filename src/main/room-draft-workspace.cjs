"use strict";
const { normalizeCustomRoomSpec } = require("./custom-room.cjs");

const CORE_FILES = new Set(["html", "css", "javascript"]);
function normalizedFile(value) {
  const file = String(value || "").replace(/\\/g, "/");
  if (CORE_FILES.has(file)) return file;
  if (!file || file.startsWith("/") || file.includes("\0") || file.split("/").some((part) => !part || part === "." || part === "..") || !/^[A-Za-z0-9_./@+-]+$/.test(file)) throw new Error("只能写入房间内安全的相对路径");
  if (["index.html", "styles.css", "app.js", "bootstrap.mjs", "room-app.json"].includes(file.toLowerCase())) throw new Error("扩展文件不能覆盖房间运行时文件");
  return file;
}

function createWorkspace(metadata, previous = null) {
  const normalized = normalizeCustomRoomSpec({ ...metadata, formatVersion: "room-app@1", kind: "custom", files: { html: "<main></main>", css: "main{}", javascript: "void 0;" } });
  const { files: _files, ...cleanMetadata } = normalized;
  return { metadata: cleanMetadata, files: { ...(previous?.files || {}) }, revision: (previous?.revision || 0) + 1, updatedAt: new Date().toISOString() };
}

function writeFile(workspace, { file, content, expectedRevision, find }) {
  if (!workspace) throw new Error("先调用 begin_custom_room 设置房间名称、模块和权限");
  file = normalizedFile(file);
  if (expectedRevision !== workspace.revision) throw new Error(`草稿已更新，当前 revision=${workspace.revision}；请先读取草稿再修改`);
  if (typeof content !== "string") throw new Error("content 必须是原始文件文本，不要再次 JSON.stringify");
  let next = content;
  if (find !== undefined) {
    const current = workspace.files[file] || "";
    if (typeof find !== "string" || !find || !current.includes(find) || current.indexOf(find) !== current.lastIndexOf(find)) throw new Error("find 必须准确匹配文件中唯一的一段原文；未修改草稿");
    next = current.replace(find, () => content);
  }
  if (CORE_FILES.has(file) && !next.trim()) throw new Error(`${file} 不能为空`);
  const files = { ...workspace.files, [file]: next };
  return { ...workspace, files, revision: workspace.revision + 1, updatedAt: new Date().toISOString() };
}

function describeWorkspace(workspace, file) {
  if (!workspace) return { exists: false, instruction: "调用 begin_custom_room 开始" };
  if (file !== undefined) file = normalizedFile(file);
  return { exists: true, revision: workspace.revision, metadata: workspace.metadata,
    files: Object.fromEntries(Object.keys(workspace.files).sort().map(key => [key, { characters: workspace.files[key]?.length || 0, saved: Object.hasOwn(workspace.files, key) }])),
    ...(file ? { file, content: workspace.files[file] || "" } : {}) };
}

module.exports = { createWorkspace, writeFile, describeWorkspace };
