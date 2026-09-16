"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { ROOM_ID_PATTERN, normalizeNetworkOrigin } = require("./manifest.cjs");

const PERMISSION_DEFINITIONS = Object.freeze({
  "database.private": Object.freeze({
    key: "database.private",
    domain: "database",
    value: "private",
    title: "保存房间私有数据",
    description: "在工作台为这个房间单独保存数据，其他房间不能读取。",
    risk: "low",
    required: true
  }),
  "files.pick": Object.freeze({
    key: "files.pick",
    domain: "files",
    value: "pick",
    title: "读取你主动选择的文件",
    description: "每次都由你在系统窗口中选择文本或办公文件；房间不会获得文件夹或任意路径权限。",
    risk: "medium",
    required: false
  }),
  "files.pickMany": Object.freeze({
    key: "files.pickMany",
    domain: "files",
    value: "pickMany",
    title: "一次读取多个所选文件",
    description: "由你在系统窗口中批量选择文件；房间只获得临时文件令牌。",
    risk: "medium",
    required: false
  }),
  "files.directoryRead": Object.freeze({
    key: "files.directoryRead",
    domain: "files",
    value: "directoryRead",
    title: "读取所选文件夹",
    description: "由你选择一个文件夹；房间可以通过不含真实路径的授权句柄分页读取其中的文件。",
    risk: "medium",
    required: false
  }),
  "files.directoryWrite": Object.freeze({
    key: "files.directoryWrite",
    domain: "files",
    value: "directoryWrite",
    title: "写入所选输出文件夹",
    description: "由你选择一个输出文件夹；房间可以在该范围内连续创建制品，不会访问其他路径。",
    risk: "medium",
    required: false
  }),
  "files.export": Object.freeze({
    key: "files.export",
    domain: "files",
    value: "export",
    title: "导出文件",
    description: "每次都由你选择文本或办公文件的保存位置，房间不能静默写入其他路径。",
    risk: "low",
    required: false
  }),
  "files.largeText": Object.freeze({
    key: "files.largeText",
    domain: "files",
    value: "largeText",
    title: "流式读取超长文本",
    description: "每次由你选择文件；房间只收到临时令牌和小块文本结果，不会获得文件路径或一次载入整份文件。",
    risk: "medium",
    required: false
  }),
  "ai.general": Object.freeze({
    key: "ai.general",
    domain: "ai",
    value: "general",
    title: "调用通用 AI 模型",
    description: "房间提交的提示词会发送到你在工作台配置的 AI 服务。",
    risk: "high",
    required: false
  }),
  "ai.coding": Object.freeze({
    key: "ai.coding",
    domain: "ai",
    value: "coding",
    title: "调用编程 AI 模型",
    description: "房间提交的提示词会发送到你配置的编程模型。",
    risk: "high",
    required: false
  }),
  "ai.vision": Object.freeze({
    key: "ai.vision",
    domain: "ai",
    value: "vision",
    title: "调用视觉 AI 模型",
    description: "房间提交的图像或相关提示词会发送到你配置的视觉模型。",
    risk: "high",
    required: false
  }),
  "compute.worker": Object.freeze({
    key: "compute.worker",
    domain: "compute",
    value: "worker",
    title: "运行沙箱计算 Worker",
    description: "允许房间用同源 Web Worker 处理批量排序、合并和计算任务；Worker 不能访问 Node.js 或 Electron。",
    risk: "low",
    required: false
  }),
  "browser.navigate": Object.freeze({
    key: "browser.navigate",
    domain: "browser",
    value: "navigate",
    title: "浏览任意网站",
    description: "允许房间通过工作台托管的隔离浏览器访问任意 HTTP/HTTPS 网站；仍受主工作台联网总开关控制。",
    risk: "high",
    required: false
  }),
  "browser.download": Object.freeze({
    key: "browser.download",
    domain: "browser",
    value: "download",
    title: "从网站下载文件",
    description: "允许网页发起下载；每个文件都必须由你在系统保存窗口中确认位置。",
    risk: "high",
    required: false
  })
});

const NETWORK_PERMISSION_PREFIX = "network:";
const TOOL_PERMISSION_PREFIX = "tool:";
const CREDENTIAL_PERMISSION_PREFIX = "credential:";

function credentialPermissionKey(alias) {
  const value = String(alias || "").trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error(`凭据别名无效：${value || "(空)"}`);
  return `${CREDENTIAL_PERMISSION_PREFIX}${value}`;
}

function toolPermissionKey(toolId) {
  const id = String(toolId || "").trim();
  if (!/^[a-z][a-z0-9.-]{1,79}@\d+$/.test(id)) throw new Error(`房间工具 ID 无效：${id || "(空)"}`);
  return `${TOOL_PERMISSION_PREFIX}${id}`;
}

function networkPermissionKey(origin) {
  return `${NETWORK_PERMISSION_PREFIX}${normalizeNetworkOrigin(origin)}`;
}

