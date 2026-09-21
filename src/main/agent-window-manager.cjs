"use strict";

const { BrowserWindow, screen } = require("electron");
const { activateWindow } = require("./window-activation.cjs");

function windowUsable(window) {
  return Boolean(window) && (typeof window.isDestroyed !== "function" || !window.isDestroyed());
}

class AgentWindowManager {
  constructor(mainWindow, {
    WindowClass = BrowserWindow,
    screenApi = screen,
    preloadPath,
    rendererPath,
    onStateChange = () => {}
  } = {}) {
    this.mainWindow = mainWindow;
    this.WindowClass = WindowClass;
    this.screenApi = screenApi;
    this.preloadPath = preloadPath;
    this.rendererPath = rendererPath;
    this.onStateChange = onStateChange;
    this.window = null;
    this.allowClose = false;
    this.isDestroying = false;
  }

  getState() {
    return { mode: windowUsable(this.window) ? "detached" : "attached" };
  }

  getWorkbenchWindows() {
    return [this.mainWindow, this.window].filter(windowUsable);
  }

  isWorkbenchSender(senderId) {
    return this.getWorkbenchWindows().some((window) => window.webContents?.id === senderId);
  }

  isAgentSender(senderId) {
    return windowUsable(this.window) && this.window.webContents?.id === senderId;
  }

  emitState(mode, reason) {
    try { this.onStateChange({ mode, reason }); } catch (error) { console.error("同步 Agent 窗口状态失败", error); }
  }

  cursorOutsideMainWindow() {
    if (!windowUsable(this.mainWindow) || typeof this.mainWindow.getBounds !== "function") return true;
    const point = this.screenApi?.getCursorScreenPoint?.();
    if (!point) return true;
    const bounds = this.mainWindow.getBounds();
    return point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height;
  }

  focus() {
    return activateWindow(this.window);
  }

  async detach({ force = false, fromDrag = false } = {}) {
    if (this.focus()) return { mode: "detached", detached: false };
    if (!force && !this.cursorOutsideMainWindow()) return { mode: "attached", detached: false };
    const mainBounds = windowUsable(this.mainWindow) && typeof this.mainWindow.getBounds === "function"
      ? this.mainWindow.getBounds()
      : { x: 20, y: 20, width: 1200, height: 800 };
    const width = Math.max(760, Math.min(1240, mainBounds.width - 80));
    const height = Math.max(560, Math.min(880, mainBounds.height - 60));
    const cursor = fromDrag ? this.screenApi?.getCursorScreenPoint?.() : null;
    const detachedWindow = new this.WindowClass({
      x: cursor ? cursor.x - Math.round(width / 2) : mainBounds.x + 48,
      y: cursor ? cursor.y - 28 : mainBounds.y + 38,
      width,
      height,
      minWidth: 680,
      minHeight: 500,
      show: false,
      title: "AI 创建房间 · 千万间 Roomillion",
      backgroundColor: "#f8faf9",
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#f7faf8",
        symbolColor: "#42574e",
        height: 38
      },
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false
      }
    });
    this.window = detachedWindow;
    this.allowClose = false;
    detachedWindow.removeMenu?.();
    detachedWindow.webContents?.setWindowOpenHandler?.(() => ({ action: "deny" }));
    detachedWindow.webContents?.on?.("will-navigate", (event) => event.preventDefault());
    detachedWindow.on("close", (event) => {
      if (this.allowClose || this.isDestroying) return;
      event.preventDefault();
      this.dock({ reason: "window-close" });
    });
    detachedWindow.on("closed", () => {
      if (this.window !== detachedWindow) return;
      this.window = null;
      if (!this.isDestroying) this.emitState("attached", "window-closed");
    });
    await detachedWindow.loadFile(this.rendererPath, { query: { surface: "agent" } });
    if (this.window !== detachedWindow || !windowUsable(detachedWindow)) return this.getState();
    this.focus();
    this.emitState("detached", fromDrag ? "drag" : "button");
    return { mode: "detached", detached: true };
  }

  dock({ reason = "button" } = {}) {
    const detachedWindow = this.window;
    if (!windowUsable(detachedWindow)) return { mode: "attached", docked: false };
    this.allowClose = true;
    this.window = null;
    detachedWindow.destroy();
    if (windowUsable(this.mainWindow)) {
      if (typeof this.mainWindow.isMinimized === "function" && this.mainWindow.isMinimized()) this.mainWindow.restore();
      this.mainWindow.show?.();
      this.mainWindow.focus?.();
    }
    this.emitState("attached", reason);
    return { mode: "attached", docked: true };
  }

  close({ reason = "close-tab" } = {}) {
    const detachedWindow = this.window;
    if (!windowUsable(detachedWindow)) return { mode: "closed", closed: false };
    this.allowClose = true;
    this.window = null;
    detachedWindow.destroy();
    this.emitState("closed", reason);
    return { mode: "closed", closed: true };
  }

  dispose() {
    this.isDestroying = true;
    const detachedWindow = this.window;
    this.window = null;
    this.allowClose = true;
    if (windowUsable(detachedWindow)) detachedWindow.destroy();
    this.isDestroying = false;
  }
}

module.exports = { AgentWindowManager, windowUsable };
