"use strict";

// Complete, disk-backed, read-only project index. Project code is never executed and
// the original OS path is never exposed. Dependency/build/data folders and likely
// secrets remain deliberately excluded; ordinary project size is not capped.
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { getSelectableRoomModuleCatalog } = require("./room-module-catalog.cjs");

const LIMITS = Object.freeze({ readChars: 64 * 1024, indexPageSize: 250 });
const OMIT = /^(?:\.git|\.svn|\.hg|node_modules|vendor|dist|build|coverage|target|venv|\.venv|__pycache__|data|logs|backups?|secrets?|credentials?)$/i;
const TEXT = /\.(?:html?|css|scss|less|[cm]?js|jsx|tsx?|vue|svelte|json|md|txt|py|toml|ya?ml|java|cs|go|rs|php|xml|sql|graphql|gql|sh|ps1|bat|cmd|ini|conf|properties)$/i;
const NOTICE = /^(?:licen[cs]e|notice|copying|third[-_ ]party[-_ ]notices?)(?:[.-].*)?$/i;
const PRIVATE_NAME = /^\.env(?:\.|$)|(?:^|[._-])(?:secret|credentials?|tokens?|passwords?|private|id_rsa|id_ed25519)(?:[._-]|$)|\.(?:pem|key|p12|pfx|sqlite|db)$/i;
const SENSITIVE = /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:sk-|sk_|tp-)[A-Za-z0-9_-]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|(?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*["']?\s*[:=]\s*["'][^"'\r\n]{6,}["']|https?:\/\/[^\s/@]+:[^\s/@]+@/i;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function relativeName(root, filename) { return path.relative(root, filename).split(path.sep).join("/"); }
function snapshotFilePath(source, relativePath) {
  if (!source?.storageRoot || !path.isAbsolute(source.storageRoot)) throw new Error("项目快照正文不可用，请重新导入项目");
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  const target = path.resolve(source.storageRoot, ...normalized.split("/"));
  if (!inside(path.resolve(source.storageRoot), target)) throw new Error("项目快照文件路径无效");
  return target;
}

async function readStableFile(filename, before) {
  const handle = await fsp.open(filename, "r");
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.nlink > 1) throw new Error("项目文件在扫描时发生变化");
    const chunks = [];
    let position = 0;
    while (position < current.size) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, current.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (position !== current.size) throw new Error("项目文件在扫描时发生变化");
    return Buffer.concat(chunks, position);
  } finally { await handle.close(); }
}

async function snapshotProject(directory, options = {}) {
  const requested = path.resolve(directory);
  const root = await fsp.realpath(requested);
  if ((process.platform === "win32" ? root.toLowerCase() !== requested.toLowerCase() : root !== requested) || !(await fsp.lstat(requested)).isDirectory()) throw new Error("请选择真实项目文件夹，不支持符号链接或目录联接");
  const id = `project_${crypto.randomBytes(16).toString("hex")}`;
  const snapshotsRoot = path.resolve(options.snapshotsRoot || path.join(path.dirname(root), ".zhibian-project-snapshots"));
  const storageRoot = path.join(snapshotsRoot, id);
  await fsp.mkdir(storageRoot, { recursive: true });
  const files = [], skipped = {}, analysisParts = [];
  let totalBytes = 0;
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  async function walk(folder) {
    if (!inside(root, await fsp.realpath(folder))) throw new Error("项目目录发生变化，请重新选择");
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (OMIT.test(entry.name) || PRIVATE_NAME.test(entry.name)) { skip("excluded"); continue; }
      const filename = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) { skip("link"); continue; }
      if (entry.isDirectory()) { await walk(filename); continue; }
      if (!entry.isFile()) { skip("nonFile"); continue; }
      if (!inside(root, await fsp.realpath(filename))) throw new Error("项目文件越界，请重新选择");
      const before = await fsp.lstat(filename);
      if (!before.isFile() || before.nlink > 1) { skip("link"); continue; }
      const filePath = relativeName(root, filename);
      if (!TEXT.test(entry.name) && !NOTICE.test(entry.name) && entry.name !== "Dockerfile") {
        files.push({ path: filePath, bytes: before.size, readable: false, reason: "binary-or-unsupported-text" }); totalBytes += before.size; continue;
      }
      const buffer = await readStableFile(filename, before);
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      if (buffer.includes(0)) { files.push({ path: filePath, bytes: buffer.length, sha256, readable: false, reason: "binary" }); totalBytes += buffer.length; continue; }
      let content;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
      catch { files.push({ path: filePath, bytes: buffer.length, sha256, readable: false, reason: "encoding" }); totalBytes += buffer.length; continue; }
      if (SENSITIVE.test(content)) { skip("sensitive"); continue; }
      const target = path.join(storageRoot, ...filePath.split("/"));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, buffer, { flag: "wx" });
      files.push({ path: filePath, bytes: buffer.length, characters: content.length, sha256, readable: true,
        ...(path.posix.basename(filePath) === "package.json" ? { content } : {}) });
      totalBytes += buffer.length;
      if (analysisParts.length < 1000) analysisParts.push(content.slice(0, 64 * 1024));
    }
  }
  try {
    await walk(root);
    if (!files.length) throw new Error("项目中没有可建立索引的文件");
    files.sort((a, b) => a.path.localeCompare(b.path));
    const source = { id, name: path.basename(root), createdAt: new Date().toISOString(), storageRoot, files, totalBytes, skipped, complete: true };
    source.analysis = analyzeProject(source, analysisParts.join("\n"));
    return source;
  } catch (error) { await fsp.rm(storageRoot, { recursive: true, force: true }); throw error; }
}

