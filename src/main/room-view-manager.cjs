"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { BrowserWindow, WebContentsView, screen, Menu } = require("electron");
const { activateWindow } = require("./window-activation.cjs");

const WINDOW_STATE_FORMAT = "0.1";

function windowUsable(window) {
  return Boolean(window) && (typeof window.isDestroyed !== "function" || !window.isDestroyed());
}

function webContentsUsable(view) {
  const webContents = view?.webContents;
  return Boolean(webContents) && (typeof webContents.isDestroyed !== "function" || !webContents.isDestroyed());
}

function normalizeBounds(input) {
  if (!input || typeof input !== "object") return null;
  const bounds = {
    x: Math.round(Number(input.x)),
    y: Math.round(Number(input.y)),
    width: Math.round(Number(input.width)),
    height: Math.round(Number(input.height))
  };
  if (!Object.values(bounds).every(Number.isFinite)) return null;
  if (bounds.x < -100000 || bounds.x > 100000 || bounds.y < -100000 || bounds.y > 100000) return null;
  if (bounds.width < 480 || bounds.width > 8000 || bounds.height < 320 || bounds.height > 8000) return null;
  return bounds;
}

class RoomViewManager {
  constructor(mainWindow, roomStore, roomProtocolHandler, {
    ViewClass = WebContentsView,
    WindowClass = BrowserWindow,
    screenApi = screen,
    onWindowStateChange = () => {},
    windowStatePath = path.join(roomStore.dataRoot || ".", "room-window-state.json")
  } = {}) {
    this.mainWindow = mainWindow;
    this.roomStore = roomStore;
    this.roomProtocolHandler = roomProtocolHandler;
    this.ViewClass = ViewClass;
    this.WindowClass = WindowClass;
    this.screenApi = screenApi;
    this.onWindowStateChange = onWindowStateChange;
    this.windowStatePath = windowStatePath;
    this.views = new Map();
    this.detachedWindows = new Map();
    this.senderRooms = new Map();
    this.windowBounds = new Map();
    this.activeRoomId = null;
    this.viewport = { x: 296, y: 80, width: 900, height: 700 };
    this.persistTimer = null;
    this.persistQueue = Promise.resolve();
    this.isDestroying = false;
    this.browserService = null;
  }

  setBrowserService(browserService) {
    this.browserService = browserService || null;
  }

