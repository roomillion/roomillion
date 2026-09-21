"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  MAX_BROWSER_TABS,
  RoomBrowserService,
  normalizeBrowserInput,
  normalizeViewport
} = require("../src/main/room-browser-service.cjs");

let nextId = 800;

class FakeContentView {
  constructor() { this.children = new Set(); }
  addChildView(view) { this.children.add(view); }
  removeChildView(view) { this.children.delete(view); }
}

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.webRequest = { onBeforeRequest: (_filter, handler) => { this.requestHandler = handler; } };
  }
  setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; }
  setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
  async clearStorageData(options) { this.clearedStorage = options; }
  async clearCache() { this.cacheCleared = true; }
}

class FakeGuestWebContents extends EventEmitter {
  constructor(session) {
    super();
    this.id = nextId++;
    this.session = session;
    this.url = "";
    this.title = "";
    this.destroyed = false;
    this.loading = false;
    this.navigationHistory = {
      canGoBack: () => this.backCount > 0,
      canGoForward: () => this.forwardCount > 0,
      goBack: () => { this.wentBack = true; },
      goForward: () => { this.wentForward = true; }
    };
  }
  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  async loadURL(url) {
    this.loading = true;
    this.emit("did-start-loading");
    this.url = url;
    this.title = "测试页面";
    this.emit("did-navigate", {}, url);
    this.emit("page-title-updated", { preventDefault() {} }, this.title);
    this.loading = false;
    this.emit("did-stop-loading");
  }
  reload() { this.reloaded = true; }
  stop() { this.stopped = true; this.loading = false; }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit("destroyed"); } }
}

class FakeGuestView {
  static sessions = new Map();
  constructor(options) {
    this.options = options;
    const partition = options.webPreferences.partition;
    if (!FakeGuestView.sessions.has(partition)) FakeGuestView.sessions.set(partition, new FakeSession());
    this.webContents = new FakeGuestWebContents(FakeGuestView.sessions.get(partition));
  }
  setBackgroundColor(color) { this.background = color; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
}

function fixture() {
  FakeGuestView.sessions.clear();
  const roomId = "cn.zhibian.test.browser";
  const permissions = new Set(["navigate", "download"]);
  const roomStore = {
    getRoom: (id) => id === roomId ? { id, name: "浏览器", grantedPermissions: { browser: [...permissions] } } : null,
    hasPermission: (id, domain, value) => id === roomId && domain === "browser" && permissions.has(value)
  };
  const ownerMessages = [];
  const ownerWebContents = { id: 700, isDestroyed: () => false, send: (channel, payload) => ownerMessages.push({ channel, payload }) };
  const mainWindow = { contentView: new FakeContentView(), isDestroyed: () => false };
  const roomViews = {
    views: new Map([[roomId, { webContents: ownerWebContents }]]),
    detachedWindows: new Map(),
    activeRoomId: roomId,
    viewport: { x: 296, y: 80, width: 900, height: 700 }
  };
  const networkState = { roomNetworkEnabled: false };
  const networkService = { getPublicState: () => ({ ...networkState }) };
  const dialogApi = { showSaveDialog: async () => ({ canceled: true }) };
  const service = new RoomBrowserService({ mainWindow, roomStore, roomViews, networkService, ViewClass: FakeGuestView, dialogApi });
  return { service, roomId, permissions, roomViews, mainWindow, networkState, ownerMessages };
}

test("browser input accepts addresses and turns plain text into bounded search URLs", () => {
  assert.equal(normalizeBrowserInput("example.com"), "https://example.com/");
  assert.match(normalizeBrowserInput("千万间 Roomillion"), /^https:\/\/www\.baidu\.com\/s\?wd=/);
  assert.throws(() => normalizeBrowserInput("file:///C:/secret.txt"), /HTTP 和 HTTPS/);
  assert.throws(() => normalizeBrowserInput("https://user:secret@example.com"), /用户名或密码/);
  assert.deepEqual(normalizeViewport({ x: 0, y: 100, width: 800, height: 500 }), { x: 0, y: 100, width: 800, height: 500 });
  assert.throws(() => normalizeViewport({ x: -1, y: 0, width: 800, height: 500 }), /超出房间/);
});

test("browser tabs are isolated, network-gated and reparent with their ordinary room", async () => {
  const { service, roomId, roomViews, mainWindow, networkState } = fixture();
  let state = service.createTab(roomId);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.maximumTabs, MAX_BROWSER_TABS);
  assert.equal(service.rooms.get(roomId).tabs.values().next().value.view, null);
  service.setViewport(roomId, { x: 0, y: 96, width: 900, height: 580 });
  await assert.rejects(() => service.navigate(roomId, state.activeTabId, "example.com"), /尚未允许房间联网/);

  networkState.roomNetworkEnabled = true;
  state = await service.navigate(roomId, state.activeTabId, "example.com");
  const tab = service.rooms.get(roomId).tabs.get(state.activeTabId);
  assert.equal(state.tabs[0].url, "https://example.com/");
  assert.equal(mainWindow.contentView.children.has(tab.view), true);
  assert.deepEqual(tab.view.bounds, { x: 296, y: 176, width: 900, height: 580 });
  assert.equal(tab.view.webContents.session.permissionRequestHandler instanceof Function, true);
  assert.equal(tab.view.options.webPreferences.backgroundThrottling, false);

  const detachedParent = new FakeContentView();
  const detachedWindow = { contentView: detachedParent, isDestroyed: () => false, getContentBounds: () => ({ width: 1000, height: 720 }) };
  roomViews.detachedWindows.set(roomId, { window: detachedWindow });
  service.hideRoom(roomId);
  service.showRoom(roomId);
  assert.equal(mainWindow.contentView.children.has(tab.view), false);
  assert.equal(detachedParent.children.has(tab.view), true);
  assert.equal(tab.parent, detachedWindow);
  assert.deepEqual(tab.view.bounds, { x: 0, y: 96, width: 900, height: 580 });

  roomViews.detachedWindows.delete(roomId);
  service.hideRoom(roomId);
  service.showRoom(roomId);
  assert.equal(mainWindow.contentView.children.has(tab.view), true);
  assert.equal(tab.parent, mainWindow);
  service.destroyRoom(roomId);
  assert.equal(tab.view, null);
});

