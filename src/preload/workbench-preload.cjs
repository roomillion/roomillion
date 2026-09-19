"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("workbench", Object.freeze({
  getState: () => ipcRenderer.invoke("workbench:getState"),
  chooseRoomStorageLocation: () => ipcRenderer.invoke("workbench:chooseRoomStorageLocation"),
  setTheme: (themeId) => ipcRenderer.invoke("workbench:setTheme", themeId),
  setViewport: (bounds) => ipcRenderer.invoke("workbench:setViewport", bounds),
  openRoom: (roomId) => ipcRenderer.invoke("workbench:openRoom", roomId),
  hideRoom: () => ipcRenderer.invoke("workbench:hideRoom"),
  closeRoom: (roomId) => ipcRenderer.invoke("workbench:closeRoom", roomId),
  detachRoom: (roomId, options) => ipcRenderer.invoke("workbench:detachRoom", roomId, options),
  focusRoomWindow: (roomId) => ipcRenderer.invoke("workbench:focusRoomWindow", roomId),
  focusAgentWindow: () => ipcRenderer.invoke("workbench:focusAgentWindow"),
  dockRoom: (roomId) => ipcRenderer.invoke("workbench:dockRoom", roomId),
  detachAgent: (options) => ipcRenderer.invoke("workbench:detachAgent", options),
  dockAgent: () => ipcRenderer.invoke("workbench:dockAgent"),
  closeAgent: () => ipcRenderer.invoke("workbench:closeAgent"),
  requestOpenRoom: (roomId) => ipcRenderer.invoke("workbench:requestOpenRoom", roomId),
  listExamples: () => ipcRenderer.invoke("workbench:listExamples"),
  inspectExample: (exampleId) => ipcRenderer.invoke("workbench:inspectExample", exampleId),
  listDataRecoveryPoints: (roomId) => ipcRenderer.invoke("workbench:listDataRecoveryPoints", roomId),
  restoreDataRecoveryPoint: (roomId, name) => ipcRenderer.invoke("workbench:restoreDataRecoveryPoint", roomId, name),
  installExample: (exampleId) => ipcRenderer.invoke("workbench:installExample", exampleId),
  inspectRoom: () => ipcRenderer.invoke("workbench:inspectRoom"),
  inspectRoomPath: (packagePath) => ipcRenderer.invoke("workbench:inspectRoomPath", packagePath),
  inspectDroppedRoom: (file) => ipcRenderer.invoke("workbench:inspectRoomPath", webUtils.getPathForFile(file)),
  takePendingRoomImports: () => ipcRenderer.invoke("workbench:takePendingRoomImports"),
  unlockRoomImport: (token, password) => ipcRenderer.invoke("workbench:unlockRoomImport", token, password),
  cancelImport: (token) => ipcRenderer.invoke("workbench:cancelImport", token),
  confirmImport: (token, selectedKeys) => ipcRenderer.invoke("workbench:confirmImport", token, selectedKeys),
  getRoomPermissions: (roomId) => ipcRenderer.invoke("workbench:getRoomPermissions", roomId),
  getRoomAiModels: (roomId) => ipcRenderer.invoke("workbench:getRoomAiModels", roomId),
  selectRoomAiModel: (roomId, profileId) => ipcRenderer.invoke("workbench:selectRoomAiModel", roomId, profileId),
  setRoomPermissions: (roomId, selectedKeys) => ipcRenderer.invoke("workbench:setRoomPermissions", roomId, selectedKeys),
  getRoomHistory: (roomId) => ipcRenderer.invoke("workbench:getRoomHistory", roomId),
  createCheckpoint: (roomId, label) => ipcRenderer.invoke("workbench:createCheckpoint", roomId, label),
  restoreCheckpoint: (roomId, checkpointId) => ipcRenderer.invoke("workbench:restoreCheckpoint", roomId, checkpointId),
  exportRoom: (roomId, options) => ipcRenderer.invoke("workbench:exportRoom", roomId, options),
  exportRoomData: (roomId, password) => ipcRenderer.invoke("workbench:exportRoomData", roomId, password),
  inspectRoomData: (roomId) => ipcRenderer.invoke("workbench:inspectRoomData", roomId),
  cancelDataRestore: (token) => ipcRenderer.invoke("workbench:cancelDataRestore", token),
  confirmDataRestore: (token, password) => ipcRenderer.invoke("workbench:confirmDataRestore", token, password),
  uninstallRoom: (roomId) => ipcRenderer.invoke("workbench:uninstallRoom", roomId),
  deleteRoom: (roomId) => ipcRenderer.invoke("workbench:deleteRoom", roomId),
  saveProvider: (profile) => ipcRenderer.invoke("workbench:saveProvider", profile),
  setActiveProvider: (profileId) => ipcRenderer.invoke("workbench:setActiveProvider", profileId),
  deleteProvider: (profileId) => ipcRenderer.invoke("workbench:deleteProvider", profileId),
  clearSessionKey: (profileId) => ipcRenderer.invoke("workbench:clearSessionKey", profileId),
  listCredentials: () => ipcRenderer.invoke("workbench:listCredentials"),
  saveCredential: (input) => ipcRenderer.invoke("workbench:saveCredential", input),
  deleteCredential: (alias) => ipcRenderer.invoke("workbench:deleteCredential", alias),
  setRoomNetworkEnabled: (enabled) => ipcRenderer.invoke("workbench:setRoomNetworkEnabled", enabled),
  importProviderConfig: () => ipcRenderer.invoke("workbench:importProviderConfig"),
  testProvider: (profileId) => ipcRenderer.invoke("workbench:testProvider", profileId),
  listRoomAgentSessions: () => ipcRenderer.invoke("workbench:listRoomAgentSessions"),
  createRoomAgentSession: (options) => ipcRenderer.invoke("workbench:createRoomAgentSession", options),
  getRoomAgentSession: (sessionId) => ipcRenderer.invoke("workbench:getRoomAgentSession", sessionId),
  exportRoomAgentSession: (sessionId) => ipcRenderer.invoke("workbench:exportRoomAgentSession", sessionId),
  importSourceProject: (sessionId) => ipcRenderer.invoke("workbench:importSourceProject", sessionId),
  setRoomAgentModel: (sessionId, profileId) => ipcRenderer.invoke("workbench:setRoomAgentModel", sessionId, profileId),
  renameRoomAgentSession: (sessionId, title) => ipcRenderer.invoke("workbench:renameRoomAgentSession", sessionId, title),
  selectRoomAgentSession: (sessionId) => ipcRenderer.invoke("workbench:selectRoomAgentSession", sessionId),
  sendRoomAgentMessage: async (sessionId, prompt, files = [], approvePlanId = null, aiTest = null) => {
    const attachments = await Promise.all([...files].map(async (file) => {
      const filePath = webUtils.getPathForFile(file);
      const common = { name: file.name, type: file.type, size: file.size };
      if (filePath) return { ...common, path: filePath };
      const bytes = Buffer.from(await file.arrayBuffer());
      return { ...common, data: bytes.toString("base64") };
    }));
    return ipcRenderer.invoke("workbench:sendRoomAgentMessage", sessionId, { prompt, attachments, approvePlanId, aiTest });
  },
  getRoomAgentAttachment: (sessionId, attachmentId) => ipcRenderer.invoke("workbench:getRoomAgentAttachment", sessionId, attachmentId),
  abortRoomAgent: (sessionId) => ipcRenderer.invoke("workbench:abortRoomAgent", sessionId),
  deleteRoomAgentSession: (sessionId) => ipcRenderer.invoke("workbench:deleteRoomAgentSession", sessionId),
  generateRoom: (prompt) => ipcRenderer.invoke("workbench:generateRoom", prompt),
  modifyRoom: (roomId, prompt) => ipcRenderer.invoke("workbench:modifyRoom", roomId, prompt),
  previewDiagnostics: () => ipcRenderer.invoke("workbench:previewDiagnostics"),
  exportDiagnostics: () => ipcRenderer.invoke("workbench:exportDiagnostics"),
  onRoomsChanged: (callback) => {
    const listener = (_event, rooms) => callback(rooms);
    ipcRenderer.on("workbench:roomsChanged", listener);
    return () => ipcRenderer.removeListener("workbench:roomsChanged", listener);
  },
  onRoomWindowState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workbench:roomWindowState", listener);
    return () => ipcRenderer.removeListener("workbench:roomWindowState", listener);
  },
  onRoomAgentEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workbench:roomAgentEvent", listener);
    return () => ipcRenderer.removeListener("workbench:roomAgentEvent", listener);
  },
  onAgentWindowState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workbench:agentWindowState", listener);
    return () => ipcRenderer.removeListener("workbench:agentWindowState", listener);
  },
  onOpenRoomRequested: (callback) => {
    const listener = (_event, roomId) => callback(roomId);
    ipcRenderer.on("workbench:openRoomRequested", listener);
    return () => ipcRenderer.removeListener("workbench:openRoomRequested", listener);
  },
  onRoomImportRequested: (callback) => {
    const listener = (_event, packagePath) => callback(packagePath);
    ipcRenderer.on("workbench:roomImportRequested", listener);
    return () => ipcRenderer.removeListener("workbench:roomImportRequested", listener);
  },
  onAiStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("workbench:aiStateChanged", listener);
    return () => ipcRenderer.removeListener("workbench:aiStateChanged", listener);
  },
  onRoomAgentSessionSelected: (callback) => {
    const listener = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("workbench:roomAgentSessionSelected", listener);
    return () => ipcRenderer.removeListener("workbench:roomAgentSessionSelected", listener);
  }
}));