function analyzeProject(source, joined = "") {
  const dependencies = new Map();
  const warnings = ["静态分析仅供迁移判断，不代表原项目或迁移房间已经运行通过。", "依赖目录、版本库、数据库及疑似秘密文件不进入快照；二进制文件会进入完整索引但不能作为文本读取。"];
  for (const file of source.files) {
    if (path.posix.basename(file.path) !== "package.json" || typeof file.content !== "string") continue;
    try { const pkg = JSON.parse(file.content); for (const [name, version] of Object.entries({ ...pkg.devDependencies, ...pkg.dependencies })) dependencies.set(name, String(version)); }
    catch { warnings.push(`${file.path} 无法解析，需要进一步核对。`); }
  }
  const modules = getSelectableRoomModuleCatalog();
  const dependencyMap = [...dependencies].map(([name, version]) => ({ name, requestedVersion: version, hostModules: modules.filter(item => item.packageName === name).map(item => ({ id: item.id, version: item.packageVersion })) }));
  if (source.files.some(file => /\.(py|java|cs|go|rs|php)$/i.test(file.path))) warnings.push("存在非浏览器语言；需要重构业务逻辑或经授权连接外部服务。");
  if (/\b(?:require\s*\(|process\.|child_process|express|electron|fastapi|flask|django)\b|node:|\.listen\s*\(/i.test(joined)) warnings.push("存在后端或系统运行时迹象，需要适配房间运行时。");
  if (/\b(?:fetch|WebSocket|XMLHttpRequest|localStorage|sessionStorage)\b|https?:\/\//.test(joined)) warnings.push("需检查网络、远程资源和存储调用，替换为房间 SDK 与离线资源。");
  if (dependencyMap.some(item => !item.hostModules.length)) warnings.push("存在非内置依赖；需要替换、重构或随房间合规打包。");
  const notices = source.files.filter(file => NOTICE.test(path.posix.basename(file.path))).map(file => file.path);
  if (!notices.length) warnings.push("未收集到许可声明；迁移前请确认有权使用并提供需要保留的声明。");
  return { dependencies: dependencyMap, notices, warnings };
}

function projectSummary(source, options = {}) {
  if (!source) return null;
  const cursor = Number.isSafeInteger(options.cursor) && options.cursor >= 0 ? options.cursor : 0;
  const pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize > 0 ? options.pageSize : LIMITS.indexPageSize;
  const end = Math.min(source.files.length, cursor + pageSize);
  const analysis = source.analysis || analyzeProject(source, source.files.map(file => file.content || "").join("\n"));
  const warnings = [...analysis.warnings];
  if (source.limited) warnings.push("这是旧版受限快照；请重新导入以建立完整分页索引。");
  return { id: source.id, name: source.name, createdAt: source.createdAt, totalBytes: source.totalBytes, complete: source.complete === true, limited: source.limited === true, skipped: source.skipped,
    fileCount: source.files.length, cursor, nextCursor: end < source.files.length ? end : null, files: source.files.slice(cursor, end).map(({ content, ...item }) => item),
    dependencies: analysis.dependencies, notices: analysis.notices, warnings };
}

async function readProjectFile(source, filename, offset = 0, options = {}) {
  if (!source) throw new Error("请先由用户选择本地项目");
  const file = source.files.find(item => item.path === filename);
  if (!file) throw new Error("只能读取当前项目快照清单内的文件");
  if (file.readable === false) throw new Error(`该文件不能作为 UTF-8 文本读取：${file.reason || "binary"}`);
  const pageChars = Number.isSafeInteger(options.pageChars) && options.pageChars > 0 ? options.pageChars : LIMITS.readChars;
  const content = typeof file.content === "string" ? file.content : await fsp.readFile(snapshotFilePath(source, file.path), "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) throw new Error("读取偏移无效");
  const page = content.slice(offset, offset + pageChars);
  return { path: file.path, sha256: file.sha256, offset, nextOffset: offset + page.length, eof: offset + page.length === content.length, totalCharacters: content.length, content: page, untrusted: true };
}

async function migrationNotices(source, assessment, mode) {
  if (!source) return null;
  const notices = [];
  for (const file of source.files.filter(file => NOTICE.test(path.posix.basename(file.path)) && file.readable !== false)) {
    notices.push({ path: file.path, content: typeof file.content === "string" ? file.content : await fsp.readFile(snapshotFilePath(source, file.path), "utf8") });
  }
  return { formatVersion: "project-migration@1", source: { id: source.id, name: source.name, createdAt: source.createdAt }, mode, assessment,
    files: source.files.map(({ content, ...file }) => file), notices };
}

module.exports = { snapshotProject, projectSummary, readProjectFile, migrationNotices, LIMITS };
