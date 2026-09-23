"use strict";

const { contextBridge, ipcRenderer } = require("electron");

let aiRequestCounter = 0;
async function generateAi(prompt, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return ipcRenderer.invoke("room:aiGenerate", prompt, options);
  }
  const { onChunk, ...requestOptions } = options;
  if (typeof onChunk !== "function") return ipcRenderer.invoke("room:aiGenerate", prompt, requestOptions);
  const requestId = `r${Date.now().toString(36)}-${++aiRequestCounter}`;
  let received = "";
  const listener = (_event, payload) => {
    if (payload?.requestId !== requestId || typeof payload.delta !== "string") return;
    received += payload.delta;
    try { onChunk(payload.delta, received); } catch (error) { console.error(error); }
  };
  ipcRenderer.on("room:aiTextDelta", listener);
  try {
    const result = await ipcRenderer.invoke("room:aiGenerate", prompt, { ...requestOptions, streamRequestId: requestId });
    const finalText = typeof result?.text === "string" ? result.text : "";
    const streamedText = received.trimStart();
    if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
      const remaining = finalText.slice(streamedText.length);
      received += remaining;
      try { onChunk(remaining, received); } catch (error) { console.error(error); }
    }
    return result;
  } finally {
    ipcRenderer.removeListener("room:aiTextDelta", listener);
  }
}