test("browser permissions, privacy clearing and global network revocation are enforced", async () => {
  const { service, roomId, permissions, networkState, ownerMessages } = fixture();
  networkState.roomNetworkEnabled = true;
  let state = service.createTab(roomId);
  state = await service.navigate(roomId, state.activeTabId, "example.com");
  const record = service.rooms.get(roomId);
  const tab = record.tabs.get(state.activeTabId);
  const browserSession = tab.view.webContents.session;
  await service.clearData(roomId);
  assert.equal(browserSession.cacheCleared, true);
  assert.ok(browserSession.clearedStorage.storages.includes("cookies"));

  let permissionAnswer = null;
  browserSession.permissionRequestHandler(tab.view.webContents, "geolocation", (allowed) => { permissionAnswer = allowed; }, { requestingUrl: "https://example.com/location" });
  const request = ownerMessages.findLast((item) => item.channel === "room:browserPermissionRequest")?.payload;
  assert.ok(request?.requestId);
  service.respondToPermission(roomId, request.requestId, true);
  assert.equal(permissionAnswer, true);
  assert.equal(browserSession.permissionCheckHandler(tab.view.webContents, "geolocation", "https://example.com"), true);

  tab.loading = true;
  const firstGuest = tab.view.webContents;
  networkState.roomNetworkEnabled = false;
  service.handleNetworkPolicyChanged();
  assert.equal(firstGuest.destroyed, true);
  assert.equal(tab.view, null);
  assert.equal(service.getState(roomId).networkAllowed, false);

  networkState.roomNetworkEnabled = true;
  await service.navigationAction(roomId, state.activeTabId, "reload");
  assert.notEqual(tab.view, null);
  assert.notEqual(tab.view.webContents.id, firstGuest.id);
  assert.equal(tab.view.webContents.url, "https://example.com/");

  permissions.delete("navigate");
  service.handlePermissionsChanged(roomId);
  assert.equal(mainWindowHasNoGuest(service, roomId), true);
  assert.throws(() => service.createTab(roomId), /没有浏览网页权限/);
});

function mainWindowHasNoGuest(service, roomId) {
  const record = service.rooms.get(roomId);
  return [...record.tabs.values()].every((tab) => tab.parent === null);
}
