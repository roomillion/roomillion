"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOM_ID_PATTERN } = require("./manifest.cjs");
const { assertWorkbenchCompatible } = require("./workbench-compatibility.cjs");
const { extractAndValidate, packDirectory } = require("./room-package.cjs");
const {
  PermissionService,
  keysForPermissions,
  permissionDiff,
  permissionItems
} = require("./permission-service.cjs");
const { isReviewedEmbeddedLicense } = require("./room-dependency-policy.cjs");

const IMPORT_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const IMPORT_TTL_MS = 15 * 60 * 1000;
const ALLOWED_SOURCES = new Set(["external", "builtin", "local-generated", "legacy-local"]);

function assertRoomId(roomId) {
  if (typeof roomId !== "string" || !ROOM_ID_PATTERN.test(roomId)) {
    throw new Error("房间 ID 无效");
  }
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeSource(source) {
  if (!ALLOWED_SOURCES.has(source)) throw new Error("房间来源无效");
  return source;
}

function trustForSource(source, signatureStatus) {
  if (source === "builtin") return "builtin";
  if (source === "local-generated" || source === "legacy-local") return "local";
  if (signatureStatus === "unverified") return "unverified-signature";
  return "unknown";
}

function isRoomAiModifiable(room) {
  return Boolean(room) && (room.source === "local-generated" || room.allowAiModification === true);
}

function compareVersions(previous, next) {
  if (!previous) return "install";
  if (previous === next) return "same";
  const parse = (value) => value.split("-", 1)[0].split(".").map(Number);
  const left = parse(previous);
  const right = parse(next);
  for (let index = 0; index < 3; index += 1) {
    if (right[index] > left[index]) return "upgrade";
    if (right[index] < left[index]) return "downgrade";
  }
  return next.localeCompare(previous, "en", { numeric: true }) > 0 ? "upgrade" : "downgrade";
}

function riskLevel(risks) {
  if (risks.some((risk) => risk.level === "high")) return "high";
  if (risks.some((risk) => risk.level === "medium")) return "medium";
  return "low";
}

class RoomStore {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.roomsRoot = path.join(this.dataRoot, "rooms");
    this.tempRoot = path.join(this.dataRoot, "tmp");
    this.registryPath = path.join(this.dataRoot, "registry.json");
    this.registry = { rooms: {} };
    this.permissions = new PermissionService(this.dataRoot);
    this.pendingImports = new Map();
  }

  async init() {
    await fsp.mkdir(this.roomsRoot, { recursive: true });
    await fsp.mkdir(this.tempRoot, { recursive: true });
    try {
      this.registry = JSON.parse(await fsp.readFile(this.registryPath, "utf8"));
      if (!this.registry || typeof this.registry !== "object" || !this.registry.rooms) throw new Error("bad registry");
    } catch (error) {
      if (error.code !== "ENOENT" && error.message !== "bad registry") throw error;
      this.registry = { rooms: {} };
      await this.saveRegistry();
    }
    await this.permissions.init();
    await this.migrateLegacyPermissions();
    await this.cleanupStaleImportDirectories();
    return this;
  }

  async saveRegistry() {
    const temporaryPath = `${this.registryPath}.tmp`;
    await fsp.writeFile(temporaryPath, `${JSON.stringify(this.registry, null, 2)}\n`, "utf8");
    await fsp.rename(temporaryPath, this.registryPath);
  }

  async migrateLegacyPermissions() {
    for (const room of Object.values(this.registry.rooms)) {
      if (this.permissions.getEntry(room.id)) continue;
      await this.permissions.setGrant({
        roomId: room.id,
        version: room.version,
        requestedPermissions: room.permissions,
        selectedKeys: keysForPermissions(room.permissions),
        source: room.source ?? "legacy-local",
        trust: room.trust ?? "local",
        publisher: room.publisher ?? null
      });
    }
  }

  async cleanupStaleImportDirectories() {
    const entries = await fsp.readdir(this.tempRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^room-import-[A-Za-z0-9_-]+$/.test(entry.name)) {
        await fsp.rm(path.join(this.tempRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  decorateRoom(room) {
    if (!room) return null;
    const grant = this.permissions.getEntry(room.id);
    return {
      ...clone(room),
      hostModules: clone(room.hostModules ?? []),
      embeddedDependencies: clone(room.embeddedDependencies ?? []),
      requestedPermissions: clone(room.permissions ?? {}),
      grantedPermissions: grant?.permissions ?? {},
      source: grant?.source ?? room.source ?? "unknown",
      trust: grant?.trust ?? room.trust ?? "unknown",
      publisher: grant?.publisher ?? room.publisher ?? null
    };
  }

  listRooms() {
    return Object.values(this.registry.rooms)
      .map((room) => this.decorateRoom(room))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  getRoom(roomId) {
    assertRoomId(roomId);
    return this.decorateRoom(this.registry.rooms[roomId] ?? null);
  }

  getStoredRoom(roomId) {
    assertRoomId(roomId);
    return this.registry.rooms[roomId] ?? null;
  }

  hasPermission(roomId, domain, value) {
    assertRoomId(roomId);
    return this.permissions.has(roomId, domain, value);
  }

  getPermissionDetails(roomId) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    const grantedKeys = this.permissions.getGrantedKeys(roomId);
    const items = permissionItems(room.permissions, { source: room.source, previouslyGranted: grantedKeys })
      .map((item) => ({ ...item, granted: grantedKeys.includes(item.key) }));
    return {
      room,
      requestedKeys: items.map((item) => item.key),
      grantedKeys: [...grantedKeys],
      items
    };
  }

  async setRoomPermissions(roomId, selectedKeys) {
    const room = this.getStoredRoom(roomId);
    if (!room) throw new Error("房间不存在");
    const previous = this.permissions.getEntry(roomId);
    await this.permissions.setGrant({
      roomId,
      version: room.version,
      requestedPermissions: room.permissions,
      selectedKeys,
      source: previous?.source ?? room.source ?? "external",
      trust: previous?.trust ?? room.trust ?? "unknown",
      publisher: previous?.publisher ?? room.publisher ?? null
    });
    return this.getPermissionDetails(roomId);
  }

  getRoomRoot(roomId) {
    assertRoomId(roomId);
    return path.join(this.roomsRoot, roomId);
  }

  getProgramRoot(roomId) {
    return path.join(this.getRoomRoot(roomId), "program");
  }

  async assertRoomCompatible(roomId) {
    const manifest = JSON.parse(await fsp.readFile(path.join(this.getProgramRoot(roomId), "manifest.json"), "utf8"));
    assertWorkbenchCompatible(manifest);
  }

  getDataRoot(roomId) {
    return path.join(this.getRoomRoot(roomId), "data");
  }

  async resolveProgramFile(roomId, relativePath) {
    assertRoomId(roomId);
    const root = path.resolve(this.getProgramRoot(roomId));
    const target = path.resolve(root, ...relativePath.split("/"));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("房间资源路径越界");
    return target;
  }

  buildInspection(pending) {
    const { manifest, packageInfo, source, token } = pending;
    const existing = this.getStoredRoom(manifest.id);
    const previouslyGranted = this.permissions.getGrantedKeys(manifest.id);
    const permissions = permissionItems(manifest.permissions, { source, previouslyGranted });
    const diff = permissionDiff(existing?.permissions, manifest.permissions);
    const versionChange = compareVersions(existing?.version, manifest.version);
    const trust = trustForSource(source, packageInfo.signature.status);
    const risks = [];
    if (trust === "unknown") {
      risks.push({ level: "medium", code: "unknown-source", message: "房间来源未知且没有可验证签名。" });
    }
    if (trust === "unverified-signature") {
      risks.push({ level: "high", code: "unverified-signature", message: "房间包含签名文件，但当前工作台无法确认发布者身份。" });
    }
    if (manifest.permissions.ai?.roles?.length) {
      risks.push({ level: "high", code: "sensitive-permission", message: "房间申请把内容发送到已配置的 AI 服务。" });
    }
    if (manifest.permissions.network?.length) {
      risks.push({
        level: "high",
        code: "network-permission",
        message: `房间申请连接 ${manifest.permissions.network.length} 个指定网络服务；即使授权，也只有主工作台联网总开关开启时才能访问。`
      });
    }
    if (manifest.permissions.browser?.includes("navigate")) {
      risks.push({
        level: "high",
        code: "browser-navigation-permission",
        message: "房间申请浏览任意网站；网页由工作台隔离托管，并且只有主工作台联网总开关开启时才能访问。"
      });
    }
    if (manifest.permissions.browser?.includes("download")) {
      risks.push({
        level: "high",
        code: "browser-download-permission",
        message: "房间申请从网站下载文件；每次下载仍会显示系统保存窗口，由你确认保存位置。"
      });
    }
    if (diff.added.length && existing) {
      risks.push({ level: "medium", code: "new-permissions", message: `新版本新增 ${diff.added.length} 项权限。` });
    }
    if (versionChange === "downgrade") {
      risks.push({ level: "medium", code: "downgrade", message: "待导入版本低于当前已安装版本。" });
    }
    if (packageInfo.embeddedDependencies.length) {
      risks.push({
        level: "medium",
        code: "embedded-dependencies",
        message: `房间自带 ${packageInfo.embeddedDependencies.length} 个工作台目录外依赖；这些文件会随房间安装并在沙箱内离线运行。`
      });
      const unreviewed = packageInfo.embeddedDependencies.filter((dependency) => !isReviewedEmbeddedLicense(dependency.license));
      if (unreviewed.length) {
        risks.push({
          level: "high",
          code: "unreviewed-dependency-license",
          message: `有 ${unreviewed.length} 个额外依赖使用工作台未预审许可证，请在组织内分发前复核。`
        });
      }
      const replaceable = packageInfo.embeddedDependencies.filter((dependency) => dependency.hostModuleEquivalent);
      if (replaceable.length) {
        risks.push({
          level: "medium",
          code: "replaceable-embedded-dependencies",
          message: `有 ${replaceable.length} 个随房间依赖已可改用工作台共享模块；本次仍按旧房间内容运行，重新开发时建议迁移。`
        });
      }
    }
    if (manifest.sharing?.allowAiModification === true) {
      risks.push({ level: "low", code: "ai-modification-allowed", message: "发布者允许接收方使用 AI 继续修改此房间。" });
    }
    if (!risks.length) risks.push({ level: "low", code: "standard", message: "包结构、完整性和跨平台房间合同检查已通过。" });

    return {
      token,
      room: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        icon: manifest.icon ?? null,
        iconDataUrl: packageInfo.icon?.dataUrl ?? null,
        publisher: manifest.publisher ?? null,
        runtime: manifest.runtime,
        hostModules: [...manifest.hostModules],
        embeddedDependencies: packageInfo.embeddedDependencies,
        allowAiModification: manifest.sharing?.allowAiModification === true
      },
      existing: existing ? { id: existing.id, name: existing.name, version: existing.version } : null,
      versionChange,
      source,
      trust,
      signature: packageInfo.signature,
      package: {
        sha256: packageInfo.sha256,
        bytes: packageInfo.packageBytes,
        unpackedBytes: packageInfo.unpackedBytes,
        entryCount: packageInfo.entryCount,
        verifiedFiles: packageInfo.integrity.fileCount,
        portability: packageInfo.portability,
        embeddedDependencyCount: packageInfo.embeddedDependencies.length,
        embeddedDependencyBytes: packageInfo.embeddedDependencies.reduce((sum, dependency) => sum + dependency.bytes, 0)
      },
      permissionDiff: diff,
      permissions,
      defaultSelectedKeys: permissions.filter((item) => item.defaultGranted).map((item) => item.key),
      risks,
      riskLevel: riskLevel(risks)
    };
  }

  async discardExpiredImports() {
    const now = Date.now();
    for (const [token, pending] of this.pendingImports) {
      if (now - pending.createdAt > IMPORT_TTL_MS) await this.cancelImport(token);
    }
  }

  async inspectPackage(packagePath, { source = "external" } = {}) {
    normalizeSource(source);
    await this.discardExpiredImports();
    const extracted = await extractAndValidate(packagePath, this.tempRoot);
    try { assertWorkbenchCompatible(extracted.manifest); }
    catch (error) { await fsp.rm(extracted.stagingPath, { recursive: true, force: true }); throw error; }
    const token = crypto.randomBytes(16).toString("hex");
    const pending = { ...extracted, token, source, createdAt: Date.now() };
    this.pendingImports.set(token, pending);
    return this.buildInspection(pending);
  }

  async cancelImport(token) {
    if (typeof token !== "string" || !IMPORT_TOKEN_PATTERN.test(token)) return false;
    const pending = this.pendingImports.get(token);
    if (!pending) return false;
    this.pendingImports.delete(token);
    await fsp.rm(pending.stagingPath, { recursive: true, force: true });
    return true;
  }

  async installValidated(pending) {
    const { manifest, stagingPath, source, packageInfo } = pending;
    assertWorkbenchCompatible(manifest);
    const roomRoot = this.getRoomRoot(manifest.id);
    const programRoot = path.join(roomRoot, "program");
    const backupRoot = path.join(roomRoot, "program.previous");
    await fsp.mkdir(roomRoot, { recursive: true });
    await fsp.mkdir(path.join(roomRoot, "data", "files"), { recursive: true });
    await fsp.rm(backupRoot, { recursive: true, force: true });

    const previousRegistryRoom = clone(this.registry.rooms[manifest.id]);
    let hadPrevious = false;
    let stagedProgramInstalled = false;
    if (await pathExists(programRoot)) {
      await fsp.rename(programRoot, backupRoot);
      hadPrevious = true;
    }

    try {
      await fsp.rename(stagingPath, programRoot);
      stagedProgramInstalled = true;
      const now = new Date().toISOString();
      this.registry.rooms[manifest.id] = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        icon: manifest.icon ?? null,
        entry: manifest.entry,
        runtime: clone(manifest.runtime),
        permissions: clone(manifest.permissions),
        hostModules: clone(manifest.hostModules),
        embeddedDependencies: clone(packageInfo.embeddedDependencies),
        publisher: clone(manifest.publisher ?? null),
        source,
        trust: trustForSource(source, packageInfo.signature.status),
        allowAiModification: manifest.sharing?.allowAiModification === true,
        packageSha256: packageInfo.sha256,
        installedAt: previousRegistryRoom?.installedAt ?? now,
        updatedAt: now
      };
      await this.saveRegistry();
      await fsp.rm(backupRoot, { recursive: true, force: true });
      return this.getRoom(manifest.id);
    } catch (error) {
      if (previousRegistryRoom) this.registry.rooms[manifest.id] = previousRegistryRoom;
      else delete this.registry.rooms[manifest.id];
      try { await this.saveRegistry(); } catch {}
      if (stagedProgramInstalled) await fsp.rm(programRoot, { recursive: true, force: true });
      if (hadPrevious && await pathExists(backupRoot)) await fsp.rename(backupRoot, programRoot);
      throw error;
    }
  }

  async commitImport(token, selectedKeys) {
    if (typeof token !== "string" || !IMPORT_TOKEN_PATTERN.test(token)) throw new Error("导入确认令牌无效");
    const pending = this.pendingImports.get(token);
    if (!pending) throw new Error("导入预检已过期，请重新选择房间包");
    const previousGrant = this.permissions.getEntry(pending.manifest.id);
    const trust = trustForSource(pending.source, pending.packageInfo.signature.status);
    try {
      await this.permissions.setGrant({
        roomId: pending.manifest.id,
        version: pending.manifest.version,
        requestedPermissions: pending.manifest.permissions,
        selectedKeys,
        source: pending.source,
        trust,
        publisher: pending.manifest.publisher ?? null
      });
      const room = await this.installValidated(pending);
      this.pendingImports.delete(token);
      return room;
    } catch (error) {
      await this.permissions.restoreEntry(pending.manifest.id, previousGrant);
      this.pendingImports.delete(token);
      await fsp.rm(pending.stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  async installPackage(packagePath, { source = "local-generated", selectedKeys } = {}) {
    normalizeSource(source);
    const extracted = await extractAndValidate(packagePath, this.tempRoot);
    const pending = { ...extracted, source, createdAt: Date.now() };
    const previousGrant = this.permissions.getEntry(extracted.manifest.id);
    try {
      assertWorkbenchCompatible(extracted.manifest);
      await this.permissions.setGrant({
        roomId: extracted.manifest.id,
        version: extracted.manifest.version,
        requestedPermissions: extracted.manifest.permissions,
        selectedKeys: selectedKeys ?? keysForPermissions(extracted.manifest.permissions),
        source,
        trust: trustForSource(source, extracted.packageInfo.signature.status),
        publisher: extracted.manifest.publisher ?? null
      });
      return await this.installValidated(pending);
    } catch (error) {
      await this.permissions.restoreEntry(extracted.manifest.id, previousGrant);
      await fsp.rm(extracted.stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  async exportRoom(roomId, destinationPath, { allowAiModification } = {}) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    if (allowAiModification === undefined) {
      await packDirectory(this.getProgramRoot(roomId), destinationPath, { enforceCurrentDependencyPolicy: false });
      return destinationPath;
    }
    if (typeof allowAiModification !== "boolean") throw new Error("房间导出分享选项无效");
    const stagingPath = await fsp.mkdtemp(path.join(this.tempRoot, "room-export-"));
    try {
      await fsp.cp(this.getProgramRoot(roomId), stagingPath, { recursive: true });
      const manifestPath = path.join(stagingPath, "manifest.json");
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      if (allowAiModification) {
        manifest.sharing = {
          ...(manifest.sharing && typeof manifest.sharing === "object" && !Array.isArray(manifest.sharing) ? manifest.sharing : {}),
          allowAiModification: true
        };
      } else if (manifest.sharing && typeof manifest.sharing === "object" && !Array.isArray(manifest.sharing)) {
        const rest = { ...manifest.sharing };
        delete rest.allowAiModification;
        if (Object.keys(rest).length) manifest.sharing = rest;
        else delete manifest.sharing;
      }
      await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await packDirectory(stagingPath, destinationPath, { enforceCurrentDependencyPolicy: false });
      return destinationPath;
    } finally {
      await fsp.rm(stagingPath, { recursive: true, force: true });
    }
  }

  async deleteRoom(roomId, { deleteData = false } = {}) {
    const room = this.getRoom(roomId);
    if (!room) return false;
    const roomRoot = this.getRoomRoot(roomId);
    await fsp.rm(path.join(roomRoot, "program"), { recursive: true, force: true });
    if (deleteData) await fsp.rm(roomRoot, { recursive: true, force: true });
    delete this.registry.rooms[roomId];
    await this.saveRegistry();
    await this.permissions.remove(roomId);
    return true;
  }
}

module.exports = {
  IMPORT_TTL_MS,
  RoomStore,
  assertRoomId,
  compareVersions,
  isRoomAiModifiable,
  pathExists,
  trustForSource
};
