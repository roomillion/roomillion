"use strict";
const { validateRoomAiOptions } = require("./room-ai-options.cjs");

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { dialog, ipcMain } = require("electron");
const { generateRoomFromPrompt, updateGeneratedRoomFromPrompt } = require("./generated-room.cjs");
const { getPublicRoomModuleCatalog } = require("./room-module-catalog.cjs");
const { applyNativeWorkbenchTheme } = require("./workbench-theme.cjs");
const { RoomVectorService } = require("./room-vector-service.cjs");
const { BinaryFileService } = require("./binary-file-service.cjs");
const { RoomFileAccessService } = require("./room-file-access-service.cjs");
const { RoomBlobService } = require("./room-blob-service.cjs");
const { RoomJobService } = require("./room-job-service.cjs");
const { RoomDocumentService } = require("./room-document-service.cjs");
const { RoomToolService } = require("./room-tool-service.cjs");
const { RoomImportLocation } = require("./room-import-location.cjs");
const { buildRoomAgentExport } = require("./room-agent-export.cjs");
const { RoomAiRequests } = require("./room-ai-requests.cjs");

const DEFAULT_BINARY_EXTENSIONS = Object.freeze([
  "pdf", "docx", "xlsx", "xls", "pptx", "zip", "png", "jpg", "jpeg", "webp"
]);
const BINARY_MIME_TYPES = Object.freeze({
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
});

function normalizeBinaryExtensions(options) {
  const requested = options?.extensions;
  if (requested === undefined) return [...DEFAULT_BINARY_EXTENSIONS];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error("二进制文件扩展名列表不能为空");
  }
  const result = requested.map((value) => String(value).trim().toLowerCase().replace(/^\./, ""));
  if (result.some((value) => !/^[a-z0-9]{1,10}$/.test(value))) throw new Error("二进制文件扩展名无效");
  return [...new Set(result)];
}

function binaryBuffer(content) {
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  throw new Error("导出内容必须是 ArrayBuffer 或 Uint8Array");
}

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  return null;
}

function normalizeRoomAiImages(images) {
  if (images === undefined) return [];
  if (!Array.isArray(images)) throw new Error("AI 图片输入必须是数组");
  return images.map((image) => {
    if (!image || typeof image !== "object") throw new Error("AI 图片输入无效");
    const buffer = binaryBuffer(image.data);
    if (buffer.length === 0) throw new Error("AI 图片内容不能为空");
    const mimeType = detectImageMimeType(buffer);
    if (!mimeType || (image.mimeType && image.mimeType !== mimeType)) throw new Error("AI 图片格式或内容无效");
    return { mimeType, data: buffer.toString("base64") };
  });
}

function hasPermission(room, domain, value) {
  const permission = room.grantedPermissions?.[domain];
  if (domain === "database") return permission === "private";
  if (domain === "files") return Array.isArray(permission) && permission.includes(value);
  if (domain === "ai") return Boolean(permission && Array.isArray(permission.roles) && (!value || permission.roles.includes(value)));
  if (domain === "network") return Boolean(Array.isArray(permission) && (!value || permission.includes(value)));
  if (domain === "credentials") return Boolean(Array.isArray(permission) && (!value || permission.includes(value)));
  if (domain === "tools") return Boolean(Array.isArray(permission) && (!value || permission.includes(value)));
  if (domain === "compute") return Boolean(Array.isArray(permission) && (!value || permission.includes(value)));
  if (domain === "browser") return Boolean(Array.isArray(permission) && (!value || permission.includes(value)));
  return false;
}

