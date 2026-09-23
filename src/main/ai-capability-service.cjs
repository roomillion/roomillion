"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { requestEmbeddings } = require("./embedding-client.cjs");
const { requestRerank } = require("./rerank-client.cjs");
const { requestIntuition } = require("./intuition-client.cjs");

const FORMAT_VERSION = "0.1";
const KINDS = Object.freeze(["embedding", "rerank", "intuition"]);
const DEFAULTS = Object.freeze({
  embedding: Object.freeze({ label: "Embedding 模型", baseUrl: "", model: "" }),
  rerank: Object.freeze({ label: "Rerank 模型", baseUrl: "", model: "" }),
  intuition: Object.freeze({ label: "TypeSafe AI · Jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest" })
});

function validateKind(kind) {
  const value = String(kind || "");
  if (!KINDS.includes(value)) throw new Error("AI 专用能力类型无效");
  return value;
}

function validateBaseUrl(value) {
  const input = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(input); } catch { throw new Error("API 地址格式无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("API 地址必须是无凭据、查询和片段的 HTTP(S) 地址");
  if (url.href.length > 2048) throw new Error("API 地址过长");
  return input;
}

function validateProfile(kind, input) {
  const validKind = validateKind(kind);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("AI 专用能力配置无效");
  const baseUrl = validateBaseUrl(input.baseUrl || DEFAULTS[validKind].baseUrl);
  const model = String(input.model || DEFAULTS[validKind].model).trim();
  const label = String(input.label || DEFAULTS[validKind].label).trim();
  if (!model || model.length > 200) throw new Error("模型名称不能为空或过长");
  if (!label || label.length > 100) throw new Error("配置名称不能为空或过长");
  const dimensions = input.dimensions === undefined || input.dimensions === "" ? null : Number(input.dimensions);
  if (validKind !== "embedding" && dimensions !== null) throw new Error("只有 Embedding 配置可以指定向量维度");
  if (dimensions !== null && (!Number.isSafeInteger(dimensions) || dimensions < 1)) throw new Error("Embedding 维度必须为正整数");
  return { id: `capability-${validKind}`, kind: validKind, label, baseUrl, model, ...(validKind === "embedding" ? { protocol: "openai-completions" } : {}), ...(dimensions ? { dimensions } : {}) };
}

class AiCapabilityService {
  constructor(dataRoot, { secureStorage = null } = {}) {
    this.configPath = path.join(dataRoot, "ai-capabilities.json");
    this.secretRoot = path.join(dataRoot, "ai-capability-secrets");
    this.secureStorage = secureStorage;
    this.profiles = new Map();
    this.sessionApiKeys = new Map();
    this.storedKeyKinds = new Set();
    this.keyStorageErrors = new Map();
    this.connectionTests = new Map();
  }

  isSecureStorageAvailable() {
    try { return Boolean(this.secureStorage?.isEncryptionAvailable?.()); }
    catch { return false; }
  }

  secretPath(kind) { return path.join(this.secretRoot, `${validateKind(kind)}.bin`); }

  async init() {
    try {
      const stored = JSON.parse(await fsp.readFile(this.configPath, "utf8"));
      if (stored?.formatVersion === FORMAT_VERSION && stored.profiles && typeof stored.profiles === "object") {
        for (const kind of KINDS) {
          if (!stored.profiles[kind]) continue;
          try { this.profiles.set(kind, validateProfile(kind, stored.profiles[kind])); } catch {}
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.profiles.clear();
    }
    for (const kind of KINDS) await this.loadStoredKey(kind);
    return this;
  }

  async loadStoredKey(kind) {
    try {
      const encrypted = await fsp.readFile(this.secretPath(kind));
      if (!this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用，已忽略已保存密钥");
      const apiKey = this.secureStorage.decryptString(encrypted);
      if (apiKey) {
        this.sessionApiKeys.set(kind, apiKey);
        this.storedKeyKinds.add(kind);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.keyStorageErrors.set(kind, error.message);
    }
  }

  async persist() {
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.tmp`;
    const profiles = Object.fromEntries(this.profiles);
    await fsp.writeFile(temporary, `${JSON.stringify({ formatVersion: FORMAT_VERSION, profiles }, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, this.configPath);
  }

  async persistKey(kind, apiKey) {
    if (!this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用");
    await fsp.mkdir(this.secretRoot, { recursive: true });
    await fsp.writeFile(this.secretPath(kind), this.secureStorage.encryptString(apiKey));
    this.storedKeyKinds.add(kind);
    this.keyStorageErrors.delete(kind);
  }

  getPublicProfile(kind) {
    const validKind = validateKind(kind);
    const profile = this.profiles.get(validKind);
    if (!profile) return null;
    const hasSessionKey = Boolean(this.sessionApiKeys.get(validKind));
    return {
      id: profile.id,
      kind: validKind,
      label: profile.label,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.dimensions ? { dimensions: profile.dimensions } : {}),
      hasSessionKey,
      hasStoredKey: this.storedKeyKinds.has(validKind),
      ready: hasSessionKey || /^http:\/\//.test(profile.baseUrl),
      secureStorageAvailable: this.isSecureStorageAvailable(),
      keyStorageError: this.keyStorageErrors.get(validKind) || null,
      connectionTest: this.connectionTests.get(validKind) || null
    };
  }

  getPublicState() {
    return Object.fromEntries(KINDS.map((kind) => [kind, this.getPublicProfile(kind)]));
  }

  getRoomCatalog() {
    return Object.fromEntries(KINDS.map((kind) => {
      const profile = this.getPublicProfile(kind);
      return [kind, profile ? { kind, label: profile.label, model: profile.model, ready: profile.ready, configured: true } : { kind, ready: false, configured: false }];
    }));
  }

  async saveProfile(kind, input) {
    const validKind = validateKind(kind);
    const profile = validateProfile(validKind, input);
    const apiKeyProvided = typeof input.apiKey === "string" && input.apiKey.length > 0;
    if (apiKeyProvided) {
      if (input.apiKey.length > 10_000) throw new Error("API Key 长度无效");
      this.sessionApiKeys.set(validKind, input.apiKey);
    }
    const rememberKey = input.rememberKey === true || input.rememberKey === "true" || input.rememberKey === "on";
    if (rememberKey && !this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用，API Key 只能保留在本次会话");
    const apiKey = this.sessionApiKeys.get(validKind);
    if (rememberKey && !apiKey) throw new Error("请先输入 API Key，再选择记住密钥");
    this.profiles.set(validKind, profile);
    this.connectionTests.delete(validKind);
    await this.persist();
    if (rememberKey) await this.persistKey(validKind, apiKey);
    else if (Object.hasOwn(input, "rememberKey")) {
      await fsp.rm(this.secretPath(validKind), { force: true });
      this.storedKeyKinds.delete(validKind);
    }
    return this.getPublicState();
  }

  async clearKey(kind) {
    const validKind = validateKind(kind);
    this.sessionApiKeys.delete(validKind);
    this.storedKeyKinds.delete(validKind);
    this.keyStorageErrors.delete(validKind);
    this.connectionTests.delete(validKind);
    await fsp.rm(this.secretPath(validKind), { force: true });
    return this.getPublicState();
  }

  async deleteProfile(kind) {
    const validKind = validateKind(kind);
    this.profiles.delete(validKind);
    await this.clearKey(validKind);
    await this.persist();
    return this.getPublicState();
  }

  ensureConfigured(kind) {
    const validKind = validateKind(kind);
    const profile = this.profiles.get(validKind);
    if (!profile) throw new Error(`${DEFAULTS[validKind].label}尚未配置，请先到工作台 AI 能力设置中完成配置`);
    if (!this.sessionApiKeys.get(validKind) && !/^http:\/\//.test(profile.baseUrl)) throw new Error(`${profile.label}缺少可用 API Key`);
    return profile;
  }

  async embed(texts, options = {}) {
    const profile = this.ensureConfigured("embedding");
    return requestEmbeddings(profile, this.sessionApiKeys.get("embedding"), texts, {
      ...options,
      model: options.model || profile.model,
      dimensions: options.dimensions || profile.dimensions
    });
  }

  async rerank(query, documents, options = {}) {
    const profile = this.ensureConfigured("rerank");
    return requestRerank(profile, this.sessionApiKeys.get("rerank"), query, documents, { ...options, model: options.model || profile.model });
  }

  async intuition(state, questions, options = {}) {
    const profile = this.ensureConfigured("intuition");
    return requestIntuition(profile, this.sessionApiKeys.get("intuition"), state, questions, { ...options, model: options.model || profile.model });
  }

  async testConnection(kind) {
    const validKind = validateKind(kind);
    const startedAt = Date.now();
    try {
      let value;
      if (validKind === "embedding") value = await this.embed(["连接测试"]);
      else if (validKind === "rerank") value = await this.rerank("连接", ["连接测试"], { topN: 1 });
      else value = await this.intuition("连接测试", { reachable: { type: "noul", instructions: "这是一条连接测试吗？" } });
      const status = { ok: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt, model: value.model };
      this.connectionTests.set(validKind, status);
      return { ...status, profiles: this.getPublicState() };
    } catch (error) {
      this.connectionTests.set(validKind, {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        error: String(error?.message || "连接测试失败").slice(0, 240)
      });
      throw error;
    }
  }
}

module.exports = { AiCapabilityService, AI_CAPABILITY_KINDS: KINDS };