contextBridge.exposeInMainWorld("room", Object.freeze({
  getInfo: () => ipcRenderer.invoke("room:getInfo"),
  vector: Object.freeze(Object.fromEntries(["create", "list", "upsert", "search", "remove", "drop"].map((method) => [method, (...args) => ipcRenderer.invoke(`room:vector:${method}`, ...args)]))),
  db: Object.freeze({
    query: (sql, params = []) => ipcRenderer.invoke("room:dbQuery", sql, params),
    run: (sql, params = []) => ipcRenderer.invoke("room:dbRun", sql, params)
  }),
  storage: Object.freeze({
    get: (key) => ipcRenderer.invoke("room:storageGet", key),
    set: (key, value) => ipcRenderer.invoke("room:storageSet", key, value)
  }),
  files: Object.freeze({
    openBinary: (options = {}) => ipcRenderer.invoke("room:binaryOpen", options),
    readBinary: (token, options = {}) => ipcRenderer.invoke("room:binaryRead", token, options),
    closeBinary: (token) => ipcRenderer.invoke("room:binaryClose", token),
    pickMany: (options = {}) => ipcRenderer.invoke("room:filePickMany", options),
    openDirectory: (options = {}) => ipcRenderer.invoke("room:directoryOpen", options),
    listDirectoryGrants: () => ipcRenderer.invoke("room:directoryGrants"),
    listDirectory: (grantId, options = {}) => ipcRenderer.invoke("room:directoryList", grantId, options),
    readDirectoryFile: (grantId, relativePath, options = {}) => ipcRenderer.invoke("room:directoryRead", grantId, relativePath, options),
    writeDirectoryFile: (grantId, relativePath, content) => ipcRenderer.invoke("room:directoryWrite", grantId, relativePath, content),
    revokeDirectory: (grantId) => ipcRenderer.invoke("room:directoryRevoke", grantId),
    pickText: () => ipcRenderer.invoke("room:pickText"),
    pickBinary: (options = {}) => ipcRenderer.invoke("room:pickBinary", options),
    exportText: (suggestedName, content) => ipcRenderer.invoke("room:exportText", suggestedName, content),
    exportBinary: (suggestedName, content) => ipcRenderer.invoke("room:exportBinary", suggestedName, content),
    beginExport: (suggestedName) => ipcRenderer.invoke("room:exportBegin", suggestedName),
    writeExport: (token, content) => ipcRenderer.invoke("room:exportWrite", token, content),
    finishExport: (token) => ipcRenderer.invoke("room:exportFinish", token),
    abortExport: (token) => ipcRenderer.invoke("room:exportAbort", token)
  }),
  largeText: Object.freeze({
    open: (options = {}) => ipcRenderer.invoke("room:largeTextOpen", options),
    readNext: (token, options = {}) => ipcRenderer.invoke("room:largeTextReadNext", token, options),
    reset: (token) => ipcRenderer.invoke("room:largeTextReset", token),
    setEncoding: (token, encoding) => ipcRenderer.invoke("room:largeTextSetEncoding", token, encoding),
    startSearch: (token, query, options = {}) => ipcRenderer.invoke("room:largeTextStartSearch", token, query, options),
    cancelTask: (taskId) => ipcRenderer.invoke("room:largeTextCancelTask", taskId),
    close: (token) => ipcRenderer.invoke("room:largeTextClose", token),
    onTaskEvent: (callback) => {
      if (typeof callback !== "function") throw new TypeError("超长文本任务监听器必须是函数");
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("room:largeTextTask", listener);
      return () => ipcRenderer.removeListener("room:largeTextTask", listener);
    }
  }),
  blobs: Object.freeze({
    list: (options = {}) => ipcRenderer.invoke("room:blobList", options),
    put: (options, content) => ipcRenderer.invoke("room:blobPut", options, content),
    begin: (options = {}) => ipcRenderer.invoke("room:blobBegin", options),
    write: (token, content) => ipcRenderer.invoke("room:blobWrite", token, content),
    finish: (token) => ipcRenderer.invoke("room:blobFinish", token),
    abort: (token) => ipcRenderer.invoke("room:blobAbort", token),
    read: (id, options = {}) => ipcRenderer.invoke("room:blobRead", id, options),
    remove: (id) => ipcRenderer.invoke("room:blobRemove", id)
  }),
  artifacts: Object.freeze({
    list: () => ipcRenderer.invoke("room:blobList", { kind: "artifact" }),
    put: (name, content, options = {}) => ipcRenderer.invoke("room:blobPut", { ...options, name, kind: "artifact" }, content),
    begin: (name, options = {}) => ipcRenderer.invoke("room:blobBegin", { ...options, name, kind: "artifact" }),
    write: (token, content) => ipcRenderer.invoke("room:blobWrite", token, content),
    finish: (token) => ipcRenderer.invoke("room:blobFinish", token),
    abort: (token) => ipcRenderer.invoke("room:blobAbort", token),
    read: (id, options = {}) => ipcRenderer.invoke("room:blobRead", id, options),
    remove: (id) => ipcRenderer.invoke("room:blobRemove", id),
    exportToDirectory: (id, grantId, relativePath) => ipcRenderer.invoke("room:artifactExportDirectory", id, grantId, relativePath)
  }),
  tools: Object.freeze({
    list: () => ipcRenderer.invoke("room:toolList"),
    call: (id, input = null) => ipcRenderer.invoke("room:toolCall", id, input)
  }),
  documents: Object.freeze({
    markdownToPdf: (source, options = {}) => ipcRenderer.invoke("room:documentMarkdownToPdf", source, options)
  }),
  jobs: Object.freeze({
    create: (input = {}) => ipcRenderer.invoke("room:jobCreate", input),
    list: (options = {}) => ipcRenderer.invoke("room:jobList", options),
    get: (id) => ipcRenderer.invoke("room:jobGet", id),
    transition: (id, input = {}) => ipcRenderer.invoke("room:jobTransition", id, input),
    recover: () => ipcRenderer.invoke("room:jobRecover")
  }),
  ai: Object.freeze({
    embed: (texts, options = {}) => ipcRenderer.invoke("room:aiEmbed", texts, options),
    rerank: (query, documents, options = {}) => ipcRenderer.invoke("room:aiRerank", query, documents, options),
    intuition: (state, questions, options = {}) => ipcRenderer.invoke("room:aiIntuition", state, questions, options),
    getCapabilities: () => ipcRenderer.invoke("room:aiGetCapabilities"),
    listModels: () => ipcRenderer.invoke("room:aiListModels"),
    getSelection: () => ipcRenderer.invoke("room:aiGetSelection"),
    getSlotDefinitions: () => ipcRenderer.invoke("room:aiGetSlotDefinitions"),
    getSlots: () => ipcRenderer.invoke("room:aiGetSlots"),
    selectSlot: (slot, profileId) => ipcRenderer.invoke("room:aiSelectSlot", slot, profileId),
    clearSlot: (slot) => ipcRenderer.invoke("room:aiClearSlot", slot),
    selectModel: (profileId) => ipcRenderer.invoke("room:aiSelectModel", profileId),
    generate: generateAi,
    cancel: (requestId) => ipcRenderer.invoke("room:aiCancel", requestId),
    batch: (requests, options = {}) => ipcRenderer.invoke("room:aiBatch", requests, options),
    onModelsChanged: (callback) => {
      if (typeof callback !== "function") throw new TypeError("模型目录监听器必须是函数");
      const listener = () => callback();
      ipcRenderer.on("room:aiModelsChanged", listener);
      return () => ipcRenderer.removeListener("room:aiModelsChanged", listener);
    }
  }),
  credentials: Object.freeze({
    list: () => ipcRenderer.invoke("room:credentialList")
  }),
  network: Object.freeze({
    getStatus: () => ipcRenderer.invoke("room:networkGetStatus"),
    request: (options) => ipcRenderer.invoke("room:networkRequest", options),
    open: (options) => ipcRenderer.invoke("room:networkOpen", options),
    read: (token, options = {}) => ipcRenderer.invoke("room:networkRead", token, options),
    close: (token) => ipcRenderer.invoke("room:networkClose", token),
    onStatusChanged: (callback) => {
      if (typeof callback !== "function") throw new TypeError("联网状态监听器必须是函数");
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("room:networkStatusChanged", listener);
      return () => ipcRenderer.removeListener("room:networkStatusChanged", listener);
    }
  }),
  browser: Object.freeze({
    getState: () => ipcRenderer.invoke("room:browserGetState"),
    createTab: (input = "") => ipcRenderer.invoke("room:browserCreateTab", input),
    closeTab: (tabId) => ipcRenderer.invoke("room:browserCloseTab", tabId),
    activateTab: (tabId) => ipcRenderer.invoke("room:browserActivateTab", tabId),
    navigate: (tabId, input) => ipcRenderer.invoke("room:browserNavigate", tabId, input),
    goBack: (tabId) => ipcRenderer.invoke("room:browserGoBack", tabId),
    goForward: (tabId) => ipcRenderer.invoke("room:browserGoForward", tabId),
    reload: (tabId) => ipcRenderer.invoke("room:browserReload", tabId),
    stop: (tabId) => ipcRenderer.invoke("room:browserStop", tabId),
    setViewport: (bounds) => ipcRenderer.invoke("room:browserSetViewport", bounds),
    clearData: (options = {}) => ipcRenderer.invoke("room:browserClearData", options),
    respondToPermission: (requestId, allowed) => ipcRenderer.invoke("room:browserRespondPermission", requestId, allowed),
    onStateChanged: (callback) => {
      if (typeof callback !== "function") throw new TypeError("浏览器状态监听器必须是函数");
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("room:browserStateChanged", listener);
      return () => ipcRenderer.removeListener("room:browserStateChanged", listener);
    },
    onDownload: (callback) => {
      if (typeof callback !== "function") throw new TypeError("浏览器下载监听器必须是函数");
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("room:browserDownload", listener);
      return () => ipcRenderer.removeListener("room:browserDownload", listener);
    },
    onPermissionRequest: (callback) => {
      if (typeof callback !== "function") throw new TypeError("网站权限监听器必须是函数");
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("room:browserPermissionRequest", listener);
      return () => ipcRenderer.removeListener("room:browserPermissionRequest", listener);
    }
  })
}));
