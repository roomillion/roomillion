"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { requestEmbeddings, supportsEmbeddingTransport } = require("./embedding-client.cjs");

const CUSTOM_PROVIDER_ID = "custom-openai-compatible";
const PROVIDER_REGISTRY_FORMAT = "0.2";
const FEATURED_PROVIDER_ORDER = Object.freeze([
  "xiaomi-token-plan-cn",
  "kimi-coding",
  "qwen-token-plan-cn",
  "zai-coding-cn",
  "minimax-cn",
  "deepseek",
  "xiaomi",
  "moonshotai-cn",
  "openai",
  "anthropic",
  "google",
  "openrouter"
]);
const PROVIDER_PRESENTATION = Object.freeze({
  "xiaomi-token-plan-cn": { displayName: "MiMo Token Plan（中国）", description: "小米 MiMo 订阅计划；选择后只需填写 Token Plan Key。", defaultModel: "mimo-v2.5", featured: true },
  "kimi-coding": { displayName: "Kimi Code / Token Plan", description: "Kimi 编程订阅服务；使用 api.kimi.com/coding，与 Moonshot 开放平台 Key 分开。", defaultModel: "kimi-for-coding", featured: true, category: "china" },
  "qwen-token-plan-cn": { displayName: "通义千问 Token Plan（中国）", description: "阿里云百炼 Token Plan，模型列表由 Pi 提供。", defaultModel: "qwen3.6-flash", category: "china" },
  "zai-coding-cn": { displayName: "智谱 Z.AI Coding（中国）", description: "智谱 Coding Plan 中国区。", defaultModel: "glm-4.7", category: "china" },
  "minimax-cn": { displayName: "MiniMax（中国）", description: "MiniMax 中国区 API。", defaultModel: "MiniMax-M2.7", category: "china" },
  deepseek: { displayName: "DeepSeek", description: "DeepSeek 官方 API。", defaultModel: "deepseek-v4-flash", category: "china" },
  xiaomi: { displayName: "小米 MiMo API", description: "小米 MiMo 按 API 用量调用。", defaultModel: "mimo-v2.5", category: "china" },
  "moonshotai-cn": { displayName: "Kimi 开放平台（中国）", description: "月之暗面按量计费开放平台；使用 api.moonshot.cn/v1，不接受 Kimi Code 订阅 Key。", defaultModel: "kimi-k2.5", category: "china" },
  moonshotai: { displayName: "Kimi 开放平台（国际）", description: "月之暗面国际开放平台 API。", defaultModel: "kimi-k2.5", category: "global" },
  openai: { displayName: "OpenAI API", description: "OpenAI 官方 API。", defaultModel: "gpt-4.1-mini", category: "global" },
  anthropic: { displayName: "Anthropic API", description: "Anthropic Claude 官方 API。", defaultModel: "claude-haiku-4-5", category: "global" },
  google: { displayName: "Google Gemini API", description: "Google AI Studio / Gemini API。", defaultModel: "gemini-2.5-flash", category: "global" },
  openrouter: { displayName: "OpenRouter", description: "使用一个 Key 选择 OpenRouter 聚合模型。", defaultModel: "auto", category: "aggregation" },
  "qwen-token-plan": { displayName: "通义千问 Token Plan（国际）", description: "阿里云百炼国际 Token Plan。", category: "global" },
  "qwen-token-plan-individual": { displayName: "通义千问 Token Plan（个人国际版）", description: "阿里云百炼个人国际 Token Plan。", category: "global" },
  "xiaomi-token-plan-ams": { displayName: "MiMo Token Plan（美洲）", description: "小米 MiMo 美洲区订阅计划。", category: "global" },
  "xiaomi-token-plan-sgp": { displayName: "MiMo Token Plan（新加坡）", description: "小米 MiMo 新加坡区订阅计划。", category: "global" },
  zai: { displayName: "智谱 Z.AI（国际）", description: "智谱国际 Coding API。", category: "global" },
  "openai-codex": { displayName: "OpenAI Codex（OAuth）", description: "Pi 原生 ChatGPT Plus/Pro OAuth 提供商。", category: "oauth" },
  "amazon-bedrock": { category: "cloud" },
  "azure-openai-responses": { category: "cloud" },
  "google-vertex": { category: "cloud" },
  "cloudflare-ai-gateway": { category: "cloud" },
  "cloudflare-workers-ai": { category: "cloud" },
  baseten: { category: "aggregation" },
  fireworks: { category: "aggregation" },
  huggingface: { category: "aggregation" },
  nvidia: { category: "aggregation" },
  opencode: { category: "aggregation" },
  "opencode-go": { category: "aggregation" },
  together: { category: "aggregation" },
  "vercel-ai-gateway": { category: "aggregation" },
  radius: { category: "oauth" }
});

const PROVIDER_CATEGORY_LABELS = Object.freeze({
  china: "中国区与编程订阅",
  global: "国际官方 API",
  aggregation: "聚合与推理平台",
  cloud: "云平台",
  oauth: "OAuth 与动态服务",
  other: "其他 Pi Provider"
});