function registerIpcHandlers({
  mainWindow,
  roomStore,
  database,
  dataBackups,
  gitService,
  diagnostics,
  aiService,
  roomAgent,
  largeText,
  networkService,
  credentialService,
  roomViews,
  roomBrowser,
  agentWindows,
  examplePackages,
  environment,
  storageLocation,
  takePendingRoomImports = () => [],
  dialogApi = dialog,
  fileAccess,
  blobService,
  jobService,
  documentService,
  toolService
}) {
  const importLocation = new RoomImportLocation(roomStore.dataRoot || process.cwd());
  const roomAiRequests = new RoomAiRequests();
  const vectors = new RoomVectorService(database);
  const binaryFiles = new BinaryFileService();
  const directoryFiles = fileAccess || new RoomFileAccessService(roomStore.dataRoot || process.cwd());
  const blobs = blobService || new RoomBlobService(roomStore);
  const jobs = jobService || new RoomJobService(roomStore);
  const documents = documentService || new RoomDocumentService({ resourcesPath: process.resourcesPath, blobService: blobs });
  const roomTools = toolService || new RoomToolService({ documentService: documents, blobService: blobs });
  const declaredModelSlots = (room) => {
    const slots = room?.requestedPermissions?.ai?.slots || room?.permissions?.ai?.slots;
    return slots && typeof slots === "object" && !Array.isArray(slots) ? structuredClone(slots) : {};
  };
  const validateAiSlotProfile = async (room, rawSlot, profileId) => {
    if (rawSlot === undefined || rawSlot === null) return null;
    const slot = String(rawSlot).trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(slot)) throw new Error("模型槽位名称无效");
    const definitions = declaredModelSlots(room);
    const definition = definitions[slot];
    if (Object.keys(definitions).length && !definition) throw new Error(`房间没有声明模型槽位：${slot}`);
    if (!definition) return null;
    if (!hasPermission(room, "ai", definition.role)) throw new Error(`房间没有 ${definition.role} AI 权限`);
    const capabilities = await aiService.getModelCapabilities(profileId);
    if (definition.requiresImages && !capabilities.supportsImages) throw new Error(`模型槽位 ${slot} 需要支持图片的模型`);
    if (definition.minimumContextWindow && (!capabilities.contextWindow || capabilities.contextWindow < definition.minimumContextWindow)) throw new Error(`模型槽位 ${slot} 需要至少 ${definition.minimumContextWindow} Token 上下文`);
    return definition;
  };
  const resolveAiImages = async (room, images) => {
    if (images === undefined) return [];
    if (!Array.isArray(images)) throw new Error("AI 图片输入必须是数组");
    const resolved = [];
    for (const image of images) {
      if (image?.data !== undefined) { resolved.push(...normalizeRoomAiImages([image])); continue; }
      let file;
      if (image?.blobId) file = await blobs.getFile(room.id, String(image.blobId));
      else if (image?.directory?.grantId && image.directory.relativePath) file = await directoryFiles.getFile(room.id, image.directory.grantId, image.directory.relativePath);
      else throw new Error("AI 图片必须提供 data、blobId 或目录文件引用");
      const stats = await fsp.stat(file.path);
      if (stats.size > 64 * 1024 ** 2) throw new Error("单张 AI 图片不能超过 64 MiB");
      const buffer = await fsp.readFile(file.path);
      const mimeType = detectImageMimeType(buffer);
      if (!mimeType) throw new Error("AI 图片格式或内容无效");
      resolved.push({ mimeType, data: buffer.toString("base64") });
    }
    return resolved;
  };
  const exportStreams = new Map();
  const closeExportStreams = async (roomId, { removePartial = true } = {}) => {
    const closing = [];
    for (const [token, stream] of exportStreams) {
      if (stream.roomId !== roomId) continue;
      exportStreams.delete(token);
      closing.push(stream.handle.close().catch(() => {}).then(() => removePartial ? fsp.rm(stream.path, { force: true }).catch(() => {}) : undefined));
    }
    await Promise.all(closing);
  };
  const registeredChannels = [];
  const handle = (channel, listener) => {
    ipcMain.handle(channel, listener);
    registeredChannels.push(channel);
  };
  const requireWorkbench = (event) => {
    const allowed = agentWindows
      ? agentWindows.isWorkbenchSender(event.sender.id)
      : event.sender.id === mainWindow.webContents.id;
    if (!allowed) throw new Error("该操作只能由工作台发起");
  };
  const requireRoom = (event) => {
    const roomId = roomViews.getRoomIdForSender(event.sender.id);
    if (!roomId) throw new Error("无法识别房间调用方");
    const room = roomStore.getRoom(roomId);
    if (!room) throw new Error("房间已被移除");
    return room;
  };
  const notifyRoomsChanged = () => {
    const rooms = roomStore.listRooms();
    const windows = agentWindows ? agentWindows.getWorkbenchWindows() : [mainWindow];
    for (const window of windows) {
      if (!window.isDestroyed()) window.webContents.send("workbench:roomsChanged", rooms);
    }
  };
  const notifyAiModelsChanged = () => {
    for (const view of roomViews.views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.send("room:aiModelsChanged");
    }
    const aiState = {
      activeProfile: aiService.getPublicProfile(),
      profiles: aiService.listPublicProfiles()
    };
    const windows = agentWindows ? agentWindows.getWorkbenchWindows() : [mainWindow];
    for (const window of windows) {
      if (!window.isDestroyed()) window.webContents.send("workbench:aiStateChanged", aiState);
    }
  };
  const notifyNetworkStatusChanged = (onlyRoomId = null) => {
    for (const [roomId, view] of roomViews.views) {
      if (onlyRoomId && roomId !== onlyRoomId) continue;
      const room = roomStore.getRoom(roomId);
      if (room && !view.webContents.isDestroyed()) {
        view.webContents.send("room:networkStatusChanged", networkService.getRoomStatus(room));
      }
    }
  };
  const recordEvent = (type, data) => diagnostics.record(type, data).catch((error) => {
    console.error("记录脱敏诊断事件失败", error);
  });

  handle("workbench:getState", async (event) => {
    requireWorkbench(event);
    return {
      rooms: roomStore.listRooms(),
      provider: aiService.getPublicProfile(),
      aiProfiles: aiService.listPublicProfiles(),
      aiProviders: await aiService.getProviderCatalog(),
      aiCapabilities: { secureStorageAvailable: aiService.isSecureStorageAvailable() },
      networkPolicy: networkService.getPublicState(),
      credentials: credentialService?.list?.() || [],
      roomModules: getPublicRoomModuleCatalog(),
      roomWindows: roomViews.getWindowStates(),
      dataLocation: roomStore.dataRoot,
      storageWarning: storageLocation?.warning || null,
      agentWindow: agentWindows?.getState() ?? { mode: "attached" },
      environment
    };
  });
  handle("workbench:chooseRoomStorageLocation", async (event) => {
    requireWorkbench(event);
    if (!storageLocation) throw new Error("房间位置设置不可用");
    const selected = await dialogApi.showOpenDialog(mainWindow, {
      title: "选择新的房间安装目录（将在其中创建 Roomillion-data）",
      defaultPath: path.dirname(roomStore.dataRoot),
      properties: ["openDirectory", "createDirectory"]
    });
    if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
    return storageLocation.scheduleMove(roomStore.dataRoot, selected.filePaths[0]);
  });
  handle("workbench:setTheme", async (event, themeId) => {
    requireWorkbench(event);
    const workbenchWindow = (agentWindows ? agentWindows.getWorkbenchWindows() : [mainWindow])
      .find((window) => window.webContents?.id === event.sender.id);
    return applyNativeWorkbenchTheme(workbenchWindow, themeId);
  });
  handle("workbench:listCredentials", async (event) => { requireWorkbench(event); return credentialService?.list?.() || []; });
  handle("workbench:saveCredential", async (event, input) => { requireWorkbench(event); if (!credentialService) throw new Error("凭据服务不可用"); return credentialService.set(input); });
  handle("workbench:deleteCredential", async (event, alias) => { requireWorkbench(event); if (!credentialService) throw new Error("凭据服务不可用"); return credentialService.remove(alias); });
  handle("workbench:setRoomNetworkEnabled", async (event, enabled) => {
    requireWorkbench(event);
    const result = await networkService.setRoomNetworkEnabled(enabled);
    notifyNetworkStatusChanged();
    roomBrowser?.handleNetworkPolicyChanged();
    await recordEvent("network.policy", { roomNetworkEnabled: result.roomNetworkEnabled });
    return result;
  });
  handle("workbench:listExamples", async (event) => {
    requireWorkbench(event);
    return Promise.all(examplePackages.map(async ({ packagePath, ...example }) => {
      let inspection;
      try {
        inspection = await roomStore.inspectPackage(packagePath, { source: "builtin" });
        return { ...example, version: inspection.room.version, installedVersion: inspection.existing?.version || null,
          updateAvailable: inspection.versionChange === "upgrade", versionChange: inspection.versionChange,
          modified: Boolean(inspection.existing && roomStore.getRoom(example.roomId)?.source !== "builtin") };
      } finally { if (inspection) await roomStore.cancelImport(inspection.token); }
    }));
  });
  handle("workbench:takePendingRoomImports", async (event) => {
    requireWorkbench(event);
    return takePendingRoomImports();
  });
  handle("workbench:inspectExample", async (event, exampleId) => {
    requireWorkbench(event);
    const example = examplePackages.find(item => item.id === exampleId);
    if (!example) throw new Error("示例房间不存在");
    roomViews.hide();
    return roomStore.inspectPackage(example.packagePath, { source: "builtin" });
  });
  handle("workbench:setViewport", async (event, bounds) => {
    requireWorkbench(event);
    roomViews.setViewport(bounds);
    return true;
  });
  handle("workbench:openRoom", async (event, roomId) => {
    requireWorkbench(event);
    return roomViews.open(roomId);
  });
  handle("workbench:hideRoom", async (event) => {
    requireWorkbench(event);
    roomViews.hide();
    return true;
  });
  handle("workbench:closeRoom", async (event, roomId) => {
    requireWorkbench(event);
    await largeText.closeRoom(roomId);
    binaryFiles.closeRoom(roomId);
    networkService.closeRoom(roomId);
    await closeExportStreams(roomId);
    roomViews.close(roomId);
    return true;
  });
  handle("workbench:detachRoom", async (event, roomId, options = {}) => {
    requireWorkbench(event);
    const result = await roomViews.detach(roomId, {
      force: options?.force === true,
      fromDrag: options?.fromDrag === true
    });
    if (result.detached) recordEvent("room.window-detach", { roomId, reason: options?.fromDrag === true ? "drag" : "button" });
    return result;
  });
  handle("workbench:focusRoomWindow", async (event, roomId) => {
    requireWorkbench(event);
    return roomViews.focusDetached(roomId);
  });
  handle("workbench:focusAgentWindow", async (event) => {
    requireWorkbench(event);
    return agentWindows?.focus() || false;
  });
  handle("workbench:dockRoom", async (event, roomId) => {
    requireWorkbench(event);
    const result = await roomViews.dock(roomId, { reason: "button" });
    if (result.docked) recordEvent("room.window-dock", { roomId, reason: "button" });
    return result;
  });
  handle("workbench:detachAgent", async (event, options = {}) => {
    requireWorkbench(event);
    if (!agentWindows) throw new Error("AI 创建独立窗口尚未初始化");
    return agentWindows.detach({
      force: options?.force === true,
      fromDrag: options?.fromDrag === true
    });
  });
  handle("workbench:dockAgent", async (event) => {
    requireWorkbench(event);
    if (!agentWindows) throw new Error("AI 创建独立窗口尚未初始化");
    const fromAgentWindow = agentWindows.isAgentSender(event.sender.id);
    if (fromAgentWindow) {
      setImmediate(() => agentWindows.dock({ reason: "button" }));
      return { mode: "attached", docked: true };
    }
    return agentWindows.dock({ reason: "button" });
  });
  handle("workbench:closeAgent", async (event) => {
    requireWorkbench(event);
    if (!agentWindows) return { mode: "closed", closed: false };
    const fromAgentWindow = agentWindows.isAgentSender(event.sender.id);
    if (fromAgentWindow) {
      setImmediate(() => agentWindows.close({ reason: "close-tab" }));
      return { mode: "closed", closed: true };
    }
    return agentWindows.close({ reason: "close-tab" });
  });
  handle("workbench:requestOpenRoom", async (event, roomId) => {
    requireWorkbench(event);
    if (!roomStore.getRoom(roomId)) throw new Error("房间不存在");
    if (!mainWindow.isDestroyed()) {
      if (typeof mainWindow.isMinimized === "function" && mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("workbench:openRoomRequested", roomId);
    }
    if (agentWindows?.isAgentSender(event.sender.id)) {
      setImmediate(() => agentWindows.dock({ reason: "open-room" }));
    }
    return true;
  });
  handle("workbench:installExample", async (event, exampleId = "inventory") => {
    requireWorkbench(event);
    const example = examplePackages.find((item) => item.id === exampleId);
    if (!example) throw new Error("示例房间不存在");
    if (roomStore.getRoom(example.roomId)) throw new Error("已安装房间必须先查看更新预检并确认，不能直接覆盖");
    const room = await roomStore.installPackage(example.packagePath, { source: "builtin" });
    await gitService.captureRoom(room.id, `安装内置示例“${example.name}” v${room.version}`, { kind: "install" });
    await recordEvent("room.install-example", { exampleId: example.id, roomId: room.id, version: room.version });
    notifyRoomsChanged();
    return room;
  });
  handle("workbench:inspectRoom", async (event) => {
    requireWorkbench(event);
    roomViews.hide();
    const lastImportDirectory = await importLocation.get();
    const result = await dialogApi.showOpenDialog(mainWindow, {
      title: "导入千万间房间",
      ...(lastImportDirectory ? { defaultPath: lastImportDirectory } : {}),
      properties: ["openFile"],
      filters: [{ name: "千万间 Roomillion 房间", extensions: ["room", "zroom"] }]
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const inspection = await dataBackups.inspectRoomTransfer(result.filePaths[0], { source: "external" });
    await importLocation.remember(result.filePaths[0]);
    return inspection;
  });
  handle("workbench:inspectRoomPath", async (event, packagePath) => {
    requireWorkbench(event);
    roomViews.hide();
    const extension = typeof packagePath === "string" ? path.extname(packagePath).toLowerCase() : "";
    if (typeof packagePath !== "string" || !path.isAbsolute(packagePath) || ![".room", ".zroom"].includes(extension)) {
      throw new Error("只能导入本地 .room 文件（兼容旧版 .zroom）");
    }
    const stats = await fsp.stat(packagePath);
    if (!stats.isFile()) throw new Error("房间包不是普通文件");
    const inspection = await dataBackups.inspectRoomTransfer(packagePath, { source: "external" });
    await importLocation.remember(packagePath);
    return inspection;
  });
  handle("workbench:unlockRoomImport", async (event, token, password) => {
    requireWorkbench(event);
    return dataBackups.unlockRoomTransfer(token, password);
  });
  handle("workbench:cancelImport", async (event, token) => {
    requireWorkbench(event);
    const roomCanceled = await roomStore.cancelImport(token);
    const bundleCanceled = await dataBackups.cancelRoomBundle(token);
    return roomCanceled || bundleCanceled;
  });
  handle("workbench:confirmImport", async (event, token, selectedKeys) => {
    requireWorkbench(event);
    const pending = roomStore.pendingImports.get(token);
    if (pending && roomStore.getRoom(pending.manifest.id)) {
      await gitService.captureRoom(pending.manifest.id, "导入或更新前保留程序", { kind: "manual" });
    }
    const room = await roomStore.commitImport(token, selectedKeys);
    let transferDataRestored = null;
    let transferDataError = null;
    try {
      const completion = await dataBackups.completeRoomTransferImport(token, room.id);
      if (completion?.kind === "data-restored") transferDataRestored = completion;
    } catch (error) {
      transferDataError = error.message;
    }
    await gitService.captureRoom(room.id, `导入房间 v${room.version}`, { kind: "install" });
    await recordEvent("room.import", {
      roomId: room.id,
      version: room.version,
      source: room.source,
      trust: room.trust,
      includesData: Boolean(transferDataRestored),
      dataRestored: Boolean(transferDataRestored)
    });
    roomViews.close(room.id);
    notifyRoomsChanged();
    return transferDataRestored || transferDataError
      ? { ...room, transferDataRestored, transferDataError }
      : room;
  });
  handle("workbench:getRoomPermissions", async (event, roomId) => {
    requireWorkbench(event);
    return roomStore.getPermissionDetails(roomId);
  });
  handle("workbench:getRoomAiModels", async (event, roomId) => {
    requireWorkbench(event);
    const room = roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    if (!room.permissions?.ai) throw new Error("房间未申请 AI 能力");
    return {
      selection: aiService.getRoomModelSelection(room.id),
      models: await aiService.listRoomModels(room.id)
    };
  });
  handle("workbench:selectRoomAiModel", async (event, roomId, profileId) => {
    requireWorkbench(event);
    const room = roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    if (!room.permissions?.ai) throw new Error("房间未申请 AI 能力");
    const selection = await aiService.selectRoomModel(room.id, profileId);
    notifyAiModelsChanged();
    return selection;
  });
  handle("workbench:setRoomPermissions", async (event, roomId, selectedKeys) => {
    requireWorkbench(event);
    const result = await roomStore.setRoomPermissions(roomId, selectedKeys);
    await recordEvent("room.permissions", { roomId, selectedKeys });
    notifyRoomsChanged();
    notifyNetworkStatusChanged(roomId);
    roomBrowser?.handlePermissionsChanged(roomId);
    return result;
  });
  handle("workbench:getRoomHistory", async (event, roomId) => {
    requireWorkbench(event);
    return gitService.listHistory(roomId);
  });
  handle("workbench:createCheckpoint", async (event, roomId, label) => {
    requireWorkbench(event);
    return gitService.captureRoom(roomId, label, { kind: "manual" });
  });
  handle("workbench:restoreCheckpoint", async (event, roomId, checkpointId) => {
    requireWorkbench(event);
    roomViews.close(roomId);
    const result = await gitService.restoreCheckpoint(roomId, checkpointId);
    await recordEvent("room.restore-checkpoint", { roomId, checkpointId });
    notifyRoomsChanged();
    return result;
  });
  handle("workbench:exportRoom", async (event, roomId, options = {}) => {
    requireWorkbench(event);
    const room = roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    if (
      !options || typeof options !== "object" || Array.isArray(options) ||
      (options.includeData !== undefined && typeof options.includeData !== "boolean") ||
      (options.password !== undefined && typeof options.password !== "string") ||
      (options.allowAiModification !== undefined && typeof options.allowAiModification !== "boolean")
    ) {
      throw new Error("房间导出选项无效");
    }
    const includeData = options.includeData === true;
    roomViews.hide();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: includeData ? "导出应用和数据" : "仅导出房间应用",
      defaultPath: includeData
        ? `${room.name}-${room.version}-含数据.room`
        : `${room.name}-${room.version}.room`,
      filters: [{ name: "千万间 Roomillion 房间", extensions: ["room"] }]
    });
    if (result.canceled || !result.filePath) return null;
    const exported = await dataBackups.createRoomTransfer(roomId, {
      includeData,
      password: options.password ?? "",
      allowAiModification: options.allowAiModification === true
    }, result.filePath);
    await recordEvent("room.export", {
      roomId,
      mode: exported.mode,
      protected: exported.protected,
      allowAiModification: options.allowAiModification === true,
      bytes: exported.bytes
    });
    return exported;
  });
  handle("workbench:exportRoomData", async (event, roomId, password) => {
    requireWorkbench(event);
    const room = roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    roomViews.hide();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `备份“${room.name}”的数据`,
      defaultPath: `${room.name}-数据-${new Date().toISOString().slice(0, 10)}.zdata`,
      filters: [{ name: "智变房间数据", extensions: ["zdata"] }]
    });
    if (result.canceled || !result.filePath) return null;
    const backup = await dataBackups.createBackup(roomId, password, result.filePath);
    await recordEvent("data.backup", { roomId, bytes: backup.bytes });
    return backup;
  });
  handle("workbench:inspectRoomData", async (event, roomId) => {
    requireWorkbench(event);
    const room = roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    roomViews.hide();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `恢复“${room.name}”的数据`,
      properties: ["openFile"],
      filters: [{ name: "智变房间数据", extensions: ["zdata"] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return dataBackups.inspectBackup(result.filePaths[0], roomId);
  });
  handle("workbench:cancelDataRestore", async (event, token) => {
    requireWorkbench(event);
    return dataBackups.cancelRestore(token);
  });
  handle("workbench:confirmDataRestore", async (event, token, password) => {
    requireWorkbench(event);
    const pending = dataBackups.pendingRestores.get(token);
    if (pending) roomViews.close(pending.envelope.room.id);
    const restored = await dataBackups.restoreBackup(token, password);
    await recordEvent("data.restore", { roomId: restored.roomId, backupCreated: restored.backupCreated });
    return restored;
  });
  handle("workbench:listDataRecoveryPoints", async (event, roomId) => {
    requireWorkbench(event);
    if (!roomStore.getRoom(roomId)) throw new Error("房间不存在");
    return dataBackups.listRecoveryPoints(roomId);
  });
  handle("workbench:restoreDataRecoveryPoint", async (event, roomId, name) => {
    requireWorkbench(event);
    if (!roomStore.getRoom(roomId)) throw new Error("房间不存在");
    // Validate before closing the room. Only host-created local checkpoint names are accepted.
    const snapshot = await dataBackups.readRecoveryPoint(roomId, name);
    roomViews.close(roomId);
    const restored = await dataBackups.restorePlainSnapshot(roomId, snapshot);
    await recordEvent("data.restore-checkpoint", { roomId, backupCreated: restored.backupCreated });
    return restored;
  });
  const uninstallRoom = async (roomId) => {
    const room = roomStore.getRoom(roomId);
    if (!room) return { uninstalled: false, missing: true };
    roomViews.hide();
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "卸载房间",
      message: `卸载“${room.name}”？`,
      detail: "卸载会关闭房间窗口，并移除程序、权限和版本历史。选择“保留数据”后，以后重新安装相同房间可以继续使用原业务数据；“彻底卸载”会同时永久删除本地数据。",
      buttons: ["取消", "卸载并保留数据", "彻底卸载"],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    });
    if (choice.response === 0) return { uninstalled: false, canceled: true };
    const deleteData = choice.response === 2;
    await roomAgent.unlinkRoom(roomId);
    if (deleteData && room.permissions?.browser?.includes("navigate")) await roomBrowser.clearPersistentData(roomId);
    roomViews.close(roomId);
    await largeText.closeRoom(roomId);
    await database.closeRoom(roomId);
    binaryFiles.closeRoom(roomId);
    networkService.closeRoom(roomId);
    await closeExportStreams(roomId);
    await roomStore.deleteRoom(roomId, { deleteData });
    let historyWarning = "";
    try {
      await gitService.removeRoom(roomId);
    } catch (error) {
      historyWarning = String(error?.message || error).slice(0, 300);
      console.error("清理已卸载房间的版本历史失败", error);
    }
    await recordEvent("room.uninstall", { roomId, dataRetained: !deleteData, historyCleanupOk: !historyWarning });
    notifyRoomsChanged();
    return { uninstalled: true, dataRetained: !deleteData, historyWarning };
  };
  handle("workbench:uninstallRoom", async (event, roomId) => {
    requireWorkbench(event);
    return uninstallRoom(roomId);
  });
  handle("workbench:deleteRoom", async (event, roomId) => {
    requireWorkbench(event);
    return uninstallRoom(roomId);
  });
  handle("workbench:saveProvider", async (event, profile) => {
    requireWorkbench(event);
    const saved = await aiService.saveProfile(profile);
    await recordEvent("ai.configure", { providerId: saved.providerId, model: saved.model, hasStoredKey: saved.hasStoredKey });
    notifyAiModelsChanged();
    return saved;
  });
  handle("workbench:setActiveProvider", async (event, profileId) => {
    requireWorkbench(event);
    const result = await aiService.setActiveProfile(profileId);
    notifyAiModelsChanged();
    return result;
  });
  handle("workbench:deleteProvider", async (event, profileId) => {
    requireWorkbench(event);
    const result = await aiService.deleteProfile(profileId);
    notifyAiModelsChanged();
    return result;
  });
  handle("workbench:clearSessionKey", async (event, profileId) => {
    requireWorkbench(event);
    const result = await aiService.clearSessionKey(profileId);
    notifyAiModelsChanged();
    return result;
  });
  handle("workbench:importProviderConfig", async (event) => {
    requireWorkbench(event);
    roomViews.hide();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入组织 AI 配置",
      properties: ["openFile"],
      filters: [{ name: "智变组织 AI 配置", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const stats = await fsp.stat(result.filePaths[0]);
    if (!stats.isFile() || stats.size > 1024 * 1024) throw new Error("组织 AI 配置必须是 1 MB 以内的 JSON 文件");
    const profile = await aiService.importOrganizationConfig(JSON.parse(await fsp.readFile(result.filePaths[0], "utf8")));
    notifyAiModelsChanged();
    return profile;
  });
  handle("workbench:testProvider", async (event, profileId) => {
    requireWorkbench(event);
    try {
      const result = await aiService.testConnection(profileId);
      await recordEvent("ai.test", { model: result.model, latencyMs: result.latencyMs, ok: result.ok });
      return result;
    } finally { notifyAiModelsChanged(); }
  });
  handle("workbench:listRoomAgentSessions", async (event) => {
    requireWorkbench(event);
    return roomAgent.listSessions();
  });
  handle("workbench:createRoomAgentSession", async (event, options = {}) => {
    requireWorkbench(event);
    return roomAgent.createSession(options);
  });
  handle("workbench:getRoomAgentSession", async (event, sessionId) => {
    requireWorkbench(event);
    return roomAgent.getSession(sessionId);
  });
  handle("workbench:exportRoomAgentSession", async (event, sessionId) => {
    requireWorkbench(event);
    const session = roomAgent.getSession(sessionId);
    const parent = require("electron").BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const safeTitle = String(session.title || "room-agent-chat").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 60);
    const result = await dialog.showSaveDialog(parent, {
      title: "导出 AI 创建房间对话",
      defaultPath: `${safeTitle}-${String(session.id).slice(0, 8)}.json`,
      filters: [{ name: "JSON 对话记录", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return null;
    const report = buildRoomAgentExport(session, { appVersion: require("../../package.json").version });
    await fsp.writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { filePath: result.filePath };
  });
  handle("workbench:importSourceProject", async (event, sessionId) => {
    requireWorkbench(event);
    roomAgent.requireSession(sessionId);
    const parent = require("electron").BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const consent = await dialog.showMessageBox(parent, {
      type: "question", title: "导入现有项目为房间", buttons: ["取消", "选择源码文件夹"], defaultId: 0, cancelId: 0,
      message: "请选择你有权使用的、已去除敏感信息的源码副本。",
      detail: "工作台只读保存 UTF-8 文本快照，不修改原项目、不安装依赖、不执行代码。随后发送消息时，AI 可按需读取源码，并将其发送给你为该对话选择的模型服务。会排除常见密钥文件和依赖目录，但无法保证识别全部秘密或个人数据。图片、二进制素材及业务数据库不导入。"
    });
    if (consent.response !== 1) return null;
    const selection = await dialog.showOpenDialog(parent, { title: "选择已脱敏的项目源码文件夹", properties: ["openDirectory"] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return roomAgent.importSourceProject(sessionId, selection.filePaths[0]);
  });
  handle("workbench:setRoomAgentModel", async (event, sessionId, profileId) => {
    requireWorkbench(event);
    return roomAgent.setSessionModel(sessionId, profileId);
  });
  handle("workbench:renameRoomAgentSession", async (event, sessionId, title) => {
    requireWorkbench(event);
    return roomAgent.renameSession(sessionId, title);
  });
  handle("workbench:selectRoomAgentSession", async (event, sessionId) => {
    requireWorkbench(event);
    const session = roomAgent.getSession(sessionId);
    const windows = agentWindows ? agentWindows.getWorkbenchWindows() : [mainWindow];
    for (const window of windows) {
      if (!window.isDestroyed() && window.webContents.id !== event.sender.id) {
        window.webContents.send("workbench:roomAgentSessionSelected", sessionId);
      }
    }
    return { id: session.id };
  });
  handle("workbench:sendRoomAgentMessage", async (event, sessionId, message) => {
    requireWorkbench(event);
    return roomAgent.send(sessionId, message);
  });
  handle("workbench:getRoomAgentAttachment", async (event, sessionId, attachmentId) => {
    requireWorkbench(event);
    return roomAgent.getAttachment(sessionId, attachmentId);
  });
  handle("workbench:abortRoomAgent", async (event, sessionId) => {
    requireWorkbench(event);
    return roomAgent.abort(sessionId);
  });
  handle("workbench:deleteRoomAgentSession", async (event, sessionId) => {
    requireWorkbench(event);
    return roomAgent.deleteSession(sessionId);
  });
  handle("workbench:generateRoom", async (event, prompt) => {
    requireWorkbench(event);
    const result = await generateRoomFromPrompt({ prompt, aiService, roomStore });
    await gitService.captureRoom(result.room.id, "AI 创建初始版本", { kind: "generated" });
    await recordEvent("room.ai-generate", {
      roomId: result.room.id,
      version: result.room.version,
      model: result.model,
      ignoredHostModuleCount: result.ignoredHostModules.length,
      generationAttempts: result.generationAttempts,
      repaired: result.repaired,
      qualityPassed: result.quality?.passed === true
    });
    notifyRoomsChanged();
    return result;
  });
  handle("workbench:modifyRoom", async (event, roomId, prompt) => {
    requireWorkbench(event);
    const room = roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    await gitService.captureRoom(room.id, "AI 修改前", { kind: "ai-before" });
    const result = await updateGeneratedRoomFromPrompt({ roomId, prompt, aiService, roomStore });
    await gitService.captureRoom(result.room.id, "AI 修改完成", { kind: "ai-update" });
    await recordEvent("room.ai-update", {
      roomId: result.room.id,
      version: result.room.version,
      model: result.model,
      ignoredHostModuleCount: result.ignoredHostModules.length,
      generationAttempts: result.generationAttempts,
      repaired: result.repaired,
      qualityPassed: result.quality?.passed === true
    });
    roomViews.close(roomId);
    notifyRoomsChanged();
    return result;
  });
  handle("workbench:previewDiagnostics", async (event) => {
    requireWorkbench(event);
    roomViews.hide();
    return diagnostics.previewReport({ environment, rooms: roomStore.listRooms() });
  });
  handle("workbench:exportDiagnostics", async (event) => {
    requireWorkbench(event);
    roomViews.hide();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出脱敏诊断报告",
      defaultPath: `Roomillion-诊断-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON 诊断报告", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return null;
    const report = await diagnostics.createReport({ environment, rooms: roomStore.listRooms(), destinationPath: result.filePath });
    await recordEvent("diagnostics.export", { bytes: report.bytes, eventCount: report.eventCount });
    return report;
  });

  handle("room:getInfo", async (event) => requireRoom(event));
  for (const method of ["create", "list", "upsert", "search", "remove", "drop"]) {
    handle(`room:vector:${method}`, async (event, ...args) => {
      const room = requireRoom(event);
      if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有数据库权限");
      return vectors[method](room.id, ...args);
    });
  }
  handle("room:filePickMany", async (event, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "pickMany")) throw new Error("房间没有批量选择文件权限");
    const extensions = normalizeBinaryExtensions(options);
    const selected = await dialogApi.showOpenDialog(roomViews.getDialogParent(room.id), {
      title: room.name + "：批量选择文件",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "支持的文件", extensions }]
    });
    if (selected.canceled || !selected.filePaths?.length) return [];
    if (selected.filePaths.length > 10_000) throw new Error("一次最多选择 10000 个文件");
    if (!roomStore.hasPermission(room.id, "files", "pickMany")) throw new Error("批量文件权限已撤销");
    return Promise.all(selected.filePaths.map((filePath) => binaryFiles.open(room.id, filePath)));
  });
  handle("room:directoryOpen", async (event, options = {}) => {
    const room = requireRoom(event);
    const mode = ["read", "write", "readwrite"].includes(options.mode) ? options.mode : "read";
    if (["read", "readwrite"].includes(mode) && !roomStore.hasPermission(room.id, "files", "directoryRead")) throw new Error("房间没有读取文件夹权限");
    if (["write", "readwrite"].includes(mode) && !roomStore.hasPermission(room.id, "files", "directoryWrite")) throw new Error("房间没有写入文件夹权限");
    const selected = await dialogApi.showOpenDialog(roomViews.getDialogParent(room.id), {
      title: `${room.name}：选择${mode === "read" ? "输入" : mode === "write" ? "输出" : "工作"}文件夹`,
      properties: ["openDirectory", "createDirectory"]
    });
    if (selected.canceled || !selected.filePaths?.[0]) return null;
    return directoryFiles.grant(room.id, selected.filePaths[0], mode);
  });
  handle("room:directoryGrants", async (event) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "directoryRead") && !roomStore.hasPermission(room.id, "files", "directoryWrite")) throw new Error("房间没有文件夹权限");
    return directoryFiles.listGrants(room.id);
  });
  handle("room:directoryList", async (event, grantId, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "directoryRead")) throw new Error("房间没有读取文件夹权限");
    return directoryFiles.list(room.id, grantId, options);
  });
  handle("room:directoryRead", async (event, grantId, relativePath, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "directoryRead")) throw new Error("房间没有读取文件夹权限");
    return directoryFiles.read(room.id, grantId, relativePath, options);
  });
  handle("room:directoryWrite", async (event, grantId, relativePath, content) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "directoryWrite")) throw new Error("房间没有写入文件夹权限");
    return directoryFiles.write(room.id, grantId, relativePath, content);
  });
  handle("room:directoryRevoke", async (event, grantId) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "directoryRead") && !roomStore.hasPermission(room.id, "files", "directoryWrite")) throw new Error("房间没有文件夹权限");
    return directoryFiles.revoke(room.id, grantId);
  });
  handle("room:binaryOpen", async (event, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "pick")) throw new Error("房间没有选择文件权限");
    const extensions = normalizeBinaryExtensions(options);
    const selected = await dialogApi.showOpenDialog(roomViews.getDialogParent(room.id), { title: room.name + "：选择大文件（最大 2 GiB）", properties: ["openFile"], filters: [{ name: "支持的文件", extensions }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    if (!roomStore.hasPermission(room.id, "files", "pick")) throw new Error("文件权限已撤销");
    return binaryFiles.open(room.id, selected.filePaths[0]);
  });
  handle("room:binaryRead", async (event, token, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "pick") && !roomStore.hasPermission(room.id, "files", "pickMany")) { binaryFiles.closeRoom(room.id); throw new Error("房间没有选择文件权限"); }
    return binaryFiles.read(room.id, token, options);
  });
  handle("room:binaryClose", async (event, token) => binaryFiles.close(requireRoom(event).id, token));
  handle("room:aiEmbed", async (event, texts, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("向量调用选项无效");
    const profileId = options.profileId || aiService.getRoomModelSelection(room.id).profileId;
    return aiService.embed(texts, { profileId, model: options.model, dimensions: options.dimensions });
  });
  handle("room:dbQuery", async (event, sql, params) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有数据库权限");
    return database.query(room.id, sql, params);
  });
  handle("room:dbRun", async (event, sql, params) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有数据库权限");
    return database.run(room.id, sql, params);
  });
  handle("room:storageGet", async (event, key) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有存储权限");
    return database.storageGet(room.id, key);
  });
  handle("room:storageSet", async (event, key, value) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有存储权限");
    return database.storageSet(room.id, key, value);
  });
  handle("room:pickText", async (event) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "pick")) throw new Error("房间没有选择文件权限");
    const result = await dialogApi.showOpenDialog(roomViews.getDialogParent(room.id), {
      title: `${room.name}：选择文本文件`,
      properties: ["openFile"],
      filters: [{ name: "文本文件", extensions: ["txt", "md", "json", "csv"] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const stats = await fsp.stat(result.filePaths[0]);
    return { name: path.basename(result.filePaths[0]), text: await fsp.readFile(result.filePaths[0], "utf8") };
  });
  handle("room:pickBinary", async (event, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "pick")) throw new Error("房间没有选择文件权限");
    const extensions = normalizeBinaryExtensions(options);
    const result = await dialogApi.showOpenDialog(roomViews.getDialogParent(room.id), {
      title: room.name + "：选择办公文件",
      properties: ["openFile"],
      filters: [{ name: "支持的文件", extensions }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const stats = await fsp.stat(filePath);
    const buffer = await fsp.readFile(filePath);
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return {
      name: path.basename(filePath),
      size: buffer.length,
      type: BINARY_MIME_TYPES[extension] ?? "application/octet-stream",
      data: new Uint8Array(buffer)
    };
  });
  handle("room:largeTextOpen", async (event, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "largeText")) throw new Error("房间没有超长文本读取权限");
    const result = await dialogApi.showOpenDialog(roomViews.getDialogParent(room.id), {
      title: `${room.name}：选择超长文本文件`,
      properties: ["openFile"],
      filters: [
        { name: "文本与日志", extensions: ["txt", "log", "md", "csv", "tsv", "json", "jsonl", "ndjson"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return largeText.open(room.id, result.filePaths[0], options);
  });
  handle("room:largeTextReadNext", async (event, token, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "largeText")) throw new Error("房间没有超长文本读取权限");
    return largeText.readNext(room.id, token, options);
  });
  handle("room:largeTextReset", async (event, token) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "largeText")) throw new Error("房间没有超长文本读取权限");
    return largeText.reset(room.id, token);
  });
  handle("room:largeTextSetEncoding", async (event, token, encoding) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "largeText")) throw new Error("房间没有超长文本读取权限");
    return largeText.setEncoding(room.id, token, encoding);
  });
  handle("room:largeTextStartSearch", async (event, token, query, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "largeText")) throw new Error("房间没有超长文本读取权限");
    const sender = event.sender;
    return largeText.startSearch(room.id, token, query, options, (payload) => {
      if (!sender.isDestroyed()) sender.send("room:largeTextTask", payload);
    });
  });
  handle("room:largeTextCancelTask", async (event, taskId) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "largeText")) throw new Error("房间没有超长文本读取权限");
    return largeText.cancelTask(room.id, taskId);
  });
  handle("room:largeTextClose", async (event, token) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "largeText")) throw new Error("房间没有超长文本读取权限");
    return largeText.close(room.id, token);
  });
  handle("room:exportText", async (event, suggestedName, content) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "export")) throw new Error("房间没有导出文件权限");
    if (typeof content !== "string") throw new Error("导出内容必须是文本");
    const safeName = path.basename(String(suggestedName || "export.txt")).slice(0, 120);
    const result = await dialogApi.showSaveDialog(roomViews.getDialogParent(room.id), { title: `${room.name}：导出文件`, defaultPath: safeName });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, content, "utf8");
    return result.filePath;
  });
  handle("room:exportBinary", async (event, suggestedName, content) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "export")) throw new Error("房间没有导出文件权限");
    const buffer = binaryBuffer(content);
    if (buffer.length === 0) throw new Error("导出二进制内容不能为空");
    const safeName = path.basename(String(suggestedName || "export.bin")).slice(0, 120);
    const result = await dialogApi.showSaveDialog(roomViews.getDialogParent(room.id), {
      title: room.name + "：导出文件",
      defaultPath: safeName
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, buffer);
    return result.filePath;
  });
  handle("room:credentialList", async (event) => {
    const room = requireRoom(event);
    return credentialService?.listForRoom?.(room) || [];
  });
  handle("room:networkGetStatus", async (event) => {
    const room = requireRoom(event);
    return networkService.getRoomStatus(room);
  });
  handle("room:exportBegin", async (event, suggestedName = "export.bin") => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "files", "export")) throw new Error("房间没有导出文件权限");
    const safeName = path.basename(String(suggestedName || "export.bin")).slice(0, 240);
    const result = await dialogApi.showSaveDialog(roomViews.getDialogParent(room.id), { title: room.name + "：流式导出文件", defaultPath: safeName });
    if (result.canceled || !result.filePath) return null;
    const token = crypto.randomUUID();
    const fileHandle = await fsp.open(result.filePath, "w");
    exportStreams.set(token, { roomId: room.id, path: result.filePath, handle: fileHandle, bytes: 0 });
    return { token, path: result.filePath, bytes: 0 };
  });
  handle("room:exportWrite", async (event, token, content) => {
    const room = requireRoom(event);
    const stream = exportStreams.get(String(token || ""));
    if (!stream || stream.roomId !== room.id) throw new Error("导出流不存在或已关闭");
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : binaryBuffer(content);
    if (buffer.length) { await stream.handle.write(buffer); stream.bytes += buffer.length; }
    return { bytes: stream.bytes };
  });
  handle("room:exportFinish", async (event, token) => {
    const room = requireRoom(event);
    const stream = exportStreams.get(String(token || ""));
    if (!stream || stream.roomId !== room.id) throw new Error("导出流不存在或已关闭");
    exportStreams.delete(String(token)); await stream.handle.sync(); await stream.handle.close();
    return { path: stream.path, bytes: stream.bytes };
  });
  handle("room:exportAbort", async (event, token) => {
    const room = requireRoom(event);
    const stream = exportStreams.get(String(token || ""));
    if (!stream || stream.roomId !== room.id) return false;
    exportStreams.delete(String(token)); await stream.handle.close().catch(() => {}); await fsp.rm(stream.path, { force: true }).catch(() => {});
    return true;
  });
  handle("room:networkRequest", async (event, options = {}) => {
    const room = requireRoom(event);
    const result = await networkService.request(room, options);
    await recordEvent("room.network", {
      roomId: room.id,
      origin: new URL(result.url).origin,
      method: String(options?.method || "GET").toUpperCase(),
      status: result.status,
      bytes: result.bytes
    });
    return result;
  });
  handle("room:networkOpen", async (event, options = {}) => {
    const room = requireRoom(event);
    const result = await networkService.open(room, options);
    await recordEvent("room.network.stream", { roomId: room.id, origin: new URL(result.url).origin, method: String(options?.method || "GET").toUpperCase(), status: result.status });
    return result;
  });
  handle("room:networkRead", async (event, token, options = {}) => networkService.read(requireRoom(event), token, options));
  handle("room:networkClose", async (event, token) => networkService.close(requireRoom(event), token));
  handle("room:browserGetState", async (event) => {
    const room = requireRoom(event);
    return roomBrowser.getState(room.id);
  });
  handle("room:browserCreateTab", async (event, input = "") => {
    const room = requireRoom(event);
    return roomBrowser.createTab(room.id, input);
  });
  handle("room:browserCloseTab", async (event, tabId) => {
    const room = requireRoom(event);
    return roomBrowser.closeTab(room.id, tabId);
  });
  handle("room:browserActivateTab", async (event, tabId) => {
    const room = requireRoom(event);
    return roomBrowser.activateTab(room.id, tabId);
  });
  handle("room:browserNavigate", async (event, tabId, input) => {
    const room = requireRoom(event);
    const result = await roomBrowser.navigate(room.id, tabId, input);
    await recordEvent("room.browser.navigate", { roomId: room.id, tabId, networkAllowed: result.networkAllowed });
    return result;
  });
  handle("room:browserGoBack", async (event, tabId) => {
    const room = requireRoom(event);
    return roomBrowser.navigationAction(room.id, tabId, "goBack");
  });
  handle("room:browserGoForward", async (event, tabId) => {
    const room = requireRoom(event);
    return roomBrowser.navigationAction(room.id, tabId, "goForward");
  });
  handle("room:browserReload", async (event, tabId) => {
    const room = requireRoom(event);
    return roomBrowser.navigationAction(room.id, tabId, "reload");
  });
  handle("room:browserStop", async (event, tabId) => {
    const room = requireRoom(event);
    return roomBrowser.navigationAction(room.id, tabId, "stop");
  });
  handle("room:browserSetViewport", async (event, bounds) => {
    const room = requireRoom(event);
    return roomBrowser.setViewport(room.id, bounds);
  });
  handle("room:browserClearData", async (event, options = {}) => {
    const room = requireRoom(event);
    const result = await roomBrowser.clearData(room.id, options);
    await recordEvent("room.browser.clear-data", { roomId: room.id, hadSession: result.hadSession });
    return result;
  });
  handle("room:browserRespondPermission", async (event, requestId, allowed) => {
    const room = requireRoom(event);
    const result = roomBrowser.respondToPermission(room.id, requestId, allowed);
    await recordEvent("room.browser.site-permission", { roomId: room.id, allowed: allowed === true });
    return result;
  });
  handle("room:blobList", async (event, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return blobs.list(room.id, options);
  });
  handle("room:blobBegin", async (event, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return blobs.begin(room.id, options);
  });
  handle("room:blobWrite", async (event, token, content) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return blobs.write(room.id, token, content);
  });
  handle("room:blobFinish", async (event, token) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return blobs.finish(room.id, token);
  });
  handle("room:blobAbort", async (event, token) => blobs.abort(requireRoom(event).id, token));
  handle("room:blobPut", async (event, options, content) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return blobs.put(room.id, options || {}, content);
  });
  handle("room:blobRead", async (event, id, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return blobs.read(room.id, id, options);
  });
  handle("room:blobRemove", async (event, id) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return blobs.remove(room.id, id);
  });
  handle("room:artifactExportDirectory", async (event, id, grantId, relativePath) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    if (!roomStore.hasPermission(room.id, "files", "directoryWrite")) throw new Error("房间没有写入文件夹权限");
    const file = await blobs.getFile(room.id, id);
    if (file.item.kind !== "artifact") throw new Error("只能把制品导出到文件夹");
    return directoryFiles.copyInto(room.id, grantId, relativePath || file.item.name, file.path);
  });
  handle("room:documentMarkdownToPdf", async (event, source, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    if (typeof source === "string") return documents.renderMarkdown(room.id, source, options);
    if (source?.artifactId) return documents.renderMarkdownArtifact(room.id, String(source.artifactId), options);
    throw new Error("PDF 源必须是 Markdown 文本或 Markdown 制品 ID");
  });
  handle("room:toolList", async (event) => roomTools.list(requireRoom(event)));
  handle("room:toolCall", async (event, id, input = null) => roomTools.call(requireRoom(event), id, input));
  handle("room:jobCreate", async (event, input = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return jobs.create(room.id, input);
  });
  handle("room:jobList", async (event, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return jobs.list(room.id, options);
  });
  handle("room:jobGet", async (event, id) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return jobs.get(room.id, id);
  });
  handle("room:jobTransition", async (event, id, input = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return jobs.transition(room.id, id, input);
  });
  handle("room:jobRecover", async (event) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "database")) throw new Error("房间没有私有数据权限");
    return jobs.recover(room.id);
  });
  handle("room:aiListModels", async (event) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    return aiService.listRoomModels(room.id);
  });
  handle("room:aiGetSelection", async (event) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    return aiService.getRoomModelSelection(room.id);
  });
  handle("room:aiGetSlotDefinitions", async (event) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    return declaredModelSlots(room);
  });
  handle("room:aiGetSlots", async (event) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    return aiService.getRoomModelSlots(room.id);
  });
  handle("room:aiSelectSlot", async (event, slot, profileId) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    await validateAiSlotProfile(room, slot, profileId);
    return aiService.selectRoomModelSlot(room.id, slot, profileId);
  });
  handle("room:aiClearSlot", async (event, slot) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    return aiService.clearRoomModelSlot(room.id, slot);
  });
  handle("room:aiSelectModel", async (event, profileId) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    return aiService.selectRoomModel(room.id, profileId);
  });
  handle("room:aiCancel", async (event, requestId) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    return roomAiRequests.cancel(event.sender, room.id, requestId);
  });
  handle("room:aiGenerate", async (event, prompt, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    validateRoomAiOptions(options);
    const streamRequestId = options.streamRequestId;
    if (streamRequestId !== undefined && (typeof streamRequestId !== "string" || !/^r[a-z0-9-]{1,80}$/.test(streamRequestId))) {
      throw new Error("AI 流式请求标识无效");
    }
    const request = roomAiRequests.start(event.sender, room.id, options.requestId === undefined ? crypto.randomUUID() : options.requestId);
    try {
      const images = await resolveAiImages(room, options.images);
      if (images.length && !roomStore.hasPermission(room.id, "ai", "vision")) throw new Error("房间没有视觉 AI 权限");
      const requestedMaxTokens = options.maxTokens === undefined ? 2000 : Number(options.maxTokens);
      if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) {
        throw new Error("AI 最大输出 Token 必须是正整数");
      }
      const temperature = options.temperature === undefined ? undefined : Number(options.temperature);
      if (temperature !== undefined && !Number.isFinite(temperature)) throw new Error("AI temperature 必须是有限数字");
      const timeoutMs = options.timeoutMs === undefined ? 120_000 : Number(options.timeoutMs);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("AI 请求超时必须是正整数毫秒");
      const profileId = aiService.resolveRoomModelProfile(room.id, { profileId: options.profileId === undefined ? undefined : String(options.profileId), slot: options.slot });
      await validateAiSlotProfile(room, options.slot, profileId);
      const maxRetries = options.maxRetries === undefined ? 2 : Number(options.maxRetries);
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error("AI 自动重试次数必须是 0–5 的整数");
      const result = await aiService.complete({
        systemPrompt: `你正在为千万间 Roomillion 房间“${room.name}”提供帮助。不要声称能够访问未提供的文件或系统资源。`,
        prompt,
        images,
        maxTokens: requestedMaxTokens,
        temperature,
        structuredOutput: options.structuredOutput === true,
        timeoutMs,
        maxRetries,
        profileId,
        signal: request.signal,
        onTextDelta: streamRequestId ? delta => {
          if (!request.signal.aborted && !event.sender.isDestroyed()) event.sender.send("room:aiTextDelta", { requestId: streamRequestId, delta });
        } : undefined
      });
      return { text: result.text, model: result.model, profileId, usage: result.usage };
    } finally { request.finish(); }
  });

  handle("room:aiBatch", async (event, requests, options = {}) => {
    const room = requireRoom(event);
    if (!roomStore.hasPermission(room.id, "ai")) throw new Error("房间没有 AI 权限");
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 500) throw new Error("批量 AI 请求必须包含 1–500 项");
    const concurrency = Number(options.concurrency || 3);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("AI 并发数必须是 1–8");
    const results = new Array(requests.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < requests.length) {
        const index = cursor++;
        const request = requests[index];
        try {
          if (!request || typeof request.prompt !== "string" || !request.prompt) throw new Error("AI 提示内容不能为空");
          validateRoomAiOptions(request);
          const images = await resolveAiImages(room, request.images);
          if (images.length && !roomStore.hasPermission(room.id, "ai", "vision")) throw new Error("房间没有视觉 AI 权限");
          const requestedSlot = request.slot || options.slot;
          const profileId = aiService.resolveRoomModelProfile(room.id, { profileId: request.profileId, slot: requestedSlot });
          await validateAiSlotProfile(room, requestedSlot, profileId);
          const value = await aiService.complete({
            systemPrompt: `你正在为千万间 Roomillion 房间“${room.name}”执行批处理任务。只处理当前项目，不要声称能够访问未提供的资源。`,
            prompt: request.prompt,
            images,
            maxTokens: Number(request.maxTokens || options.maxTokens || 2000),
            timeoutMs: Number(request.timeoutMs || options.timeoutMs || 120_000),
            maxRetries: Number(request.maxRetries ?? options.maxRetries ?? 2),
            structuredOutput: request.structuredOutput === true,
            temperature: request.temperature,
            profileId,
            sessionId: request.idempotencyKey ? `${room.id}:${String(request.idempotencyKey).slice(0, 160)}` : undefined
          });
          results[index] = { ok: true, text: value.text, model: value.model, profileId, usage: value.usage };
        } catch (error) {
          results[index] = { ok: false, error: String(error.message || error).slice(0, 2000) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()));
    return { results, total: results.length, passed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length };
  });

  return () => {
    for (const channel of registeredChannels) ipcMain.removeHandler(channel);
    for (const stream of exportStreams.values()) stream.handle.close().catch(() => {});
    exportStreams.clear();
    blobs.dispose?.().catch(() => {});
  };
}

module.exports = { hasPermission, registerIpcHandlers };
