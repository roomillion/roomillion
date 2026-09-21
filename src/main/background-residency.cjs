"use strict";

function windowUsable(window) {
  return Boolean(window) && (typeof window.isDestroyed !== "function" || !window.isDestroyed());
}

class BackgroundResidency {
  constructor({
    appApi,
    dialogApi,
    MenuApi,
    TrayClass,
    mainWindow,
    getWindows,
    trayIcon,
    logger = console
  }) {
    this.appApi = appApi;
    this.dialogApi = dialogApi;
    this.MenuApi = MenuApi;
    this.TrayClass = TrayClass;
    this.mainWindow = mainWindow;
    this.getWindows = getWindows;
    this.trayIcon = trayIcon;
    this.logger = logger;
    this.tray = null;
    this.quitting = false;
    this.closePrompt = null;
    this.hiddenWindows = [];
    this.closeListener = (event) => this.handleClose(event);
  }

  start() {
    this.mainWindow.on("close", this.closeListener);
    this.tray = new this.TrayClass(this.trayIcon);
    this.tray.setToolTip("千万间 Roomillion");
    this.tray.setContextMenu(this.MenuApi.buildFromTemplate([
      { label: "打开工作台", click: () => this.restore() },
      { type: "separator" },
      { label: "完全退出", click: () => this.quit() }
    ]));
    this.tray.on("click", () => this.restore());
    this.tray.on("double-click", () => this.restore());
    return this;
  }

  async handleClose(event) {
    if (this.quitting) return;
    event.preventDefault();
    if (this.closePrompt) return this.closePrompt;
    this.closePrompt = this.chooseCloseAction()
      .catch((error) => this.logger.error("选择关闭方式失败", error))
      .finally(() => { this.closePrompt = null; });
    return this.closePrompt;
  }

  async chooseCloseAction() {
    if (!windowUsable(this.mainWindow)) return;
    const choice = await this.dialogApi.showMessageBox(this.mainWindow, {
      type: "question",
      title: "关闭千万间 Roomillion",
      message: "要完全退出，还是让工作台常驻后台？",
      detail: "常驻后台会隐藏窗口，已打开房间、AI 任务和房间后台运行不会中断。可点击系统托盘中的千万间图标重新打开。",
      buttons: ["常驻后台", "完全退出", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (this.quitting) return;
    if (choice.response === 0) this.hideToBackground();
    else if (choice.response === 1) this.quit();
  }

  hideToBackground() {
    const windows = this.getWindows().filter(windowUsable);
    this.hiddenWindows = windows.filter((window) => typeof window.isVisible !== "function" || window.isVisible());
    if (!this.hiddenWindows.includes(this.mainWindow) && windowUsable(this.mainWindow)) this.hiddenWindows.unshift(this.mainWindow);
    for (const window of this.hiddenWindows) window.hide?.();
  }

  restore() {
    const windows = this.hiddenWindows.filter(windowUsable);
    this.hiddenWindows = [];
    for (const window of windows) {
      if (window === this.mainWindow) continue;
      if (window.isMinimized?.()) window.restore?.();
      window.show?.();
    }
    if (!windowUsable(this.mainWindow)) return;
    if (this.mainWindow.isMinimized?.()) this.mainWindow.restore?.();
    this.mainWindow.show?.();
    this.mainWindow.focus?.();
  }

  quit() {
    if (this.quitting) return;
    this.quitting = true;
    this.appApi.quit();
  }

  beginQuit() {
    this.quitting = true;
    this.hiddenWindows = [];
    if (this.tray && !this.tray.isDestroyed?.()) this.tray.destroy();
    this.tray = null;
  }

  dispose() {
    this.mainWindow?.removeListener?.("close", this.closeListener);
    this.beginQuit();
  }
}

module.exports = { BackgroundResidency, windowUsable };
