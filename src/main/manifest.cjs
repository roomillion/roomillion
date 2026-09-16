"use strict";

const { ROOM_MODULE_CATALOG, getRoomModule } = require("./room-module-catalog.cjs");

const ROOM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(`${field} 必须是对象`);
  }
}

function assertString(value, field, maxLength = 160) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ManifestError(`${field} 必须是 1-${maxLength} 个字符的字符串`);
  }
}

function validateRelativePackagePath(value, field) {
  assertString(value, field, 300);
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    segments.some((segment) =>
      segment === ".." ||
      segment === "." ||
      segment === "" ||
      segment.toLowerCase() === ".git" ||
      /[<>:"|?*\u0000-\u001f]/.test(segment) ||
      /[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
    )
  ) {
    throw new ManifestError(`${field} 不是安全的包内相对路径`);
  }
  return value;
}

function normalizeNetworkOrigin(value) {
  assertString(value, "permissions.network[]", 240);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ManifestError(`联网服务源无效：${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new ManifestError("联网服务源只支持 HTTP 或 HTTPS");
  if (parsed.username || parsed.password) throw new ManifestError("联网服务源不能包含用户名或密码");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ManifestError("联网权限必须声明服务源，例如 https://api.example.com，不能包含路径、查询或片段");
  }
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") throw new ManifestError("联网服务源不能使用监听通配地址");
  return parsed.origin;
}

function validatePermissions(value) {
  assertPlainObject(value, "permissions");
  const allowedKeys = new Set(["database", "files", "ai", "network", "browser", "compute", "tools", "credentials"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new ManifestError(`不支持的权限字段：${key}`);
    }
  }

  if (value.database !== undefined && value.database !== "private") {
    throw new ManifestError("MVP 只支持 private 数据库权限");
  }

  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) throw new ManifestError("permissions.files 必须是数组");
    const allowedFilePermissions = new Set(["pick", "pickMany", "directoryRead", "directoryWrite", "export", "largeText"]);
    for (const permission of value.files) {
      if (!allowedFilePermissions.has(permission)) {
        throw new ManifestError(`不支持的文件权限：${permission}`);
      }
    }
  }

  if (value.network !== undefined) {
    if (!Array.isArray(value.network)) throw new ManifestError("permissions.network 必须是数组");
    const origins = value.network.map(normalizeNetworkOrigin);
    if (new Set(origins).size !== origins.length) throw new ManifestError("permissions.network 不能包含重复服务源");
  }

  if (value.browser !== undefined) {
    if (!Array.isArray(value.browser)) throw new ManifestError("permissions.browser 必须是数组");
    const allowedBrowserPermissions = new Set(["navigate", "download"]);
    for (const permission of value.browser) {
      if (!allowedBrowserPermissions.has(permission)) {
        throw new ManifestError(`不支持的浏览器权限：${permission}`);
      }
    }
    if (value.browser.includes("download") && !value.browser.includes("navigate")) {
      throw new ManifestError("浏览器下载权限需要同时声明 navigate");
    }
  }

  if (value.credentials !== undefined) {
    if (!Array.isArray(value.credentials) || value.credentials.length > 32) throw new ManifestError("permissions.credentials 必须是最多 32 项的数组");
    for (const alias of value.credentials) if (typeof alias !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(alias)) throw new ManifestError(`凭据别名无效：${alias}`);
    if (new Set(value.credentials).size !== value.credentials.length) throw new ManifestError("permissions.credentials 不能包含重复别名");
  }

  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 64) throw new ManifestError("permissions.tools 必须是最多 64 项的数组");
    for (const toolId of value.tools) if (typeof toolId !== "string" || !/^[a-z][a-z0-9.-]{1,79}@\d+$/.test(toolId)) throw new ManifestError(`房间工具 ID 无效：${toolId}`);
    if (new Set(value.tools).size !== value.tools.length) throw new ManifestError("permissions.tools 不能包含重复工具");
  }

  if (value.compute !== undefined) {
    if (!Array.isArray(value.compute)) throw new ManifestError("permissions.compute 必须是数组");
    for (const permission of value.compute) if (permission !== "worker") throw new ManifestError(`不支持的计算权限：${permission}`);
  }

  if (value.ai !== undefined) {
    assertPlainObject(value.ai, "permissions.ai");
    if (!Array.isArray(value.ai.roles) || value.ai.roles.length === 0) {
      throw new ManifestError("permissions.ai.roles 必须是非空数组");
    }
    const allowedRoles = new Set(["general", "coding", "vision"]);
    for (const role of value.ai.roles) {
      if (!allowedRoles.has(role)) throw new ManifestError(`不支持的 AI 角色：${role}`);
    }
    if (value.ai.slots !== undefined) {
      assertPlainObject(value.ai.slots, "permissions.ai.slots");
      if (Object.keys(value.ai.slots).length > 16) throw new ManifestError("permissions.ai.slots 最多包含 16 项");
      for (const [slotName, slot] of Object.entries(value.ai.slots)) {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(slotName)) throw new ManifestError(`AI 槽位名称无效：${slotName}`);
        assertPlainObject(slot, `permissions.ai.slots.${slotName}`);
        if (!allowedRoles.has(slot.role) || !value.ai.roles.includes(slot.role)) throw new ManifestError(`AI 槽位 ${slotName} 的角色未声明`);
        if (slot.requiresImages !== undefined && typeof slot.requiresImages !== "boolean") throw new ManifestError(`AI 槽位 ${slotName} 的 requiresImages 无效`);
        if (slot.minimumContextWindow !== undefined && (!Number.isSafeInteger(slot.minimumContextWindow) || slot.minimumContextWindow < 0 || slot.minimumContextWindow > 10_000_000)) throw new ManifestError(`AI 槽位 ${slotName} 的 minimumContextWindow 无效`);
      }
    }
  }
  return {
    ...value,
    ...(value.files === undefined ? {} : { files: [...new Set(value.files)] }),
    ...(value.browser === undefined ? {} : { browser: [...new Set(value.browser)] }),
    ...(value.network === undefined ? {} : { network: value.network.map(normalizeNetworkOrigin) }),
    ...(value.ai === undefined ? {} : { ai: { ...value.ai, roles: [...new Set(value.ai.roles)], ...(value.ai.slots ? { slots: structuredClone(value.ai.slots) } : {}) } }),
    ...(value.compute === undefined ? {} : { compute: [...new Set(value.compute)] }),
    ...(value.tools === undefined ? {} : { tools: [...value.tools] }),
    ...(value.credentials === undefined ? {} : { credentials: [...value.credentials] })
  };
}

function validateSharing(value) {
  if (value === undefined) return undefined;
  assertPlainObject(value, "sharing");
  const allowedKeys = new Set(["allowAiModification"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new ManifestError(`不支持的分享选项字段：${key}`);
  }
  if (value.allowAiModification !== undefined && typeof value.allowAiModification !== "boolean") {
    throw new ManifestError("sharing.allowAiModification 必须是布尔值");
  }
  return Object.freeze({ allowAiModification: value.allowAiModification === true });
}

function validateEmbeddedDependencies(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ManifestError("embeddedDependencies 必须是数组");
  const dependencyIds = new Set();
  const declaredFiles = new Set();
  return value.map((dependency, index) => {
    assertPlainObject(dependency, `embeddedDependencies[${index}]`);
    assertString(dependency.id, `embeddedDependencies[${index}].id`, 64);
    if (!ROOM_ID_PATTERN.test(dependency.id)) throw new ManifestError(`额外依赖 ID 无效：${dependency.id}`);
    if (dependencyIds.has(dependency.id)) throw new ManifestError(`额外依赖 ID 重复：${dependency.id}`);
    dependencyIds.add(dependency.id);

    assertString(dependency.package, `embeddedDependencies[${index}].package`, 120);
    if (!PACKAGE_NAME_PATTERN.test(dependency.package)) throw new ManifestError(`额外依赖包名无效：${dependency.package}`);
    assertString(dependency.version, `embeddedDependencies[${index}].version`, 80);
    if (!VERSION_PATTERN.test(dependency.version)) throw new ManifestError(`额外依赖必须固定精确版本：${dependency.package}`);
    assertString(dependency.license, `embeddedDependencies[${index}].license`, 100);
    if (/[\u0000-\u001f]/.test(dependency.license)) throw new ManifestError(`额外依赖许可证无效：${dependency.package}`);
    assertString(dependency.source, `embeddedDependencies[${index}].source`, 300);
    if (/[\u0000-\u001f]/.test(dependency.source)) throw new ManifestError(`额外依赖来源无效：${dependency.package}`);

    const expectedRoot = `embedded/${dependency.id}`;
    validateRelativePackagePath(dependency.root, `embeddedDependencies[${index}].root`);
    if (dependency.root !== expectedRoot) throw new ManifestError(`额外依赖必须位于 ${expectedRoot}`);
    validateRelativePackagePath(dependency.licenseFile, `embeddedDependencies[${index}].licenseFile`);
    if (!dependency.licenseFile.startsWith(`${expectedRoot}/`)) {
      throw new ManifestError(`额外依赖许可证文件必须位于 ${expectedRoot}`);
    }
    if (!Array.isArray(dependency.files) || dependency.files.length === 0) {
      throw new ManifestError(`额外依赖 ${dependency.package} 必须声明文件`);
    }
    const files = dependency.files.map((file, fileIndex) => {
      validateRelativePackagePath(file, `embeddedDependencies[${index}].files[${fileIndex}]`);
      if (!file.startsWith(`${expectedRoot}/`)) throw new ManifestError(`额外依赖文件必须位于 ${expectedRoot}`);
      if (file.split("/").some((segment) => segment.toLowerCase() === "node_modules")) {
        throw new ManifestError("房间不得携带 node_modules 目录，只能携带实际使用的浏览器资源");
      }
      if (declaredFiles.has(file)) throw new ManifestError(`额外依赖文件重复声明：${file}`);
      declaredFiles.add(file);
      return file;
    });
    if (!files.includes(dependency.licenseFile)) throw new ManifestError(`额外依赖 ${dependency.package} 未登记许可证文件`);
    if (!Array.isArray(dependency.entrypoints) || dependency.entrypoints.length === 0) {
      throw new ManifestError(`额外依赖 ${dependency.package} 必须声明入口资源`);
    }
    const entrypoints = dependency.entrypoints.map((entrypoint, entryIndex) => {
      validateRelativePackagePath(entrypoint, `embeddedDependencies[${index}].entrypoints[${entryIndex}]`);
      if (!files.includes(entrypoint)) throw new ManifestError(`额外依赖入口未列入 files：${entrypoint}`);
      if (entrypoint === dependency.licenseFile) throw new ManifestError("许可证文件不能作为依赖入口");
      return entrypoint;
    });
    if (new Set(entrypoints).size !== entrypoints.length) throw new ManifestError(`额外依赖入口重复：${dependency.package}`);
    return Object.freeze({ ...dependency, files: Object.freeze(files), entrypoints: Object.freeze(entrypoints) });
  });
}

function validateManifest(manifest) {
  assertPlainObject(manifest, "manifest");
  assertString(manifest.formatVersion, "formatVersion", 20);
  if (manifest.formatVersion !== "0.1") {
    throw new ManifestError(`不支持的房间格式版本：${manifest.formatVersion}`);
  }

  assertString(manifest.id, "id", 64);
  if (!ROOM_ID_PATTERN.test(manifest.id)) {
    throw new ManifestError("id 只能包含小写字母、数字、点和连字符");
  }

  assertString(manifest.name, "name", 80);
  assertString(manifest.version, "version", 80);
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new ManifestError("version 必须使用语义化版本，例如 1.0.0");
  }

  assertPlainObject(manifest.runtime, "runtime");
  assertString(manifest.runtime.roomSdk, "runtime.roomSdk", 20);
  if (manifest.runtime.roomSdk !== "1") {
    throw new ManifestError(`当前工作台不支持 Room SDK ${manifest.runtime.roomSdk}`);
  }
  assertString(manifest.runtime.minimumWorkbench, "runtime.minimumWorkbench", 40);
  require("./workbench-compatibility.cjs").parseVersion(manifest.runtime.minimumWorkbench);

  validateRelativePackagePath(manifest.entry, "entry");
  if (!manifest.entry.startsWith("app/")) {
    throw new ManifestError("entry 必须位于 app/ 目录");
  }

  let icon;
  if (manifest.icon !== undefined) {
    validateRelativePackagePath(manifest.icon, "icon");
    if (!manifest.icon.startsWith("assets/") || !/\.(?:svg|png|jpe?g|webp)$/i.test(manifest.icon)) {
      throw new ManifestError("icon 必须是 assets/ 下的 SVG、PNG、JPEG 或 WebP 文件");
    }
    icon = manifest.icon;
  }

  const permissions = validatePermissions(manifest.permissions ?? {});

  let publisher;
  if (manifest.publisher !== undefined) {
    assertPlainObject(manifest.publisher, "publisher");
    assertString(manifest.publisher.id, "publisher.id", 100);
    assertString(manifest.publisher.name, "publisher.name", 100);
    if (!ROOM_ID_PATTERN.test(manifest.publisher.id)) {
      throw new ManifestError("publisher.id 只能包含小写字母、数字、点和连字符");
    }
    publisher = { id: manifest.publisher.id, name: manifest.publisher.name };
  }

  if (manifest.hostModules !== undefined) {
    if (!Array.isArray(manifest.hostModules)) throw new ManifestError("hostModules 必须是数组");
    if (manifest.hostModules.length > ROOM_MODULE_CATALOG.length) {
      throw new ManifestError(`hostModules 最多声明 ${ROOM_MODULE_CATALOG.length} 个模块`);
    }
    const seenModules = new Set();
    for (const moduleName of manifest.hostModules) {
      assertString(moduleName, "hostModules[]", 100);
      if (seenModules.has(moduleName)) throw new ManifestError(`hostModules 存在重复模块：${moduleName}`);
      seenModules.add(moduleName);
      if (!getRoomModule(moduleName)) throw new ManifestError(`不支持的宿主模块：${moduleName}`);
    }
    for (const moduleName of seenModules) {
      const module = getRoomModule(moduleName);
      for (const dependency of module.requires) {
        if (!seenModules.has(dependency)) {
          throw new ManifestError(`${moduleName} 需要同时声明 ${dependency}`);
        }
      }
    }
  }

  const embeddedDependencies = validateEmbeddedDependencies(manifest.embeddedDependencies);

  const sharing = validateSharing(manifest.sharing);

  return Object.freeze({
    ...manifest,
    icon,
    publisher,
    permissions,
    sharing,
    hostModules: Object.freeze([...(manifest.hostModules ?? [])]),
    embeddedDependencies: Object.freeze(embeddedDependencies)
  });
}

module.exports = {
  ManifestError,
  ROOM_ID_PATTERN,
  VERSION_PATTERN,
  normalizeNetworkOrigin,
  validateManifest,
  validateEmbeddedDependencies,
  validateRelativePackagePath,
  validateSharing
};
