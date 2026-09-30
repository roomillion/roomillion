"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { requestEmbeddings } = require("./embedding-client.cjs");
const { requestRerank } = require("./rerank-client.cjs");
const { requestIntuition } = require("./intuition-client.cjs");

const FORMAT_VERSION = "0.3";
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

function validateProfile(kind, input, id) {
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
  return { id, kind: validKind, label, baseUrl, model, ...(validKind === "embedding" ? { protocol: "openai-completions" } : {}), ...(dimensions ? { dimensions } : {}) };
}

function validProfileId(kind, id) {
  return id === `capability-${kind}` || new RegExp(`^capability-${kind}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).test(id);
}

class AiCapabilityService {
  constructor(dataRoot, { secureStorage = null } = {}) {
    this.configPath = path.join(dataRoot, "ai-capabilities.json");
    this.secretRoot = path.join(dataRoot, "ai-capability-secrets");
    this.secureStorage = secureStorage;
    this.profiles = new Map();
    this.defaultProfileIds = new Map();
    this.sessionApiKeys = new Map();
    this.storedKeyIds = new Set();
    this.keyStorageErrors = new Map();
    this.connectionTests = new Map();
  }

  isSecureStorageAvailable() {
    try { return Boolean(this.secureStorage?.isEncryptionAvailable?.()); }
    catch { return false; }
  }

  secretPath(id) {
    const kind = KINDS.find((item) => validProfileId(item, id));
    if (!kind) throw new Error("AI 专用能力配置 ID 无效");
    // The first profile from format 0.1 keeps its original encrypted key file.
    return path.join(this.secretRoot, `${id === `capability-${kind}` ? kind : id}.bin`);
  }

  listProfiles(kind) {
    const validKind = validateKind(kind);
    return [...this.profiles.values()].filter((profile) => profile.kind === validKind);
  }

  resolveProfile(kind, id) {
    const validKind = validateKind(kind);
    if (id === undefined || id === null || id === "") {
      return this.profiles.get(this.defaultProfileIds.get(validKind)) || this.listProfiles(validKind)[0] || null;
    }
    if (typeof id !== "string" || !validProfileId(validKind, id)) throw new Error("AI 专用能力配置 ID 无效");
    const profile = this.profiles.get(id);
    if (!profile || profile.kind !== validKind) throw new Error("指定的 AI 专用能力配置不存在");
    return profile;
  }

  async init() {
    let storedDefaults = null;
    try {
      const stored = JSON.parse(await fsp.readFile(this.configPath, "utf8"));
      if ([FORMAT_VERSION, "0.2"].includes(stored?.formatVersion) && Array.isArray(stored.profiles)) {
        if (stored.formatVersion === FORMAT_VERSION && stored.defaults && typeof stored.defaults === "object" && !Array.isArray(stored.defaults)) {
          storedDefaults = stored.defaults;
        }
        for (const item of stored.profiles.slice(0, 300)) {
          try {
            const kind = validateKind(item.kind);
            if (typeof item.id !== "string" || !validProfileId(kind, item.id) || this.profiles.has(item.id)) continue;
            this.profiles.set(item.id, validateProfile(kind, item, item.id));
          } catch {}
        }
      } else if (stored?.formatVersion === "0.1" && stored.profiles && typeof stored.profiles === "object") {
        for (const kind of KINDS) {
          if (!stored.profiles[kind]) continue;
          const id = `capability-${kind}`;
          try { this.profiles.set(id, validateProfile(kind, stored.profiles[kind], id)); } catch {}
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.profiles.clear();
    }
    for (const kind of KINDS) {
      const id = storedDefaults?.[kind];
      const selected = typeof id === "string" && this.profiles.get(id)?.kind === kind ? id : this.listProfiles(kind)[0]?.id;
      if (selected) this.defaultProfileIds.set(kind, selected);
    }
    for (const profile of this.profiles.values()) await this.loadStoredKey(profile.id);
    return this;
  }

  async loadStoredKey(id) {
    try {
      const encrypted = await fsp.readFile(this.secretPath(id));
      if (!this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用，已忽略已保存密钥");
      const apiKey = this.secureStorage.decryptString(encrypted);
      if (apiKey) {
        this.sessionApiKeys.set(id, apiKey);
        this.storedKeyIds.add(id);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.keyStorageErrors.set(id, error.message);
    }
  }

  async persist() {
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.tmp`;
    const profiles = [...this.profiles.values()];
    const defaults = Object.fromEntries(this.defaultProfileIds);
    await fsp.writeFile(temporary, `${JSON.stringify({ formatVersion: FORMAT_VERSION, profiles, defaults }, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, this.configPath);
  }

  async persistKey(id, apiKey) {
    if (!this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用");
    await fsp.mkdir(this.secretRoot, { recursive: true });
    await fsp.writeFile(this.secretPath(id), this.secureStorage.encryptString(apiKey));
    this.storedKeyIds.add(id);
    this.keyStorageErrors.delete(id);
  }

  getPublicProfile(kind, id) {
    const profile = this.resolveProfile(kind, id);
    if (!profile) return null;
    const hasSessionKey = Boolean(this.sessionApiKeys.get(profile.id));
    return {
      id: profile.id,
      kind: profile.kind,
      label: profile.label,
      baseUrl: profile.baseUrl,
      model: profile.model,
      isDefault: this.defaultProfileIds.get(profile.kind) === profile.id,
      ...(profile.dimensions ? { dimensions: profile.dimensions } : {}),
      hasSessionKey,
      hasStoredKey: this.storedKeyIds.has(profile.id),
      ready: hasSessionKey || /^http:\/\//.test(profile.baseUrl),
      secureStorageAvailable: this.isSecureStorageAvailable(),
      keyStorageError: this.keyStorageErrors.get(profile.id) || null,
      connectionTest: this.connectionTests.get(profile.id) || null
    };
  }

  getPublicState() {
    return Object.fromEntries(KINDS.map((kind) => {
      const profiles = this.listProfiles(kind).map((profile) => this.getPublicProfile(kind, profile.id));
      const selected = profiles.find((profile) => profile.isDefault) || profiles[0];
      return [kind, selected ? { ...selected, profiles } : null];
    }));
  }

  getRoomCatalog() {
    return Object.fromEntries(KINDS.map((kind) => {
      const profile = this.getPublicProfile(kind);
      const profiles = this.listProfiles(kind).map((item) => {
        const publicProfile = this.getPublicProfile(kind, item.id);
        return { id: item.id, label: item.label, model: item.model, ready: publicProfile.ready, isDefault: publicProfile.isDefault };
      });
      return [kind, profile
        ? { kind, label: profile.label, model: profile.model, ready: profile.ready, configured: true, defaultProfileId: profile.id, profiles }
        : { kind, ready: false, configured: false, defaultProfileId: null, profiles: [] }];
    }));
  }

  async saveProfile(kind, input) {
    const validKind = validateKind(kind);
    if (input?.create === true && input.id !== undefined) throw new Error("新增模型不能覆盖已有模型配置");
    const id = input?.id === undefined ? `capability-${validKind}-${randomUUID()}` : input.id;
    if (typeof id !== "string" || !validProfileId(validKind, id)) throw new Error("AI 专用能力配置 ID 无效");
    if (input.id !== undefined && !this.profiles.has(id)) throw new Error("指定的 AI 专用能力配置不存在");
    if (this.profiles.size >= 300 && !this.profiles.has(id)) throw new Error("AI 专用能力配置数量已达上限");
    const profile = validateProfile(validKind, input, id);
    const apiKeyProvided = typeof input.apiKey === "string" && input.apiKey.length > 0;
    if (apiKeyProvided) {
      if (input.apiKey.length > 10_000) throw new Error("API Key 长度无效");
      this.sessionApiKeys.set(id, input.apiKey);
    }
    const rememberKey = input.rememberKey === true || input.rememberKey === "true" || input.rememberKey === "on";
    if (rememberKey && !this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用，API Key 只能保留在本次会话");
    const apiKey = this.sessionApiKeys.get(id);
    if (rememberKey && !apiKey) throw new Error("请先输入 API Key，再选择记住密钥");
    this.profiles.set(id, profile);
    if (!this.defaultProfileIds.has(validKind)) this.defaultProfileIds.set(validKind, id);
    this.connectionTests.delete(id);
    await this.persist();
    if (rememberKey) await this.persistKey(id, apiKey);
    else if (Object.hasOwn(input, "rememberKey")) {
      await fsp.rm(this.secretPath(id), { force: true });
      this.storedKeyIds.delete(id);
    }
    return this.getPublicState();
  }

  async clearKey(kind, id) {
    const profile = this.resolveProfile(kind, id);
    if (!profile) return this.getPublicState();
    this.sessionApiKeys.delete(profile.id);
    this.storedKeyIds.delete(profile.id);
    this.keyStorageErrors.delete(profile.id);
    this.connectionTests.delete(profile.id);
    await fsp.rm(this.secretPath(profile.id), { force: true });
    return this.getPublicState();
  }

  async deleteProfile(kind, id) {
    const profile = this.resolveProfile(kind, id);
    if (!profile) return this.getPublicState();
    await this.clearKey(kind, profile.id);
    this.profiles.delete(profile.id);
    if (this.defaultProfileIds.get(profile.kind) === profile.id) {
      const next = this.listProfiles(profile.kind)[0]?.id;
      if (next) this.defaultProfileIds.set(profile.kind, next);
      else this.defaultProfileIds.delete(profile.kind);
    }
    await this.persist();
    return this.getPublicState();
  }

  async setDefaultProfile(kind, id) {
    if (typeof id !== "string" || !id) throw new Error("请选择默认模型配置");
    const profile = this.resolveProfile(kind, id);
    this.defaultProfileIds.set(profile.kind, profile.id);
    await this.persist();
    return this.getPublicState();
  }

  ensureConfigured(kind, id) {
    const validKind = validateKind(kind);
    const profile = this.resolveProfile(validKind, id);
    if (!profile) throw new Error(`${DEFAULTS[validKind].label}尚未配置，请先到工作台 AI 能力设置中完成配置`);
    if (!this.sessionApiKeys.get(profile.id) && !/^http:\/\//.test(profile.baseUrl)) throw new Error(`${profile.label}缺少可用 API Key`);
    return profile;
  }

  async embed(texts, options = {}) {
    const profile = this.ensureConfigured("embedding", options.profileId);
    return requestEmbeddings(profile, this.sessionApiKeys.get(profile.id), texts, {
      ...options,
      model: options.model || profile.model,
      dimensions: options.dimensions || profile.dimensions
    });
  }

  async rerank(query, documents, options = {}) {
    const profile = this.ensureConfigured("rerank", options.profileId);
    return { ...(await requestRerank(profile, this.sessionApiKeys.get(profile.id), query, documents, { ...options, model: options.model || profile.model })), profileId: profile.id };
  }

  async intuition(state, questions, options = {}) {
    const profile = this.ensureConfigured("intuition", options.profileId);
    return { ...(await requestIntuition(profile, this.sessionApiKeys.get(profile.id), state, questions, { ...options, model: options.model || profile.model })), profileId: profile.id };
  }

  async testConnection(kind, id) {
    const validKind = validateKind(kind);
    const profile = this.ensureConfigured(validKind, id);
    const startedAt = Date.now();
    try {
      let value;
      if (validKind === "embedding") value = await this.embed(["连接测试"], { profileId: profile.id });
      else if (validKind === "rerank") value = await this.rerank("连接", ["连接测试"], { topN: 1, profileId: profile.id });
      else value = await this.intuition("连接测试", { reachable: { type: "noul", instructions: "这是一条连接测试吗？" } }, { profileId: profile.id });
      const status = { ok: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt, model: value.model };
      this.connectionTests.set(profile.id, status);
      return { ...status, profiles: this.getPublicState() };
    } catch (error) {
      this.connectionTests.set(profile.id, {
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
