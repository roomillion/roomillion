"use strict";

const crypto = require("node:crypto");
const { dialog, session, WebContentsView } = require("electron");

const MAX_BROWSER_TABS = Number.MAX_SAFE_INTEGER;
const MAX_BROWSER_INPUT_LENGTH = 64 * 1024;
const SITE_PERMISSION_TIMEOUT_MS = 30_000;
const SUPPORTED_SITE_PERMISSIONS = new Set([
  "media",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "midi",
  "pointerLock",
  "idle-detection"
]);
const SITE_PERMISSION_LABELS = Object.freeze({
  media: "摄像头或麦克风",
  geolocation: "位置信息",
  notifications: "系统通知",
  "clipboard-read": "读取剪贴板",
  "clipboard-sanitized-write": "写入剪贴板",
  midi: "MIDI 设备",
  pointerLock: "锁定鼠标指针",
  "idle-detection": "设备空闲状态"
});

function isUsable(value) {
  return Boolean(value) && (typeof value.isDestroyed !== "function" || !value.isDestroyed());
}

function cleanText(value, maximum = 300) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

function assertTabId(tabId) {
  if (typeof tabId !== "string" || !/^[a-f0-9]{16}$/.test(tabId)) throw new Error("浏览器标签 ID 无效");
  return tabId;
}