const PROVIDER_LIMITATIONS = Object.freeze({
  "openai-codex": "Pi 原生提供商仅支持 OAuth；工作台当前版本尚未接入 OAuth 登录流程。",
  radius: "Pi 的 Radius 模型目录需要登录后动态刷新；当前离线目录中没有可选模型。",
  "azure-openai-responses": "需要 Azure Resource/Base URL、API Version 与部署映射；当前工作台的单 Key 表单尚不能完整表达这些参数。"
});

const PROVIDER_CONFIGURATION_HINTS = Object.freeze({
  "amazon-bedrock": "当前表单支持 Bedrock bearer token；AWS Profile/凭据链需在启动工作台前配置系统环境。",
  "cloudflare-ai-gateway": "除 API Key 外，还需在启动工作台前设置 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_GATEWAY_ID。",
  "cloudflare-workers-ai": "除 API Key 外，还需在启动工作台前设置 CLOUDFLARE_ACCOUNT_ID。",
  "google-vertex": "除 API Key 外，还需在启动工作台前设置 GOOGLE_CLOUD_PROJECT 与 GOOGLE_CLOUD_LOCATION。"
});

function providerSortIndex(providerId) {
  const featuredIndex = FEATURED_PROVIDER_ORDER.indexOf(providerId);
  return featuredIndex >= 0 ? featuredIndex : FEATURED_PROVIDER_ORDER.length;
}

function providerCategory(providerId, presentation) {
  if (presentation.category) return presentation.category;
  if (providerId.endsWith("-cn")) return "china";
  return "other";
}

function modelBaseUrl(provider, model) {
  return String(model?.baseUrl || provider?.baseUrl || "").trim();
}

function validateBaseUrl(value) {
  if (typeof value !== "string" || value.length > 500) throw new Error("API 地址无效");
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("API 地址只支持 HTTP 或 HTTPS");
  if (url.username || url.password) throw new Error("API 地址中不能包含用户名或密码");
  return value.replace(/\/+$/, "");
}

function validateProfile(input) {
  if (!input || typeof input !== "object") throw new Error("Provider 配置无效");
  const name = String(input.name || "OpenAI-compatible").trim();
  const model = String(input.model || "").trim();
  const providerId = String(input.providerId || CUSTOM_PROVIDER_ID).trim();
  if (!name || name.length > 80) throw new Error("Provider 名称无效");
  if (!model || model.length > 160) throw new Error("模型名称不能为空");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(providerId)) throw new Error("Provider ID 无效");
  const id = String(input.id || "default").trim();
  const label = String(input.label || `${name} · ${model}`).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)) throw new Error("模型配置 ID 无效");
  if (!label || label.length > 100) throw new Error("模型配置名称无效");
  return {
    id,
    label,
    providerId,
    name,
    protocol: providerId === CUSTOM_PROVIDER_ID ? "openai-completions" : String(input.protocol || "openai-completions"),
    baseUrl: validateBaseUrl(String(input.baseUrl || "")),
    model
  };
}

function validateRoomId(value) {
  const roomId = String(value || "").trim();
  if (!roomId || roomId.length > 200 || /[\\/\0-\x1f]/.test(roomId)) throw new Error("房间 ID 无效");
  return roomId;
}

function validateOrganizationConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("组织 AI 配置无效");
  if (input.formatVersion !== "0.1" || !input.provider || typeof input.provider !== "object") {
    throw new Error("不支持的组织 AI 配置版本");
  }
  const serialized = JSON.stringify(input);
  if (/api.?key|authorization|password|secret|token/i.test(serialized)) {
    throw new Error("组织 AI 配置不得包含密钥或口令");
  }
  return validateProfile(input.provider);
}

function getProviderCompatibility(profile) {
  let hostname = "";
  try {
    hostname = new URL(profile.baseUrl).hostname.toLowerCase();
  } catch {}
  const isMiMo = String(profile.providerId || "").startsWith("xiaomi") || hostname === "xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com") || /^mimo(?:-|$)/i.test(profile.model);
  return {
    family: isMiMo ? "mimo" : "openai-compatible",
    disableThinking: isMiMo,
    supportsJsonObject: isMiMo
  };
}

function providerRequestOptions(profile, sessionId) {
  if (!["opencode", "opencode-go"].includes(profile.providerId)) return { sessionId };
  return {
    sessionId,
    headers: {
      "User-Agent": `roomillion/${require("../../package.json").version}`,
      "x-opencode-session": sessionId
    }
  };
}

class AiService {
  constructor(dataRoot, { secureStorage = null } = {}) {
    this.profilePath = path.join(dataRoot, "provider.json");
    this.legacySecretPath = path.join(dataRoot, "provider-secret.bin");
    this.secretRoot = path.join(dataRoot, "provider-secrets");
    this.profiles = new Map();
    this.activeProfileId = null;
    this.roomSelections = new Map();
    this.roomModelSlots = new Map();
    this.sessionApiKeys = new Map();
    this.storedKeyIds = new Set();
    this.keyStorageErrors = new Map();
    this.connectionTests = new Map();
    this.secureStorage = secureStorage;
    this.piModulesPromise = null;
  }

