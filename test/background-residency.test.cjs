"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { BackgroundResidency } = require("../src/main/background-residency.cjs");

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.visible = true;
    this.destroyed = false;
    this.actions = [];
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  hide() { this.visible = false; this.actions.push("hide"); }
  show() { this.visible = true; this.actions.push("show"); }
  focus() { this.actions.push("focus"); }
}

class FakeTray extends EventEmitter {
  constructor(icon) { super(); this.icon = icon; this.destroyed = false; }
  setToolTip(value) { this.tooltip = value; }
  setContextMenu(value) { this.menu = value; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

function fixture(response = 0) {
  const mainWindow = new FakeWindow();
  const roomWindow = new FakeWindow();
  const hiddenWindow = new FakeWindow();
  hiddenWindow.visible = false;
  let quitCount = 0;
  let prompts = 0;
  const controller = new BackgroundResidency({
    appApi: { quit: () => { quitCount += 1; } },
    dialogApi: { showMessageBox: async () => { prompts += 1; return { response }; } },
    MenuApi: { buildFromTemplate: (template) => template },
    TrayClass: FakeTray,
    mainWindow,
    getWindows: () => [mainWindow, roomWindow, hiddenWindow],
    trayIcon: "icon"
  }).start();
  return { controller, mainWindow, roomWindow, hiddenWindow, quitCount: () => quitCount, prompts: () => prompts };
}

function closeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

test("choosing background hides visible windows without destroying room runtimes", async () => {
  const state = fixture(0);
  const event = closeEvent();
  state.mainWindow.emit("close", event);
  await state.controller.closePrompt;
  assert.equal(event.prevented, true);
  assert.equal(state.mainWindow.visible, false);
  assert.equal(state.roomWindow.visible, false);
  assert.equal(state.hiddenWindow.visible, false);
  assert.equal(state.mainWindow.destroyed, false);
  assert.equal(state.roomWindow.destroyed, false);
  assert.equal(state.quitCount(), 0);

  state.controller.tray.emit("click");
  assert.equal(state.mainWindow.visible, true);
  assert.equal(state.roomWindow.visible, true);
  assert.equal(state.hiddenWindow.visible, false);
  assert.deepEqual(state.mainWindow.actions, ["hide", "show", "focus"]);
});

test("choosing complete exit bypasses later close prompts", async () => {
  const state = fixture(1);
  const first = closeEvent();
  state.mainWindow.emit("close", first);
  await state.controller.closePrompt;
  assert.equal(first.prevented, true);
  assert.equal(state.quitCount(), 1);

  const final = closeEvent();
  state.mainWindow.emit("close", final);
  assert.equal(final.prevented, false);
  assert.equal(state.prompts(), 1);
});

test("cancel leaves windows open and duplicate close events share one prompt", async () => {
  let resolvePrompt;
  const mainWindow = new FakeWindow();
  const controller = new BackgroundResidency({
    appApi: { quit: () => assert.fail("must not quit") },
    dialogApi: { showMessageBox: () => new Promise((resolve) => { resolvePrompt = resolve; }) },
    MenuApi: { buildFromTemplate: (template) => template },
    TrayClass: FakeTray,
    mainWindow,
    getWindows: () => [mainWindow],
    trayIcon: "icon"
  }).start();
  const first = closeEvent();
  const second = closeEvent();
  mainWindow.emit("close", first);
  mainWindow.emit("close", second);
  resolvePrompt({ response: 2 });
  await controller.closePrompt;
  assert.equal(first.prevented, true);
  assert.equal(second.prevented, true);
  assert.equal(mainWindow.visible, true);
});

test("tray menu restores the workbench and provides an explicit full exit", () => {
  const state = fixture(0);
  assert.equal(state.controller.tray.tooltip, "千万间 Roomillion");
  assert.deepEqual(state.controller.tray.menu.map((item) => item.label || item.type), ["打开工作台", "separator", "完全退出"]);
  state.controller.tray.menu[2].click();
  assert.equal(state.quitCount(), 1);
  state.controller.beginQuit();
  assert.equal(state.controller.tray, null);
});
