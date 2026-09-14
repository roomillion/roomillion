"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9.-]{0,79}$/;
const SENSITIVE_KEY_PATTERN = /api.?key|authorization|password|secret|token|credential|cookie/i;
const CONTENT_KEY_PATTERN = /^(?:content|text|prompt|body|conversation|database|payload|fileContent)$/i;
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/(?:Users|home|var|etc|opt|tmp)\/)/;

function sanitizeString(value) {
  if (/^https?:\/\//i.test(value)) return "[URL 已脱敏]";
  if (ABSOLUTE_PATH_PATTERN.test(value)) return "[路径已脱敏]";
  return value.replace(/[\u0000-\u001f]/g, " ").slice(0, 300);
}

function sanitizeDiagnosticValue(value, key = "", depth = 0) {
  if (depth > 6) return "[层级过深]";
  if (SENSITIVE_KEY_PATTERN.test(key) || CONTENT_KEY_PATTERN.test(key)) return "[已脱敏]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDiagnosticValue(item, key, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      output[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 100);
}

class DiagnosticService {
  constructor(dataRoot) {
    this.root = path.join(path.resolve(dataRoot), "diagnostics");
    this.eventPath = path.join(this.root, "events.jsonl");
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    return this;
  }

  async record(type, data = {}) {
    if (typeof type !== "string" || !EVENT_TYPE_PATTERN.test(type)) throw new Error("诊断事件类型无效");
    const event = {
      id: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      data: sanitizeDiagnosticValue(data)
    };
    await fsp.appendFile(this.eventPath, `${JSON.stringify(event)}\n`, "utf8");
    return event.id;
  }

  async readRecentEvents(limit = 200) {
    try {
      const stats = await fsp.stat(this.eventPath);
      const start = Math.max(0, stats.size - 5 * 1024 * 1024);
      const handle = await fsp.open(this.eventPath, "r");
      try {
        const buffer = Buffer.alloc(stats.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
        if (start > 0) lines.shift();
        return lines.slice(-Math.max(1, Math.min(500, limit))).map((line) => JSON.parse(line));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async buildReport({ environment, rooms }) {
    return {
      formatVersion: "0.1",
      createdAt: new Date().toISOString(),
      privacyNotice: "此报告默认不包含 API Key、密码、业务数据库、文件内容、AI 对话正文、绝对路径或完整 URL。",
      environment: sanitizeDiagnosticValue(environment),
      rooms: rooms.map((room) => ({
        id: room.id,
        version: room.version,
        source: room.source,
        trust: room.trust,
        permissionKeys: [
          ...(room.grantedPermissions?.database ? ["database.private"] : []),
          ...(room.grantedPermissions?.files ?? []).map((value) => `files.${value}`),
          ...(room.grantedPermissions?.ai?.roles ?? []).map((value) => `ai.${value}`),
          ...(room.grantedPermissions?.network ?? []).map(() => "network.origin")
        ]
      })),
      events: await this.readRecentEvents(200)
    };
  }

  async previewReport({ environment, rooms }) {
    const report = await this.buildReport({ environment, rooms });
    return {
      formatVersion: report.formatVersion,
      roomCount: report.rooms.length,
      eventCount: report.events.length,
      includedFields: [
        "工作台、Electron、内置 Git、操作系统和 CPU 架构版本",
        "房间 ID、版本、来源、信任状态和权限键",
        "最近最多 200 条结构化脱敏事件"
      ],
      excludedFields: [
        "API Key、Authorization、密码、令牌和凭据",
        "房间名称、业务数据库、文件内容和 AI 对话正文",
        "用户名、绝对路径、内网主机名和完整 URL"
      ],
      privacyNotice: report.privacyNotice
    };
  }

  async createReport({ environment, rooms, destinationPath }) {
    const report = await this.buildReport({ environment, rooms });
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    const temporaryPath = `${destinationPath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    try {
      await fsp.writeFile(temporaryPath, encoded, { flag: "wx" });
      await fsp.rm(destinationPath, { force: true });
      await fsp.rename(temporaryPath, destinationPath);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true });
      throw error;
    }
    return { bytes: Buffer.byteLength(encoded), eventCount: report.events.length };
  }
}

module.exports = { DiagnosticService, sanitizeDiagnosticValue, sanitizeString };