  get profile() {
    return this.activeProfileId ? this.profiles.get(this.activeProfileId) || null : null;
  }

  get sessionApiKey() {
    return this.activeProfileId ? this.sessionApiKeys.get(this.activeProfileId) || null : null;
  }

  secretPathFor(profileId) {
    return path.join(this.secretRoot, `${profileId}.bin`);
  }

  createProfileId() {
    return `model-` + crypto.randomUUID().replace(/-/g, "");
  }

  async init() {
    let legacyProfile = null;
    let shouldPersistMigration = false;
    try {
      const stored = JSON.parse(await fsp.readFile(this.profilePath, "utf8"));
      if (stored?.formatVersion === PROVIDER_REGISTRY_FORMAT && Array.isArray(stored.profiles)) {
        for (const rawProfile of stored.profiles) {
          try {
            const profile = rawProfile.providerId
              ? await this.resolveProfileInput(rawProfile)
              : await this.matchBuiltinProfile(validateProfile(rawProfile));
            this.profiles.set(profile.id, profile);
          } catch {}
        }
        this.activeProfileId = this.profiles.has(stored.activeProfileId)
          ? stored.activeProfileId
          : this.profiles.keys().next().value || null;
        if (stored.roomSelections && typeof stored.roomSelections === "object" && !Array.isArray(stored.roomSelections)) {
          for (const [roomId, profileId] of Object.entries(stored.roomSelections)) {
            try {
              const validRoomId = validateRoomId(roomId);
              if (this.profiles.has(profileId)) this.roomSelections.set(validRoomId, profileId);
            } catch {}
          }
        }
        if (stored.roomModelSlots && typeof stored.roomModelSlots === "object" && !Array.isArray(stored.roomModelSlots)) {
          for (const [roomId, slots] of Object.entries(stored.roomModelSlots)) {
            try {
              const validRoomId = validateRoomId(roomId);
              if (!slots || typeof slots !== "object" || Array.isArray(slots)) continue;
              const validSlots = {};
              for (const [slot, profileId] of Object.entries(slots)) {
                if (/^[a-z][a-z0-9-]{0,31}$/.test(slot) && this.profiles.has(profileId)) validSlots[slot] = profileId;
              }
              if (Object.keys(validSlots).length) this.roomModelSlots.set(validRoomId, validSlots);
            } catch {}
          }
        }
      } else {
        legacyProfile = stored.providerId
          ? await this.resolveProfileInput(stored)
          : await this.matchBuiltinProfile(validateProfile(stored));
        this.profiles.set(legacyProfile.id, legacyProfile);
        this.activeProfileId = legacyProfile.id;
        shouldPersistMigration = true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.profiles.clear();
        this.activeProfileId = null;
      }
    }

    for (const profileId of this.profiles.keys()) await this.loadStoredKey(profileId);
    if (legacyProfile && !this.storedKeyIds.has(legacyProfile.id)) {
      try {
        const encrypted = await fsp.readFile(this.legacySecretPath);
        if (!this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用，已忽略已保存密钥");
        const apiKey = this.secureStorage.decryptString(encrypted);
        if (apiKey) {
          this.sessionApiKeys.set(legacyProfile.id, apiKey);
          await this.persistStoredKey(legacyProfile.id, apiKey);
          await fsp.rm(this.legacySecretPath, { force: true });
          shouldPersistMigration = true;
        }
      } catch (error) {
        if (error.code !== "ENOENT") this.keyStorageErrors.set(legacyProfile.id, error.message);
      }
    }
    if (shouldPersistMigration) await this.persistRegistry();
    return this;
  }

  async loadStoredKey(profileId) {
    try {
      const encrypted = await fsp.readFile(this.secretPathFor(profileId));
      if (!this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用，已忽略已保存密钥");
      const apiKey = this.secureStorage.decryptString(encrypted);
      if (apiKey) {
        this.sessionApiKeys.set(profileId, apiKey);
        this.storedKeyIds.add(profileId);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.keyStorageErrors.set(profileId, error.message);
    }
  }

  async persistRegistry() {
    const payload = {
      formatVersion: PROVIDER_REGISTRY_FORMAT,
      activeProfileId: this.activeProfileId,
      profiles: [...this.profiles.values()],
      roomSelections: Object.fromEntries(this.roomSelections),
      roomModelSlots: Object.fromEntries(this.roomModelSlots)
    };
    await fsp.mkdir(path.dirname(this.profilePath), { recursive: true });
    const temporaryPath = `${this.profilePath}.tmp`;
    await fsp.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fsp.rename(temporaryPath, this.profilePath);
  }

  async persistStoredKey(profileId, apiKey) {
    if (!this.isSecureStorageAvailable()) throw new Error("当前系统安全存储不可用，API Key 只能保留在本次会话");
    await fsp.mkdir(this.secretRoot, { recursive: true });
    const secretPath = this.secretPathFor(profileId);
    const temporaryPath = `${secretPath}.tmp`;
    await fsp.writeFile(temporaryPath, this.secureStorage.encryptString(apiKey));
    await fsp.rename(temporaryPath, secretPath);
    this.storedKeyIds.add(profileId);
    this.keyStorageErrors.delete(profileId);
  }

  async matchBuiltinProfile(profile) {
    try {
      const catalog = await this.getProviderCatalog();
      const matched = catalog.find((provider) =>
        provider.id !== CUSTOM_PROVIDER_ID &&
        provider.models.some((model) =>
          model.id === profile.model &&
          (model.baseUrl === profile.baseUrl || provider.baseUrl === profile.baseUrl)
        )
      );
      const matchedModel = matched?.models.find((model) => model.id === profile.model);
      return matched ? validateProfile({
        id: profile.id,
        label: profile.label,
        providerId: matched.id,
        name: matched.displayName,
        protocol: matchedModel?.api,
        baseUrl: matchedModel?.baseUrl || matched.baseUrl,
        model: profile.model
      }) : profile;
    } catch {
      return profile;
    }
  }

  isSecureStorageAvailable() {
    try {
      return Boolean(this.secureStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  getPublicProfile(profileId = this.activeProfileId) {
    const profile = profileId ? this.profiles.get(profileId) : null;
    return profile ? {
      ...profile,
      isActive: profile.id === this.activeProfileId,
      hasSessionKey: Boolean(this.sessionApiKeys.get(profile.id)),
      ready: Boolean(this.sessionApiKeys.get(profile.id)) || /^http:\/\//.test(profile.baseUrl),
      hasStoredKey: this.storedKeyIds.has(profile.id),
      secureStorageAvailable: this.isSecureStorageAvailable(),
      keyStorageError: this.keyStorageErrors.get(profile.id) || null,
      connectionTest: this.connectionTests.get(profile.id) || null
    } : null;
  }

  listPublicProfiles() {
    return [...this.profiles.keys()].map((profileId) => this.getPublicProfile(profileId));
  }

  getPublicState() {
    return {
      activeProfile: this.getPublicProfile(),
      profiles: this.listPublicProfiles()
    };
  }

  async saveProfile(input) {
    const requestedId = input?.id ? String(input.id) : this.createProfileId();
    const existing = this.profiles.get(requestedId) || null;
    const profile = await this.resolveProfileInput({
      ...input,
      id: requestedId,
      label: input?.label || existing?.label
    });
    const rememberKey = input.rememberKey === true || input.rememberKey === "true" || input.rememberKey === "on";
    const apiKeyProvided = typeof input.apiKey === "string" && input.apiKey.length > 0;
    const credentialSourceProfileId = input?.credentialSourceProfileId
      ? String(input.credentialSourceProfileId)
      : null;
    const providerChanged = Boolean(existing && existing.providerId !== profile.providerId);
    if (apiKeyProvided || credentialSourceProfileId || !existing || existing.baseUrl !== profile.baseUrl || existing.model !== profile.model || existing.protocol !== profile.protocol || providerChanged) this.connectionTests.delete(profile.id);
    if (providerChanged && !apiKeyProvided) {
      this.sessionApiKeys.delete(profile.id);
      this.storedKeyIds.delete(profile.id);
      await fsp.rm(this.secretPathFor(profile.id), { force: true });
    }
    if (apiKeyProvided) {
      if (input.apiKey.length > 10_000) throw new Error("API Key 长度无效");
      this.sessionApiKeys.set(profile.id, input.apiKey);
    } else if (credentialSourceProfileId) {
      const credentialSource = this.profiles.get(credentialSourceProfileId);
      if (!credentialSource || credentialSource.id === profile.id) {
        throw new Error("可复用的 AI 连接不存在");
      }
      const isSameBuiltinProvider = profile.providerId !== CUSTOM_PROVIDER_ID
        && credentialSource.providerId === profile.providerId;
      const isSameCustomConnection = profile.providerId === CUSTOM_PROVIDER_ID
        && credentialSource.providerId === profile.providerId
        && credentialSource.baseUrl === profile.baseUrl;
      if (!isSameBuiltinProvider && !isSameCustomConnection) {
        throw new Error("只能复用同一 AI 提供商的凭据；自定义服务还必须使用相同地址");
      }
      const reusableKey = this.sessionApiKeys.get(credentialSource.id);
      if (!reusableKey) throw new Error("原 AI 连接没有可复用的密钥，请重新输入 API Key");
      this.sessionApiKeys.set(profile.id, reusableKey);
    }
    if (rememberKey && !this.isSecureStorageAvailable()) {
      throw new Error("当前系统安全存储不可用，API Key 只能保留在本次会话");
    }
    const sessionApiKey = this.sessionApiKeys.get(profile.id);
    if (rememberKey && !sessionApiKey) throw new Error("请先输入 API Key，再选择记住密钥");
    this.profiles.set(profile.id, profile);
    if (!this.activeProfileId || input.activate !== false) this.activeProfileId = profile.id;
    await this.persistRegistry();
    if (rememberKey) {
      await this.persistStoredKey(profile.id, sessionApiKey);
    } else {
      await fsp.rm(this.secretPathFor(profile.id), { force: true });
      this.storedKeyIds.delete(profile.id);
    }
    return this.getPublicProfile(profile.id);
  }

  async setActiveProfile(profileId) {
    if (!this.profiles.has(profileId)) throw new Error("模型配置不存在");
    this.activeProfileId = profileId;
    await this.persistRegistry();
    return this.getPublicState();
  }

  async clearSessionKey(profileId = this.activeProfileId) {
    this.connectionTests.delete(profileId);
    if (!profileId || !this.profiles.has(profileId)) throw new Error("模型配置不存在");
    this.sessionApiKeys.delete(profileId);
    this.storedKeyIds.delete(profileId);
    this.keyStorageErrors.delete(profileId);
    await fsp.rm(this.secretPathFor(profileId), { force: true });
    return this.getPublicProfile(profileId);
  }

  async deleteProfile(profileId) {
    if (!this.profiles.has(profileId)) return this.getPublicState();
    this.profiles.delete(profileId);
    this.sessionApiKeys.delete(profileId);
    this.storedKeyIds.delete(profileId);
    this.keyStorageErrors.delete(profileId);
    await fsp.rm(this.secretPathFor(profileId), { force: true });
    for (const [roomId, selectedProfileId] of this.roomSelections) {
      if (selectedProfileId === profileId) this.roomSelections.delete(roomId);
    }
    for (const [roomId, slots] of this.roomModelSlots) {
      const next = Object.fromEntries(Object.entries(slots).filter(([, selectedProfileId]) => selectedProfileId !== profileId));
      if (Object.keys(next).length) this.roomModelSlots.set(roomId, next);
      else this.roomModelSlots.delete(roomId);
    }
    if (this.activeProfileId === profileId) this.activeProfileId = this.profiles.keys().next().value || null;
    await this.persistRegistry();
    return this.getPublicState();
  }

  async importOrganizationConfig(input) {
    const profile = validateOrganizationConfig(input);
    return this.saveProfile({ ...profile, id: this.createProfileId(), activate: true });
  }

  async loadPiModules() {
    if (!this.piModulesPromise) {
      this.piModulesPromise = Promise.all([
        import("@earendil-works/pi-ai"),
        import("@earendil-works/pi-ai/api/openai-completions.lazy"),
        import("@earendil-works/pi-ai/providers/all")
      ]).then(([pi, openai, providers]) => ({ pi, openai, providers, builtinProviders: providers.builtinProviders() }));
    }
    return this.piModulesPromise;
  }

  async getProviderCatalog() {
    const { builtinProviders } = await this.loadPiModules();
    const catalog = [...builtinProviders]
      .sort((left, right) => {
        const rank = providerSortIndex(left.id) - providerSortIndex(right.id);
        return rank || left.name.localeCompare(right.name, "zh-CN");
      })
      .map((provider) => {
      const providerId = provider.id;
      const presentation = PROVIDER_PRESENTATION[providerId] || {};
      const models = provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: modelBaseUrl(provider, model) || null,
        reasoning: Boolean(model.reasoning),
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens
      }));
      const modelEndpoints = [...new Set(models.map((model) => model.baseUrl).filter(Boolean))];
      const baseUrl = String(provider.baseUrl || "").trim() || (modelEndpoints.length === 1 ? modelEndpoints[0] : null);
      const defaultModel = models.some((model) => model.id === presentation.defaultModel)
        ? presentation.defaultModel
        : models[0]?.id;
      const supportsApiKey = Boolean(provider.auth?.apiKey);
      const supportsOAuth = Boolean(provider.auth?.oauth);
      const limitation = PROVIDER_LIMITATIONS[providerId]
        || (!models.length ? "Pi 当前目录中没有可用模型。" : null)
        || (!supportsApiKey ? "当前工作台尚未接入该 Provider 的 OAuth 登录流程。" : null);
      const category = providerCategory(providerId, presentation);
      return {
        id: provider.id,
        name: provider.name,
        displayName: presentation.displayName || provider.name,
        description: presentation.description || "由 Pi AI 原生 Provider 与模型目录提供。",
        baseUrl,
        defaultModel,
        featured: presentation.featured === true,
        category,
        categoryLabel: PROVIDER_CATEGORY_LABELS[category],
        supportsApiKey,
        supportsOAuth,
        apiKeyLabel: provider.auth?.apiKey?.name || null,
        configurable: supportsApiKey && models.length > 0 && !limitation,
        limitation,
        configurationHint: PROVIDER_CONFIGURATION_HINTS[providerId] || null,
        source: "pi-builtin",
        models
      };
    });
    catalog.push({
      id: CUSTOM_PROVIDER_ID,
      name: "OpenAI-compatible",
      displayName: "自定义 / 内网 OpenAI-compatible",
      description: "仅在使用内网网关、Ollama、vLLM 或其他兼容地址时填写高级参数。",
      baseUrl: null,
      defaultModel: null,
      featured: false,
      category: "custom",
      categoryLabel: "自定义与内网",
      supportsApiKey: true,
      supportsOAuth: false,
      apiKeyLabel: "API Key（可选）",
      configurable: true,
      limitation: null,
      configurationHint: null,
      source: "workbench-custom",
      models: []
    });
    return catalog;
  }

  async resolveProfileInput(input) {
    if (!input || typeof input !== "object") throw new Error("Provider 配置无效");
    const providerId = String(input.providerId || CUSTOM_PROVIDER_ID).trim();
    if (providerId === CUSTOM_PROVIDER_ID) return validateProfile({ ...input, providerId });
    const provider = (await this.getProviderCatalog()).find((entry) => entry.id === providerId);
    if (!provider || provider.source !== "pi-builtin") throw new Error("不支持的 Pi Provider");
    if (!provider.configurable) throw new Error(provider.limitation || "当前工作台尚不能配置该 Pi Provider");
    const requestedModel = String(input.model || provider.defaultModel || "").trim();
    const model = provider.models.find((entry) => entry.id === requestedModel);
    if (!model) throw new Error("所选模型不属于当前 Provider");
    const baseUrl = model.baseUrl || provider.baseUrl;
    if (!baseUrl) throw new Error("当前 Provider 需要额外的服务地址参数，工作台尚未完成适配");
    return validateProfile({
      id: input.id,
      label: input.label,
      providerId,
      name: provider.displayName,
      protocol: model.api,
      baseUrl,
      model: model.id
    });
  }

  ensureConfigured(profileId = this.activeProfileId) {
    const profile = profileId ? this.profiles.get(profileId) : null;
    if (!profile) throw new Error("请先在 AI 能力中心配置模型");
    return profile;
  }

  async getModelCapabilities(profileId = this.activeProfileId) {
    const profile = this.ensureConfigured(profileId);
    if (profile.providerId === CUSTOM_PROVIDER_ID) {
      return {
        providerId: profile.providerId,
        model: profile.model,
        input: ["text"],
        supportsImages: false,
        supportsReasoning: false,
        contextWindow: 128000,
        maxTokens: 8192
      };
    }
    const provider = (await this.getProviderCatalog()).find((entry) => entry.id === profile.providerId);
    const model = provider?.models.find((entry) => entry.id === profile.model);
    if (!model) throw new Error("当前 Pi 模型目录中找不到所选模型，请重新选择");
    return {
      providerId: profile.providerId,
      model: model.id,
      input: [...model.input],
      supportsImages: model.input.includes("image"),
      supportsReasoning: model.reasoning === true,
      contextWindow: Number(model.contextWindow) || null,
      maxTokens: Number(model.maxTokens) || null
    };
  }

  async listRoomModels(roomId) {
    const validRoomId = validateRoomId(roomId);
    const selectedProfileId = this.roomSelections.get(validRoomId) || this.activeProfileId;
    const catalog = await this.getProviderCatalog();
    const providers = new Map(catalog.map((provider) => [provider.id, provider]));
    return Promise.all([...this.profiles.values()].map(async (profile) => {
      const capabilities = await this.getModelCapabilities(profile.id);
      const provider = providers.get(profile.providerId);
      return {
        id: profile.id,
        label: profile.label,
        providerId: profile.providerId,
        providerName: profile.providerId === CUSTOM_PROVIDER_ID ? profile.name : provider?.displayName || profile.name,
        model: profile.model,
        input: capabilities.input,
        supportsImages: capabilities.supportsImages,
        embeddingTransport: supportsEmbeddingTransport(profile) ? "openai-compatible" : null,
        contextWindow: capabilities.contextWindow,
        maxTokens: capabilities.maxTokens,
        hasCredential: Boolean(this.sessionApiKeys.get(profile.id)),
        ready: this.getPublicProfile(profile.id).ready,
        isDefault: profile.id === this.activeProfileId,
        isSelected: profile.id === selectedProfileId
      };
    }));
  }

  getRoomModelSelection(roomId) {
    const validRoomId = validateRoomId(roomId);
    const explicitProfileId = this.roomSelections.get(validRoomId);
    const profileId = this.profiles.has(explicitProfileId) ? explicitProfileId : this.activeProfileId;
    return {
      profileId: profileId || null,
      source: explicitProfileId && this.profiles.has(explicitProfileId) ? "room" : "default"
    };
  }

  async selectRoomModel(roomId, profileId) {
    const validRoomId = validateRoomId(roomId);
    if (!this.profiles.has(profileId)) throw new Error("所选模型配置不存在");
    this.roomSelections.set(validRoomId, profileId);
    await this.persistRegistry();
    return this.getRoomModelSelection(validRoomId);
  }
  getRoomModelSlots(roomId) {
    const validRoomId = validateRoomId(roomId);
    const slots = this.roomModelSlots.get(validRoomId) || {};
    return { ...slots };
  }

  resolveRoomModelProfile(roomId, { profileId, slot } = {}) {
    const validRoomId = validateRoomId(roomId);
    if (profileId !== undefined) {
      if (!this.profiles.has(profileId)) throw new Error("所选模型配置不存在");
      return profileId;
    }
    if (slot !== undefined) {
      const validSlot = String(slot || "").trim();
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(validSlot)) throw new Error("模型槽位名称无效");
      const selected = this.roomModelSlots.get(validRoomId)?.[validSlot];
      if (selected && this.profiles.has(selected)) return selected;
    }
    return this.getRoomModelSelection(validRoomId).profileId;
  }

  async selectRoomModelSlot(roomId, slot, profileId) {
    const validRoomId = validateRoomId(roomId);
    const validSlot = String(slot || "").trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(validSlot)) throw new Error("模型槽位名称无效");
    if (!this.profiles.has(profileId)) throw new Error("所选模型配置不存在");
    const slots = { ...(this.roomModelSlots.get(validRoomId) || {}), [validSlot]: profileId };
    this.roomModelSlots.set(validRoomId, slots);
    await this.persistRegistry();
    return { slot: validSlot, profileId };
  }

  async clearRoomModelSlot(roomId, slot) {
    const validRoomId = validateRoomId(roomId);
    const validSlot = String(slot || "").trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(validSlot)) throw new Error("模型槽位名称无效");
    const slots = { ...(this.roomModelSlots.get(validRoomId) || {}) };
    delete slots[validSlot];
    if (Object.keys(slots).length) this.roomModelSlots.set(validRoomId, slots);
    else this.roomModelSlots.delete(validRoomId);
    await this.persistRegistry();
    return { slot: validSlot, profileId: null };
  }