function permissionDefinition(key) {
  if (PERMISSION_DEFINITIONS[key]) return PERMISSION_DEFINITIONS[key];
  if (typeof key === "string" && key.startsWith(CREDENTIAL_PERMISSION_PREFIX)) {
    const alias = credentialPermissionKey(key.slice(CREDENTIAL_PERMISSION_PREFIX.length)).slice(CREDENTIAL_PERMISSION_PREFIX.length);
    return Object.freeze({ key: credentialPermissionKey(alias), domain: "credentials", value: alias, title: `使用本机凭据 ${alias}`, description: "允许房间在匹配的受控网络请求中引用这个凭据；明文不会返回给房间。", risk: "high", required: false });
  }
  if (typeof key === "string" && key.startsWith(TOOL_PERMISSION_PREFIX)) {
    const toolId = toolPermissionKey(key.slice(TOOL_PERMISSION_PREFIX.length)).slice(TOOL_PERMISSION_PREFIX.length);
    return Object.freeze({ key: toolPermissionKey(toolId), domain: "tools", value: toolId, title: `使用宿主工具 ${toolId}`, description: "允许房间把明确的结构化输入交给这个本机工具；工具返回结构化结果，不向房间开放系统权限。", risk: "medium", required: false });
  }
  if (typeof key === "string" && key.startsWith(NETWORK_PERMISSION_PREFIX)) {
    const origin = normalizeNetworkOrigin(key.slice(NETWORK_PERMISSION_PREFIX.length));
    return Object.freeze({
      key: networkPermissionKey(origin),
      domain: "network",
      value: origin,
      title: `连接网络服务 ${new URL(origin).host}`,
      description: `允许房间通过工作台访问 ${origin}。只有主工作台联网总开关同时开启时才会发出请求。`,
      risk: "high",
      required: false
    });
  }
  return null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function keysForPermissions(permissions = {}) {
  const keys = [];
  if (permissions.database === "private") keys.push("database.private");
  if (Array.isArray(permissions.files)) {
    for (const value of permissions.files) {
      const key = `files.${value}`;
      if (PERMISSION_DEFINITIONS[key]) keys.push(key);
    }
  }
  if (permissions.ai && Array.isArray(permissions.ai.roles)) {
    for (const value of permissions.ai.roles) {
      const key = `ai.${value}`;
      if (PERMISSION_DEFINITIONS[key]) keys.push(key);
    }
  }
  if (Array.isArray(permissions.compute)) {
    for (const value of permissions.compute) {
      const key = `compute.${value}`;
      if (PERMISSION_DEFINITIONS[key]) keys.push(key);
    }
  }
  if (Array.isArray(permissions.browser)) {
    for (const value of permissions.browser) {
      const key = `browser.${value}`;
      if (PERMISSION_DEFINITIONS[key]) keys.push(key);
    }
  }
  if (Array.isArray(permissions.credentials)) for (const alias of permissions.credentials) keys.push(credentialPermissionKey(alias));
  if (Array.isArray(permissions.tools)) for (const toolId of permissions.tools) keys.push(toolPermissionKey(toolId));
  if (Array.isArray(permissions.network)) {
    for (const origin of permissions.network) keys.push(networkPermissionKey(origin));
  }
  return [...new Set(keys)];
}

function permissionsForKeys(requestedPermissions, selectedKeys) {
  if (!Array.isArray(selectedKeys)) throw new Error("授权列表必须是数组");
  const requestedKeys = keysForPermissions(requestedPermissions);
  const requested = new Set(requestedKeys);
  const selected = new Set(selectedKeys);
  for (const key of selected) {
    if (typeof key !== "string" || !requested.has(key)) throw new Error(`不能授予房间未申请的权限：${key}`);
  }
  for (const key of requestedKeys) {
    if (permissionDefinition(key).required) selected.add(key);
  }

  const granted = {};
  if (selected.has("database.private")) granted.database = "private";
  const files = [...selected]
    .filter((key) => key.startsWith("files."))
    .map((key) => key.slice("files.".length));
  if (files.length) granted.files = files;
  const roles = [...selected]
    .filter((key) => key.startsWith("ai."))
    .map((key) => key.slice("ai.".length));
  if (roles.length) {
    const slots = requestedPermissions.ai?.slots && typeof requestedPermissions.ai.slots === "object"
      ? Object.fromEntries(Object.entries(requestedPermissions.ai.slots).filter(([, slot]) => roles.includes(slot.role)))
      : null;
    granted.ai = { roles, ...(slots && Object.keys(slots).length ? { slots: clone(slots) } : {}) };
  }
  const compute = [...selected]
    .filter((key) => key.startsWith("compute."))
    .map((key) => key.slice("compute.".length));
  if (compute.length) granted.compute = compute;
  const browser = [...selected]
    .filter((key) => key.startsWith("browser."))
    .map((key) => key.slice("browser.".length));
  if (browser.includes("download") && !browser.includes("navigate")) {
    throw new Error("浏览器下载权限需要同时授予浏览网页权限");
  }
  if (browser.length) granted.browser = browser;
  const credentials = [...selected]
    .filter((key) => key.startsWith(CREDENTIAL_PERMISSION_PREFIX))
    .map((key) => key.slice(CREDENTIAL_PERMISSION_PREFIX.length));
  if (credentials.length) granted.credentials = credentials;
  const tools = [...selected]
    .filter((key) => key.startsWith(TOOL_PERMISSION_PREFIX))
    .map((key) => key.slice(TOOL_PERMISSION_PREFIX.length));
  if (tools.length) granted.tools = tools;
  const network = [...selected]
    .filter((key) => key.startsWith(NETWORK_PERMISSION_PREFIX))
    .map((key) => key.slice(NETWORK_PERMISSION_PREFIX.length));
  if (network.length) granted.network = network;
  return granted;
}

function permissionItems(requestedPermissions, {
  source = "external",
  previouslyGranted = []
} = {}) {
  const previous = new Set(previouslyGranted);
  return keysForPermissions(requestedPermissions).map((key) => {
    const definition = permissionDefinition(key);
    return {
      ...definition,
      defaultGranted: definition.required || source !== "external" || previous.has(key)
    };
  });
}

function permissionDiff(previousPermissions = {}, nextPermissions = {}) {
  const previous = new Set(keysForPermissions(previousPermissions));
  const next = new Set(keysForPermissions(nextPermissions));
  return {
    added: [...next].filter((key) => !previous.has(key)),
    removed: [...previous].filter((key) => !next.has(key)),
    unchanged: [...next].filter((key) => previous.has(key))
  };
}

class PermissionService {
  constructor(dataRoot) {
    this.filePath = path.join(path.resolve(dataRoot), "permissions.json");
    this.state = { formatVersion: 1, grants: {} };
  }

  async init() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      if (parsed?.formatVersion !== 1 || !parsed.grants || typeof parsed.grants !== "object") {
        throw new Error("权限账本格式无效");
      }
      this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
    return this;
  }

  async save() {
    const temporaryPath = `${this.filePath}.tmp`;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await fsp.rename(temporaryPath, this.filePath);
  }

  getEntry(roomId) {
    return clone(this.state.grants[roomId] ?? null);
  }

  getGrantedPermissions(roomId) {
    return this.getEntry(roomId)?.permissions ?? {};
  }

  getGrantedKeys(roomId) {
    return keysForPermissions(this.getGrantedPermissions(roomId));
  }

  async setGrant({ roomId, version, requestedPermissions, selectedKeys, source, trust, publisher }) {
    if (typeof roomId !== "string" || !ROOM_ID_PATTERN.test(roomId)) throw new Error("房间 ID 无效");
    const permissions = permissionsForKeys(requestedPermissions, selectedKeys);
    this.state.grants[roomId] = {
      roomId,
      version,
      source,
      trust,
      publisher: clone(publisher ?? null),
      permissions,
      updatedAt: new Date().toISOString()
    };
    await this.save();
    return this.getEntry(roomId);
  }

  async restoreEntry(roomId, entry) {
    if (entry) this.state.grants[roomId] = clone(entry);
    else delete this.state.grants[roomId];
    await this.save();
  }

  async remove(roomId) {
    if (!this.state.grants[roomId]) return false;
    delete this.state.grants[roomId];
    await this.save();
    return true;
  }

  has(roomId, domain, value) {
    const permissions = this.getGrantedPermissions(roomId);
    if (domain === "database") return permissions.database === "private";
    if (domain === "files") return Array.isArray(permissions.files) && permissions.files.includes(value);
    if (domain === "ai") return Boolean(permissions.ai?.roles?.includes(value) || (!value && permissions.ai?.roles?.length));
    if (domain === "compute") return Array.isArray(permissions.compute) && (!value || permissions.compute.includes(value));
    if (domain === "browser") return Array.isArray(permissions.browser) && (!value || permissions.browser.includes(value));
    if (domain === "credentials") return Array.isArray(permissions.credentials) && (!value || permissions.credentials.includes(value));
    if (domain === "tools") return Array.isArray(permissions.tools) && (!value || permissions.tools.includes(value));
    if (domain === "network") {
      if (!Array.isArray(permissions.network)) return false;
      if (!value) return permissions.network.length > 0;
      return permissions.network.includes(normalizeNetworkOrigin(value));
    }
    return false;
  }
}

module.exports = {
  PERMISSION_DEFINITIONS,
  credentialPermissionKey,
  PermissionService,
  keysForPermissions,
  networkPermissionKey,
  permissionDefinition,
  permissionDiff,
  permissionItems,
  permissionsForKeys,
  toolPermissionKey
};