  async init() {
    try {
      const stored = JSON.parse(await fsp.readFile(this.windowStatePath, "utf8"));
      if (stored?.formatVersion === WINDOW_STATE_FORMAT && stored.rooms && typeof stored.rooms === "object") {
        for (const [roomId, bounds] of Object.entries(stored.rooms)) {
          const normalized = normalizeBounds(bounds);
          if (normalized && roomId.length <= 200) this.windowBounds.set(roomId, normalized);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("读取房间独立窗口状态失败", error);
    }
    return this;
  }

  getRoomIdForSender(senderId) {
    return this.senderRooms.get(senderId) ?? null;
  }

  getDialogParent(roomId) {
    // Resolve at invocation time: the same view can move between windows.
    const window = this.detachedWindows.get(roomId)?.window || this.mainWindow;
    if (!webContentsUsable(this.views.get(roomId)) || !windowUsable(window)) {
      throw new Error("房间窗口已关闭，请重新打开房间后再试");
    }
    return window;
  }

  getWindowStates() {
    return [...this.detachedWindows.keys()].map((roomId) => ({ roomId, mode: "detached" }));
  }

  emitWindowState(roomId, mode, reason) {
    try { this.onWindowStateChange({ roomId, mode, reason }); } catch (error) { console.error("同步房间窗口状态失败", error); }
  }

  setViewport(input) {
    if (!input || typeof input !== "object") return;
    const bounds = {
      x: Math.max(0, Math.round(Number(input.x) || 0)),
      y: Math.max(0, Math.round(Number(input.y) || 0)),
      width: Math.max(100, Math.round(Number(input.width) || 100)),
      height: Math.max(100, Math.round(Number(input.height) || 100))
    };
    this.viewport = bounds;
    const active = this.views.get(this.activeRoomId);
    if (active && !this.detachedWindows.has(this.activeRoomId)) active.setBounds(bounds);
    if (this.activeRoomId) this.browserService?.showRoom(this.activeRoomId);
  }

  createView(roomId) {
    const partitionHash = crypto.createHash("sha256").update(roomId).digest("hex").slice(0, 20);
    const view = new this.ViewClass({
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "room-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: `room-${partitionHash}`
      }
    });
    const webContents = view.webContents;
    const senderId = webContents.id;
    view.setBackgroundColor("#f4f7f5");
    webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    webContents.on("will-navigate", (event, targetUrl) => {
      try {
        const parsed = new URL(targetUrl);
        if (parsed.protocol !== "room:" || parsed.hostname !== roomId) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    webContents.session.setPermissionCheckHandler(() => false);
    if (!webContents.session.protocol.isProtocolHandled("room")) {
      webContents.session.protocol.handle("room", this.roomProtocolHandler);
    }
    webContents.on("destroyed", () => {
      this.browserService?.destroyRoom(roomId);
      this.senderRooms.delete(senderId);
      this.views.delete(roomId);
      if (this.activeRoomId === roomId) this.activeRoomId = null;
      const detached = this.detachedWindows.get(roomId);
      if (detached) {
        this.detachedWindows.delete(roomId);
        detached.allowClose = true;
        if (windowUsable(detached.window)) detached.window.destroy();
      }
    });
    this.senderRooms.set(senderId, roomId);
    this.views.set(roomId, view);
    return view;
  }

  async ensureViewLoaded(roomId, room) {
    await this.roomStore.assertRoomCompatible(roomId);
    let view = this.views.get(roomId);
    if (!webContentsUsable(view)) view = this.createView(roomId);
    const expectedUrl = `room://${roomId}/${room.entry}`;
    if (view.webContents.getURL() !== expectedUrl) await view.webContents.loadURL(expectedUrl);
    return view;
  }

  async open(roomId) {
    const room = this.roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    const detached = this.detachedWindows.get(roomId);
    if (detached && windowUsable(detached.window)) {
      this.focusDetached(roomId);
      return { ...room, windowMode: "detached" };
    }
    this.hide();
    const view = await this.ensureViewLoaded(roomId, room);
    this.mainWindow.contentView.addChildView(view);
    view.setBounds(this.viewport);
    this.activeRoomId = roomId;
    view.webContents.focus();
    this.browserService?.showRoom(roomId);
    return { ...room, windowMode: "attached" };
  }

  hide() {
    if (!this.activeRoomId) return;
    const roomId = this.activeRoomId;
    this.browserService?.hideRoom(roomId);
    const current = this.views.get(roomId);
    if (webContentsUsable(current) && !this.detachedWindows.has(roomId)) {
      try { this.mainWindow.contentView.removeChildView(current); } catch {}
    }
    this.activeRoomId = null;
  }

  cursorOutsideMainWindow() {
    if (!windowUsable(this.mainWindow) || typeof this.mainWindow.getBounds !== "function") return true;
    const point = this.screenApi?.getCursorScreenPoint?.();
    if (!point) return true;
    const bounds = this.mainWindow.getBounds();
    return point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height;
  }

  clampToDisplay(bounds) {
    const normalized = normalizeBounds(bounds) || { x: 80, y: 80, width: 1000, height: 720 };
    const display = this.screenApi?.getDisplayMatching?.(normalized);
    const area = display?.workArea;
    if (!area) return normalized;
    const width = Math.min(normalized.width, area.width);
    const height = Math.min(normalized.height, area.height);
    return {
      width,
      height,
      x: Math.min(Math.max(normalized.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(normalized.y, area.y), area.y + area.height - height)
    };
  }

  detachedBounds(roomId, fromDrag) {
    const stored = this.windowBounds.get(roomId);
    if (stored) return this.clampToDisplay(stored);
    const main = windowUsable(this.mainWindow) && typeof this.mainWindow.getBounds === "function"
      ? this.mainWindow.getBounds()
      : { x: 20, y: 20, width: 1200, height: 800 };
    const width = Math.max(720, Math.min(1180, main.width - 120));
    const height = Math.max(520, Math.min(820, main.height - 100));
    const cursor = fromDrag ? this.screenApi?.getCursorScreenPoint?.() : null;
    return this.clampToDisplay({
      width,
      height,
      x: cursor ? cursor.x - Math.round(width / 2) : main.x + 70,
      y: cursor ? cursor.y - 24 : main.y + 70
    });
  }

  resizeDetached(record) {
    if (!windowUsable(record.window) || !webContentsUsable(record.view)) return;
    const content = record.window.getContentBounds?.() || record.window.getBounds?.() || { width: 800, height: 600 };
    record.view.setBounds({ x: 0, y: 0, width: Math.max(100, content.width), height: Math.max(100, content.height) });
    const roomId = this.getRoomIdForSender(record.view.webContents?.id);
    if (roomId) this.browserService?.showRoom(roomId);
  }

  captureDetachedBounds(roomId, record) {
    if (!windowUsable(record.window) || typeof record.window.getBounds !== "function") return;
    const bounds = normalizeBounds(record.window.getBounds());
    if (!bounds) return;
    this.windowBounds.set(roomId, bounds);
    this.schedulePersist();
  }

  schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistWindowStates().catch((error) => console.error("保存房间独立窗口状态失败", error));
    }, 250);
    this.persistTimer.unref?.();
  }

  async persistWindowStates() {
    const payload = {
      formatVersion: WINDOW_STATE_FORMAT,
      rooms: Object.fromEntries(this.windowBounds)
    };
    this.persistQueue = this.persistQueue.then(async () => {
      await fsp.mkdir(path.dirname(this.windowStatePath), { recursive: true });
      const temporaryPath = `${this.windowStatePath}.tmp`;
      await fsp.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fsp.rename(temporaryPath, this.windowStatePath);
    });
    return this.persistQueue;
  }

  focusDetached(roomId) {
    const record = this.detachedWindows.get(roomId);
    return record ? activateWindow(record.window, record.view?.webContents) : false;
  }

  async detach(roomId, { force = false, fromDrag = false } = {}) {
    const room = this.roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    const existing = this.detachedWindows.get(roomId);
    if (existing && windowUsable(existing.window)) {
      this.focusDetached(roomId);
      return { roomId, mode: "detached", detached: false };
    }
    if (!force && !this.cursorOutsideMainWindow()) return { roomId, mode: "attached", detached: false };
    const view = await this.ensureViewLoaded(roomId, room);
    this.browserService?.hideRoom(roomId);
    if (this.activeRoomId === roomId) this.hide();
    else {
      try { this.mainWindow.contentView.removeChildView(view); } catch {}
    }
    const bounds = this.detachedBounds(roomId, fromDrag);
    const detachedWindow = new this.WindowClass({
      ...bounds,
      minWidth: 480,
      minHeight: 320,
      show: false,
      title: `${room.name} · 智变房间`,
      backgroundColor: "#07120e",
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    });
    if (Menu?.buildFromTemplate) {
      detachedWindow.setMenu?.(Menu.buildFromTemplate([
        { label: "合并回工作台", click: () => this.dock(roomId).catch((error) => console.error("合并房间失败", error)) },
        { label: "关闭房间", click: () => this.close(roomId) }
      ]));
      detachedWindow.setAutoHideMenuBar?.(false);
      detachedWindow.setMenuBarVisibility?.(true);
    }
    detachedWindow.webContents?.setWindowOpenHandler?.(() => ({ action: "deny" }));
    detachedWindow.webContents?.on?.("will-navigate", (event) => event.preventDefault());
    const record = { window: detachedWindow, view, allowClose: false };
    this.detachedWindows.set(roomId, record);
    detachedWindow.contentView.addChildView(view);
    this.resizeDetached(record);
    detachedWindow.on("resize", () => {
      this.resizeDetached(record);
      this.captureDetachedBounds(roomId, record);
    });
    detachedWindow.on("move", () => this.captureDetachedBounds(roomId, record));
    detachedWindow.on("close", (event) => {
      if (record.allowClose || this.isDestroying) return;
      event.preventDefault();
      this.dock(roomId, { reason: "window-close" }).catch((error) => {
        console.error("收回独立房间窗口失败", error);
        this.close(roomId);
      });
    });
    detachedWindow.on("closed", () => {
      if (this.detachedWindows.get(roomId) !== record) return;
      this.detachedWindows.delete(roomId);
      if (!this.isDestroying && webContentsUsable(view) && windowUsable(this.mainWindow)) {
        this.attachToMain(roomId, view);
        this.emitWindowState(roomId, "attached", "window-closed");
      } else if (webContentsUsable(view)) {
        view.webContents.close();
      }
    });
    this.focusDetached(roomId);
    this.browserService?.showRoom(roomId);
    this.emitWindowState(roomId, "detached", fromDrag ? "drag" : "button");
    return { roomId, mode: "detached", detached: true };
  }

  attachToMain(roomId, view) {
    this.hide();
    this.browserService?.hideRoom(roomId);
    this.mainWindow.contentView.addChildView(view);
    view.setBounds(this.viewport);
    this.activeRoomId = roomId;
    view.webContents.focus();
    if (typeof this.mainWindow.isMinimized === "function" && this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show?.();
    this.mainWindow.focus?.();
    this.browserService?.showRoom(roomId);
  }

  async dock(roomId, { reason = "button" } = {}) {
    const record = this.detachedWindows.get(roomId);
    if (!record) {
      const room = this.roomStore.getRoom(roomId);
      if (!room) throw new Error("房间不存在");
      return { roomId, mode: "attached", docked: false };
    }
    this.captureDetachedBounds(roomId, record);
    this.browserService?.hideRoom(roomId);
    record.allowClose = true;
    try { record.window.contentView.removeChildView(record.view); } catch {}
    this.detachedWindows.delete(roomId);
    if (windowUsable(record.window)) record.window.destroy();
    if (!windowUsable(this.mainWindow)) {
      if (webContentsUsable(record.view)) record.view.webContents.close();
      return { roomId, mode: "closed", docked: false };
    }
    this.attachToMain(roomId, record.view);
    this.emitWindowState(roomId, "attached", reason);
    return { roomId, mode: "attached", docked: true };
  }

  close(roomId) {
    this.browserService?.destroyRoom(roomId);
    const view = this.views.get(roomId);
    const detached = this.detachedWindows.get(roomId);
    if (detached) {
      this.captureDetachedBounds(roomId, detached);
      detached.allowClose = true;
      try { detached.window.contentView.removeChildView(detached.view); } catch {}
      this.detachedWindows.delete(roomId);
      if (windowUsable(detached.window)) detached.window.destroy();
    }
    if (!view) return;
    const webContents = view.webContents;
    if (this.activeRoomId === roomId) this.hide();
    else if (!detached) {
      try { this.mainWindow.contentView.removeChildView(view); } catch {}
    }
    if (webContents) this.senderRooms.delete(webContents.id);
    this.views.delete(roomId);
    if (webContents && !webContents.isDestroyed()) webContents.close();
    this.emitWindowState(roomId, "closed", "close-room");
  }

  destroyAll() {
    this.isDestroying = true;
    for (const roomId of [...this.views.keys()]) this.close(roomId);
    this.isDestroying = false;
  }

  async dispose() {
    this.destroyAll();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistWindowStates();
  }
}

module.exports = { RoomViewManager, WINDOW_STATE_FORMAT, normalizeBounds };