  async createRuntime(profileId = this.activeProfileId) {
    const profile = this.ensureConfigured(profileId);
    const { pi, openai, builtinProviders } = await this.loadPiModules();
    if (profile.providerId !== CUSTOM_PROVIDER_ID) {
      const provider = builtinProviders.find((entry) => entry.id === profile.providerId);
      if (!provider) throw new Error("当前 Pi Provider 不可用，请重新选择提供商");
      const models = pi.createModels();
      models.setProvider(provider);
      const model = models.getModel(provider.id, profile.model);
      if (!model) throw new Error("当前 Pi 模型目录中找不到所选模型，请重新选择");
      return { pi, models, model };
    }
    const providerId = "workbench-openai-compatible";
    const model = {
      id: profile.model,
      name: profile.model,
      api: "openai-completions",
      provider: providerId,
      baseUrl: profile.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens"
      }
    };
    const provider = pi.createProvider({
      id: providerId,
      name: profile.name,
      baseUrl: profile.baseUrl,
      auth: {
        apiKey: {
          name: `${profile.name} API Key`,
          resolve: async ({ credential, signal }) => {
            signal.throwIfAborted();
            return { auth: { apiKey: credential?.key || "local" }, source: "千万间 Roomillion会话" };
          }
        }
      },
      models: [model],
      api: openai.openAICompletionsApi()
    });
    const models = pi.createModels();
    models.setProvider(provider);
    return { pi, models, model };
  }

  async createAgentRuntime({ maxTokens = 8000, timeoutMs = 120_000, maxRetries = 2, profileId = this.activeProfileId } = {}) {
    const profile = this.ensureConfigured(profileId);
    const { pi, models, model } = await this.createRuntime(profile.id);
    if (!Number.isSafeInteger(Number(maxTokens)) || Number(maxTokens) <= 0) throw new Error("Agent 最大输出 Token 必须是正整数");
    if (!Number.isSafeInteger(Number(timeoutMs)) || Number(timeoutMs) <= 0) throw new Error("Agent 请求超时必须是正整数毫秒");
    if (!Number.isSafeInteger(Number(maxRetries)) || Number(maxRetries) < 0 || Number(maxRetries) > 5) throw new Error("Agent 自动重试次数必须是 0–5 的整数");
    const compatibility = getProviderCompatibility(profile);
    // Agent supplies its persistent conversation ID; keep a stable fallback for other callers.
    const fallbackSessionId = crypto.randomUUID();
    const compatibilityPayload = compatibility.disableThinking
      ? (payload) => ({ ...payload, thinking: { type: "disabled" } })
      : null;
    const streamFn = (activeModel, context, options = {}) => {
      const requestOptions = providerRequestOptions(profile, options.sessionId || fallbackSessionId);
      const upstreamPayload = options.onPayload;
      const onPayload = compatibilityPayload || upstreamPayload
        ? (payload) => {
            const upstream = upstreamPayload ? (upstreamPayload(payload) ?? payload) : payload;
            return compatibilityPayload ? compatibilityPayload(upstream) : upstream;
          }
        : undefined;
      return models.streamSimple(activeModel, context, {
        ...options,
        ...requestOptions,
        headers: { ...options.headers, ...requestOptions.headers },
        apiKey: this.sessionApiKeys.get(profile.id) || "local",
        maxTokens: Math.min(Number(activeModel.maxTokens) || maxTokens, maxTokens),
        timeoutMs,
        maxRetries: Number(maxRetries),
        ...(onPayload ? { onPayload } : {})
      });
    };
    return {
      pi,
      model,
      streamFn,
      provider: this.getPublicProfile(profile.id)
    };
  }

  async getActiveModelCapabilities() {
    return this.getModelCapabilities(this.activeProfileId);
  }

  async complete({
    systemPrompt,
    prompt,
    images = [],
    maxTokens = 2048,
    timeoutMs = 60_000,
    maxRetries = 2,
    temperature,
    structuredOutput = false,
    sessionId = crypto.randomUUID(),
    onTextDelta,
    signal,
    profileId = this.activeProfileId
  }) {
    signal?.throwIfAborted();
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("AI 提示内容长度无效");
    }
    if (!Array.isArray(images)) throw new Error("AI 图片输入必须是数组");
    const profile = this.ensureConfigured(profileId);
    const { pi, models, model } = await this.createRuntime(profile.id);
    const requestedMaxTokens = Number(maxTokens);
    if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) {
      throw new Error("AI 最大输出 Token 必须是正整数");
    }
    const declaredModelMaxTokens = Number(model.maxTokens);
    const effectiveMaxTokens = Number.isSafeInteger(declaredModelMaxTokens) && declaredModelMaxTokens > 0
      ? Math.min(requestedMaxTokens, declaredModelMaxTokens)
      : requestedMaxTokens;
    const effectiveTimeoutMs = Number(timeoutMs);
    if (!Number.isSafeInteger(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) throw new Error("AI 请求超时必须是正整数毫秒");
    const effectiveMaxRetries = Number(maxRetries);
    if (!Number.isSafeInteger(effectiveMaxRetries) || effectiveMaxRetries < 0 || effectiveMaxRetries > 5) throw new Error("AI 自动重试次数必须是 0–5 的整数");
    if (images.length && (!Array.isArray(model.input) || !model.input.includes("image"))) {
      throw new Error(`当前模型 ${model.id} 不支持图片输入，请切换到多模态模型`);
    }
    const normalizedImages = images.map((image) => {
      if (!image || typeof image !== "object" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) {
        throw new Error("AI 图片格式无效");
      }
      if (typeof image.data !== "string" || image.data.length === 0) {
        throw new Error("AI 图片内容无效");
      }
      return { type: "image", mimeType: image.mimeType, data: image.data };
    });
    const compatibility = getProviderCompatibility(profile);
    const onPayload = compatibility.disableThinking || (structuredOutput && compatibility.supportsJsonObject)
      ? (payload) => {
          const nextPayload = { ...payload };
          if (compatibility.disableThinking) nextPayload.thinking = { type: "disabled" };
          if (structuredOutput && compatibility.supportsJsonObject) {
            nextPayload.response_format = { type: "json_object" };
          }
          return nextPayload;
        }
      : undefined;
    const context = {
      systemPrompt,
      messages: [{
        role: "user",
        content: normalizedImages.length
          ? [{ type: "text", text: prompt }, ...normalizedImages]
          : prompt,
        timestamp: Date.now()
      }]
    };
    const requestOptions = {
      ...providerRequestOptions(profile, sessionId),
      apiKey: this.sessionApiKeys.get(profile.id) || "local",
      maxTokens: effectiveMaxTokens,
      temperature,
      timeoutMs: effectiveTimeoutMs,
      maxRetries: effectiveMaxRetries,
      signal,
      onPayload
    };
    let response;
    if (typeof onTextDelta === "function") {
      const stream = models.streamSimple(model, context, requestOptions);
      for await (const event of stream) {
        if (!signal?.aborted && event.type === "text_delta" && typeof event.delta === "string" && event.delta) {
          try { onTextDelta(event.delta); } catch {}
        }
      }
      response = await stream.result();
    } else {
      response = await models.completeSimple(model, context, requestOptions);
    }
    signal?.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "AI 请求失败");
    }
    const text = pi.contentText(response.content).trim();
    if (!text) throw new Error("AI 返回了空内容");
    return { text, usage: response.usage, model: model.id };
  }

  async embed(texts, options = {}) {
    const profile = this.ensureConfigured(options.profileId || this.activeProfileId);
    return requestEmbeddings(profile, this.sessionApiKeys.get(profile.id), texts, options);
  }

  async testConnection(profileId = this.activeProfileId) {
    const startedAt = Date.now();
    const profile = this.profiles.get(profileId);
    const key = this.sessionApiKeys.get(profileId);
    try {
      const result = await this.complete({
        systemPrompt: "You are a connectivity test. Follow the user instruction exactly.",
        prompt: "Reply with exactly: OK",
        // Reasoning models may spend their first tokens on hidden thinking.
        maxTokens: 256,
        timeoutMs: 25_000,
        profileId
      });
      const status = { ok: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
      if (this.profiles.get(profileId) === profile && this.sessionApiKeys.get(profileId) === key) this.connectionTests.set(profileId, status);
      return { ...status, reply: result.text, model: result.model };
    } catch (error) {
      if (this.profiles.get(profileId) === profile && this.sessionApiKeys.get(profileId) === key) this.connectionTests.set(profileId, { ok: false, checkedAt: new Date().toISOString() });
      throw error;
    }
  }
}

module.exports = {
  AiService,
  CUSTOM_PROVIDER_ID,
  getProviderCompatibility,
  validateBaseUrl,
  validateOrganizationConfig,
  validateProfile
};