function normalizeBrowserInput(input) {
  const value = cleanText(input, MAX_BROWSER_INPUT_LENGTH);
  if (!value) throw new Error("请输入网址或搜索内容");
  let candidate = value;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    const looksLikeAddress = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[^\s/]+\.[^\s/]+)(?::\d+)?(?:[/?#]|$)/i.test(candidate);
    candidate = looksLikeAddress
      ? `https://${candidate}`
      : `https://www.baidu.com/s?wd=${encodeURIComponent(candidate)}`;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("网址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("浏览器只允许 HTTP 和 HTTPS 地址");
  if (parsed.username || parsed.password) throw new Error("网址不能包含用户名或密码");
  if (parsed.href.length > MAX_BROWSER_INPUT_LENGTH * 3) throw new Error("网址过长");
  return parsed.href;
}

function normalizeViewport(input) {
  if (!input || typeof input !== "object") throw new Error("浏览器显示区域无效");
  const bounds = {
    x: Math.round(Number(input.x)),
    y: Math.round(Number(input.y)),
    width: Math.round(Number(input.width)),
    height: Math.round(Number(input.height))
  };
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error("浏览器显示区域无效");
  if (bounds.x < 0 || bounds.y < 0 || bounds.x > 8000 || bounds.y > 8000) throw new Error("浏览器显示区域超出房间");
  if (bounds.width < 100 || bounds.height < 100 || bounds.width > 8000 || bounds.height > 8000) {
    throw new Error("浏览器显示区域尺寸无效");
  }
  return bounds;
}

function historyApi(webContents) {
  return webContents?.navigationHistory || webContents;
}

function navigationFlag(webContents, method) {
  try {
    const target = historyApi(webContents);
    return Boolean(target && typeof target[method] === "function" && target[method]());
  } catch {
    return false;
  }
}

function browserPartition(roomId) {
  const partitionHash = crypto.createHash("sha256").update(roomId).digest("hex").slice(0, 20);
  return `persist:zhibian-browser-${partitionHash}`;
}

class RoomBrowserService {
  constructor({
    mainWindow,
    roomStore,
    roomViews,
    networkService,
    ViewClass = WebContentsView,
    dialogApi = dialog,
    sessionApi = session
  }) {
    this.mainWindow = mainWindow;
    this.roomStore = roomStore;
    this.roomViews = roomViews;
    this.networkService = networkService;
    this.ViewClass = ViewClass;
    this.dialog = dialogApi;
    this.sessionApi = sessionApi;
    this.rooms = new Map();
    this.guestOwners = new Map();
    this.pendingPermissionRequests = new Map();
  }

  roomRecord(roomId) {
    let record = this.rooms.get(roomId);
    if (!record) {
      record = {
        roomId,
        tabs: new Map(),
        activeTabId: null,
        viewport: null,
        browserSession: null,
        sessionConfigured: false,
        downloadListener: null,
        downloads: new Set(),
        siteGrants: new Set()
      };
      this.rooms.set(roomId, record);
    }
    return record;
  }

  requireRoom(roomId, capability = "navigate") {
    const room = this.roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    if (!this.roomStore.hasPermission(roomId, "browser", capability)) {
      throw new Error(capability === "download" ? "房间没有浏览器下载权限" : "房间没有浏览网页权限");
    }
    return room;
  }

  networkAllowed() {
    return this.networkService.getPublicState().roomNetworkEnabled === true;
  }

  publicTab(tab) {
    const webContents = tab.view?.webContents;
    return Object.freeze({
      id: tab.id,
      title: cleanText(tab.title, 120) || "新标签页",
      url: cleanText(tab.url, MAX_BROWSER_INPUT_LENGTH * 3),
      loading: Boolean(tab.loading),
      canGoBack: isUsable(webContents) && navigationFlag(webContents, "canGoBack"),
      canGoForward: isUsable(webContents) && navigationFlag(webContents, "canGoForward"),
      crashed: Boolean(tab.crashed),
      error: tab.error ? cleanText(tab.error, 300) : null
    });
  }

  getState(roomId) {
    const room = this.roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    const record = this.roomRecord(roomId);
    return Object.freeze({
      roomId,
      activeTabId: record.activeTabId,
      tabs: Object.freeze([...record.tabs.values()].map((tab) => this.publicTab(tab))),
      networkAllowed: this.networkAllowed(),
      permissions: Object.freeze({
        navigate: this.roomStore.hasPermission(roomId, "browser", "navigate"),
        download: this.roomStore.hasPermission(roomId, "browser", "download")
      }),
      maximumTabs: MAX_BROWSER_TABS
    });
  }

  ownerWebContents(roomId) {
    const owner = this.roomViews.views.get(roomId)?.webContents;
    return isUsable(owner) ? owner : null;
  }

  emitState(roomId) {
    const owner = this.ownerWebContents(roomId);
    if (owner) owner.send("room:browserStateChanged", this.getState(roomId));
  }

  emitDownload(roomId, payload) {
    const owner = this.ownerWebContents(roomId);
    if (owner) owner.send("room:browserDownload", Object.freeze({ ...payload, roomId }));
  }

  activeTab(record) {
    return record.activeTabId ? record.tabs.get(record.activeTabId) || null : null;
  }

  createTab(roomId, input = "") {
    this.requireRoom(roomId);
    const record = this.roomRecord(roomId);
    const id = crypto.randomBytes(8).toString("hex");
    record.tabs.set(id, {
      id,
      title: "新标签页",
      url: "",
      loading: false,
      crashed: false,
      error: null,
      view: null,
      parent: null
    });
    record.activeTabId = id;
    this.syncRoom(roomId);
    this.emitState(roomId);
    if (cleanText(input)) return this.navigate(roomId, id, input);
    return this.getState(roomId);
  }

  configureSession(record, browserSession) {
    if (!browserSession || record.sessionConfigured) return;
    record.browserSession = browserSession;
    record.sessionConfigured = true;
    browserSession.webRequest?.onBeforeRequest?.(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, callback) => {
        const allowed = this.networkAllowed() && this.roomStore.hasPermission(record.roomId, "browser", "navigate");
        callback({ cancel: !allowed });
      }
    );
    browserSession.setPermissionCheckHandler?.((_webContents, permission, requestingOrigin) => {
      if (permission === "fullscreen") return true;
      const origin = this.safeOrigin(requestingOrigin);
      return Boolean(origin && record.siteGrants.has(`${origin}|${permission}`));
    });
    browserSession.setPermissionRequestHandler?.((webContents, permission, callback, details = {}) => {
      if (permission === "fullscreen") return callback(true);
      if (!SUPPORTED_SITE_PERMISSIONS.has(permission)) return callback(false);
      const owner = this.guestOwners.get(webContents?.id);
      if (!owner || owner.roomId !== record.roomId) return callback(false);
      const requestingUrl = details.requestingUrl || webContents?.getURL?.() || "";
      const origin = this.safeOrigin(requestingUrl);
      if (!origin || !this.networkAllowed()) return callback(false);
      const grantKey = `${origin}|${permission}`;
      if (record.siteGrants.has(grantKey)) return callback(true);
      if ([...this.pendingPermissionRequests.values()].some((entry) => entry.roomId === record.roomId)) return callback(false);
      const requestId = crypto.randomBytes(12).toString("hex");
      const timer = setTimeout(() => this.resolvePermissionRequest(requestId, false), SITE_PERMISSION_TIMEOUT_MS);
      timer.unref?.();
      this.pendingPermissionRequests.set(requestId, { requestId, roomId: record.roomId, origin, permission, callback, timer });
      const roomOwner = this.ownerWebContents(record.roomId);
      if (!roomOwner) return this.resolvePermissionRequest(requestId, false);
      roomOwner.send("room:browserPermissionRequest", Object.freeze({
        requestId,
        origin,
        permission,
        label: SITE_PERMISSION_LABELS[permission] || "网站权限"
      }));
    });
    record.downloadListener = (event, item, webContents) => {
      const owner = this.guestOwners.get(webContents?.id);
      if (!owner || owner.roomId !== record.roomId) return;
      if (!this.roomStore.hasPermission(record.roomId, "browser", "download") || !this.networkAllowed()) {
        event.preventDefault();
        this.emitDownload(record.roomId, { status: "blocked", filename: cleanText(item.getFilename?.(), 180), message: "下载未获授权或工作台联网已关闭" });
        return;
      }
      record.downloads.add(item);
      item.once?.("done", () => record.downloads.delete(item));
      item.pause?.();
      this.chooseDownloadPath(record.roomId, item).catch((error) => {
        item.cancel?.();
        this.emitDownload(record.roomId, { status: "failed", filename: cleanText(item.getFilename?.(), 180), message: cleanText(error.message, 240) });
      });
    };
    browserSession.on?.("will-download", record.downloadListener);
  }

  safeOrigin(value) {
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  async chooseDownloadPath(roomId, item) {
    const filename = cleanText(item.getFilename?.(), 180) || "download";
    const parent = this.roomViews.detachedWindows.get(roomId)?.window || this.mainWindow;
    const result = await this.dialog.showSaveDialog(parent, {
      title: "保存网页下载",
      defaultPath: filename,
      buttonLabel: "保存"
    });
    if (result.canceled || !result.filePath) {
      item.cancel?.();
      this.emitDownload(roomId, { status: "canceled", filename });
      return;
    }
    item.setSavePath?.(result.filePath);
    this.emitDownload(roomId, { status: "started", filename });
    item.on?.("updated", (_event, state) => {
      this.emitDownload(roomId, {
        status: state === "interrupted" ? "interrupted" : "progressing",
        filename,
        receivedBytes: Number(item.getReceivedBytes?.() || 0),
        totalBytes: Number(item.getTotalBytes?.() || 0),
        paused: Boolean(item.isPaused?.())
      });
    });
    item.once?.("done", (_event, state) => {
      this.emitDownload(roomId, {
        status: state === "completed" ? "completed" : state,
        filename,
        savePath: state === "completed" ? result.filePath : null
      });
    });
    item.resume?.();
  }

  createGuestView(record, tab) {
    const view = new this.ViewClass({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        partition: browserPartition(record.roomId)
      }
    });
    tab.view = view;
    const webContents = view.webContents;
    view.setBackgroundColor?.("#ffffff");
    this.guestOwners.set(webContents.id, { roomId: record.roomId, tabId: tab.id });
    this.configureSession(record, webContents.session);
    webContents.setWindowOpenHandler?.(({ url }) => {
      if (this.safeOrigin(url) && record.tabs.size < MAX_BROWSER_TABS) {
        Promise.resolve(this.createTab(record.roomId, url)).catch(() => {});
      }
      return { action: "deny" };
    });
    const preventUnsupportedNavigation = (event, targetUrl) => {
      if (!this.safeOrigin(targetUrl)) event.preventDefault();
    };
    webContents.on?.("will-navigate", preventUnsupportedNavigation);
    webContents.on?.("will-redirect", preventUnsupportedNavigation);
    webContents.on?.("did-start-loading", () => {
      tab.loading = true;
      tab.error = null;
      this.refreshTabFromWebContents(record, tab);
    });
    webContents.on?.("did-stop-loading", () => {
      tab.loading = false;
      this.refreshTabFromWebContents(record, tab);
    });
    webContents.on?.("did-navigate", (_event, url) => {
      tab.url = this.safeOrigin(url) ? url : tab.url;
      this.refreshTabFromWebContents(record, tab);
    });
    webContents.on?.("did-navigate-in-page", (_event, url) => {
      tab.url = this.safeOrigin(url) ? url : tab.url;
      this.refreshTabFromWebContents(record, tab);
    });
    webContents.on?.("page-title-updated", (event, title) => {
      event.preventDefault?.();
      tab.title = cleanText(title, 120) || tab.title;
      this.refreshTabFromWebContents(record, tab);
    });
    webContents.on?.("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) return;
      tab.loading = false;
      tab.error = `${cleanText(errorDescription, 180)} (${Number(errorCode)})`;
      if (this.safeOrigin(validatedUrl)) tab.url = validatedUrl;
      this.refreshTabFromWebContents(record, tab);
    });
    webContents.on?.("render-process-gone", () => {
      tab.loading = false;
      tab.crashed = true;
      tab.error = "网页渲染进程意外退出，可点击刷新重试";
      this.refreshTabFromWebContents(record, tab);
    });
    webContents.on?.("destroyed", () => {
      this.guestOwners.delete(webContents.id);
      if (tab.view === view) {
        tab.view = null;
        tab.parent = null;
      }
    });
    return view;
  }

  refreshTabFromWebContents(record, tab) {
    const webContents = tab.view?.webContents;
    if (isUsable(webContents)) {
      const url = webContents.getURL?.();
      if (this.safeOrigin(url)) tab.url = url;
      tab.title = cleanText(webContents.getTitle?.(), 120) || tab.title;
    }
    this.emitState(record.roomId);
  }

  async navigate(roomId, tabId, input) {
    this.requireRoom(roomId);
    if (!this.networkAllowed()) throw new Error("主工作台尚未允许房间联网");
    const record = this.roomRecord(roomId);
    const tab = record.tabs.get(assertTabId(tabId));
    if (!tab) throw new Error("浏览器标签不存在");
    const url = normalizeBrowserInput(input);
    if (!isUsable(tab.view?.webContents)) this.createGuestView(record, tab);
    tab.url = url;
    tab.title = "正在加载…";
    tab.loading = true;
    tab.crashed = false;
    tab.error = null;
    record.activeTabId = tab.id;
    this.syncRoom(roomId);
    this.emitState(roomId);
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      tab.loading = false;
      tab.error = cleanText(error.message, 300);
      this.emitState(roomId);
    }
    return this.getState(roomId);
  }

  closeTab(roomId, tabId) {
    this.requireRoom(roomId);
    const record = this.roomRecord(roomId);
    const tab = record.tabs.get(assertTabId(tabId));
    if (!tab) return this.getState(roomId);
    this.destroyTab(record, tab);
    record.tabs.delete(tab.id);
    if (record.activeTabId === tab.id) record.activeTabId = [...record.tabs.keys()].at(-1) || null;
    this.syncRoom(roomId);
    this.emitState(roomId);
    return this.getState(roomId);
  }

  activateTab(roomId, tabId) {
    this.requireRoom(roomId);
    const record = this.roomRecord(roomId);
    if (!record.tabs.has(assertTabId(tabId))) throw new Error("浏览器标签不存在");
    record.activeTabId = tabId;
    this.syncRoom(roomId);
    this.emitState(roomId);
    return this.getState(roomId);
  }

  async navigationAction(roomId, tabId, action) {
    this.requireRoom(roomId);
    const record = this.roomRecord(roomId);
    const tab = record.tabs.get(assertTabId(tabId));
    const webContents = tab?.view?.webContents;
    if (!tab) return this.getState(roomId);
    if (!isUsable(webContents)) {
      if (action === "reload" && tab.url) return this.navigate(roomId, tabId, tab.url);
      return this.getState(roomId);
    }
    const target = historyApi(webContents);
    if (action === "goBack" && navigationFlag(webContents, "canGoBack")) target.goBack();
    else if (action === "goForward" && navigationFlag(webContents, "canGoForward")) target.goForward();
    else if (action === "reload") {
      tab.crashed = false;
      tab.error = null;
      webContents.reload();
    } else if (action === "stop") webContents.stop();
    return this.getState(roomId);
  }

  setViewport(roomId, input) {
    this.requireRoom(roomId);
    const record = this.roomRecord(roomId);
    record.viewport = normalizeViewport(input);
    this.syncRoom(roomId);
    return this.getState(roomId);
  }

  visibleParent(roomId) {
    const detached = this.roomViews.detachedWindows.get(roomId);
    if (detached && isUsable(detached.window)) return detached.window;
    if (this.roomViews.activeRoomId === roomId && isUsable(this.mainWindow)) return this.mainWindow;
    return null;
  }

  baseBounds(roomId) {
    const detached = this.roomViews.detachedWindows.get(roomId);
    if (detached && isUsable(detached.window)) {
      const content = detached.window.getContentBounds?.() || detached.window.getBounds?.();
      if (content) return { x: 0, y: 0, width: content.width, height: content.height };
    }
    return this.roomViews.viewport;
  }

  detachTabView(tab) {
    if (!tab?.view || !tab.parent) return;
    try { tab.parent.contentView?.removeChildView(tab.view); } catch {}
    tab.parent = null;
  }

  syncRoom(roomId) {
    const record = this.rooms.get(roomId);
    if (!record) return;
    const active = this.activeTab(record);
    for (const tab of record.tabs.values()) {
      if (tab !== active) this.detachTabView(tab);
    }
    const parentWindow = this.visibleParent(roomId);
    if (!active?.view || !record.viewport || !parentWindow?.contentView) {
      if (active) this.detachTabView(active);
      return;
    }
    if (active.parent !== parentWindow) {
      this.detachTabView(active);
      parentWindow.contentView.addChildView(active.view);
      active.parent = parentWindow;
    }
    const base = this.baseBounds(roomId);
    const bounds = {
      x: base.x + record.viewport.x,
      y: base.y + record.viewport.y,
      width: Math.max(100, Math.min(record.viewport.width, base.width - record.viewport.x)),
      height: Math.max(100, Math.min(record.viewport.height, base.height - record.viewport.y))
    };
    active.view.setBounds(bounds);
  }

  hideRoom(roomId) {
    const record = this.rooms.get(roomId);
    if (!record) return;
    for (const tab of record.tabs.values()) this.detachTabView(tab);
  }

  showRoom(roomId) {
    this.syncRoom(roomId);
  }

  async clearData(roomId, options = {}) {
    this.requireRoom(roomId);
    const record = this.roomRecord(roomId);
    const browserSession = record.browserSession || this.sessionApi?.fromPartition?.(browserPartition(roomId));
    if (!browserSession) return { cleared: true, hadSession: false };
    const clearCookies = options.cookies !== false;
    const clearStorage = options.storage !== false;
    const clearCache = options.cache !== false;
    if (clearStorage || clearCookies) {
      const storages = [];
      if (clearCookies) storages.push("cookies");
      if (clearStorage) storages.push("localstorage", "indexdb", "serviceworkers", "cachestorage", "websql");
      await browserSession.clearStorageData({ storages: [...new Set(storages)] });
    }
    if (clearCache) await browserSession.clearCache();
    record.siteGrants.clear();
    return { cleared: true, hadSession: true };
  }

  async clearPersistentData(roomId) {
    const record = this.rooms.get(roomId);
    const browserSession = record?.browserSession || this.sessionApi?.fromPartition?.(browserPartition(roomId));
    if (!browserSession) return { cleared: false };
    await browserSession.clearStorageData();
    await browserSession.clearCache();
    record?.siteGrants.clear();
    return { cleared: true };
  }

  resolvePermissionRequest(requestId, allowed, roomId = null) {
    const entry = this.pendingPermissionRequests.get(requestId);
    if (!entry || (roomId && entry.roomId !== roomId)) return false;
    this.pendingPermissionRequests.delete(requestId);
    clearTimeout(entry.timer);
    if (allowed) this.roomRecord(entry.roomId).siteGrants.add(`${entry.origin}|${entry.permission}`);
    try { entry.callback(Boolean(allowed)); } catch {}
    return true;
  }

  respondToPermission(roomId, requestId, allowed) {
    this.requireRoom(roomId);
    if (typeof requestId !== "string" || !/^[a-f0-9]{24}$/.test(requestId)) throw new Error("网站权限请求 ID 无效");
    if (typeof allowed !== "boolean") throw new Error("网站权限响应无效");
    if (!this.resolvePermissionRequest(requestId, allowed, roomId)) throw new Error("网站权限请求已失效");
    return true;
  }

  handleNetworkPolicyChanged() {
    if (!this.networkAllowed()) {
      for (const record of this.rooms.values()) {
        this.revokeActiveAccess(record, "工作台联网已关闭");
      }
    }
    for (const roomId of this.rooms.keys()) this.emitState(roomId);
  }

  handlePermissionsChanged(roomId) {
    const record = this.rooms.get(roomId);
    if (record && !this.roomStore.hasPermission(roomId, "browser", "navigate")) {
      this.revokeActiveAccess(record, "浏览网页权限已撤销");
    } else if (record && !this.roomStore.hasPermission(roomId, "browser", "download")) {
      for (const item of record.downloads) item.cancel?.();
      record.downloads.clear();
    }
    this.emitState(roomId);
  }

  revokeActiveAccess(record, message) {
    for (const [requestId, entry] of this.pendingPermissionRequests) {
      if (entry.roomId === record.roomId) this.resolvePermissionRequest(requestId, false);
    }
    for (const item of record.downloads) item.cancel?.();
    record.downloads.clear();
    record.siteGrants.clear();
    for (const tab of record.tabs.values()) {
      if (isUsable(tab.view?.webContents)) this.destroyTab(record, tab);
      tab.loading = false;
      tab.error = message;
    }
  }

  destroyTab(_record, tab) {
    this.detachTabView(tab);
    const webContents = tab.view?.webContents;
    if (isUsable(webContents)) {
      this.guestOwners.delete(webContents.id);
      webContents.close();
    }
    tab.view = null;
  }

  destroyRoom(roomId) {
    const record = this.rooms.get(roomId);
    if (!record) return;
    for (const [requestId, entry] of this.pendingPermissionRequests) {
      if (entry.roomId === roomId) this.resolvePermissionRequest(requestId, false);
    }
    for (const item of record.downloads) item.cancel?.();
    record.downloads.clear();
    for (const tab of record.tabs.values()) this.destroyTab(record, tab);
    record.tabs.clear();
    if (record.browserSession) {
      if (record.downloadListener) record.browserSession.off?.("will-download", record.downloadListener);
      record.browserSession.setPermissionRequestHandler?.(null);
      record.browserSession.setPermissionCheckHandler?.(null);
    }
    this.rooms.delete(roomId);
  }

  dispose() {
    for (const roomId of [...this.rooms.keys()]) this.destroyRoom(roomId);
  }
}

module.exports = {
  MAX_BROWSER_TABS,
  RoomBrowserService,
  browserPartition,
  normalizeBrowserInput,
  normalizeViewport
};
