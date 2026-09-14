"use strict";

const { contextBridge, ipcRenderer } = require("electron");

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
  ai: Object.freeze({
    embed: (texts, options = {}) => ipcRenderer.invoke("room:aiEmbed", texts, options),
    listModels: () => ipcRenderer.invoke("room:aiListModels"),
    getSelection: () => ipcRenderer.invoke("room:aiGetSelection"),
    selectModel: (profileId) => ipcRenderer.invoke("room:aiSelectModel", profileId),
    generate: (prompt, options = {}) => ipcRenderer.invoke("room:aiGenerate", prompt, options),
    onModelsChanged: (callback) => {
      if (typeof callback !== "function") throw new TypeError("模型目录监听器必须是函数");
      const listener = () => callback();
      ipcRenderer.on("room:aiModelsChanged", listener);
      return () => ipcRenderer.removeListener("room:aiModelsChanged", listener);
    }
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
