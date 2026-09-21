"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { AgentWindowManager } = require("../src/main/agent-window-manager.cjs");

let nextId = 700;

class FakeWindow extends EventEmitter {
  static instances = [];

  constructor(options = {}) {
    super();
    this.options = options;
    this.destroyed = false;
    this.focusCount = 0;
    this.webContents = new EventEmitter();
    this.webContents.id = nextId++;
    this.webContents.setWindowOpenHandler = (handler) => { this.windowOpenHandler = handler; };
    this.webContents.isDestroyed = () => this.destroyed;
    FakeWindow.instances.push(this);
  }

  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  getBounds() { return { x: 100, y: 80, width: 1200, height: 800 }; }
  restore() { this.restored = true; }
  removeMenu() { this.menuRemoved = true; }
  show() { this.shown = true; }
  focus() { this.focusCount += 1; }
  async loadFile(file, options) { this.loaded = { file, options }; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
  closeFromUser() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    this.emit("close", event);
    if (!event.prevented) this.destroy();
    return event;
  }
}

function fixture(cursor = { x: 1800, y: 300 }) {
  FakeWindow.instances.length = 0;
  const mainWindow = new FakeWindow();
  const events = [];
  const manager = new AgentWindowManager(mainWindow, {
    WindowClass: FakeWindow,
    screenApi: { getCursorScreenPoint: () => ({ ...cursor }) },
    preloadPath: "workbench-preload.cjs",
    rendererPath: "index.html",
    onStateChange: (payload) => events.push(payload)
  });
  return { manager, mainWindow, events };
}

test("AI 创建工作区可打开独立窗口并允许两个工作台发送方", async () => {
  const { manager, mainWindow, events } = fixture();
  const result = await manager.detach({ force: true });
  const child = manager.window;
  assert.equal(result.detached, true);
  assert.equal(child.loaded.file, "index.html");
  assert.equal(child.loaded.options.query.surface, "agent");
  assert.equal(child.options.webPreferences.nodeIntegration, false);
  assert.equal(child.options.webPreferences.contextIsolation, true);
  assert.equal(child.options.webPreferences.sandbox, true);
  assert.equal(child.options.webPreferences.backgroundThrottling, false);
  assert.equal(child.options.titleBarStyle, "hidden");
  assert.deepEqual(child.options.titleBarOverlay, {
    color: "#f7faf8",
    symbolColor: "#42574e",
    height: 38
  });
  assert.equal(manager.isWorkbenchSender(mainWindow.webContents.id), true);
  assert.equal(manager.isWorkbenchSender(child.webContents.id), true);
  assert.equal(manager.isAgentSender(child.webContents.id), true);
  assert.deepEqual(manager.getState(), { mode: "detached" });
  assert.equal(events.at(-1).mode, "detached");
});

test("拖动 AI 标签只有离开主窗口后才创建独立窗口", async () => {
  const inside = fixture({ x: 300, y: 200 });
  assert.deepEqual(await inside.manager.detach({ fromDrag: true }), { mode: "attached", detached: false });
  assert.equal(inside.manager.window, null);

  const outside = fixture({ x: 1800, y: 300 });
  assert.equal((await outside.manager.detach({ fromDrag: true })).mode, "detached");
  assert.equal(outside.events.at(-1).reason, "drag");
  outside.manager.dispose();
});

test("AI workspace activation restores and raises its existing window without recreating it", async () => {
  const { manager } = fixture();
  await manager.detach({ force: true });
  const child = manager.window;
  const actions = [];
  child.isMinimized = () => true;
  child.restore = () => actions.push("restore");
  child.show = () => actions.push("show");
  child.moveTop = () => actions.push("raise");
  child.focus = () => actions.push("focus");
  child.webContents.focus = () => actions.push("content");
  assert.equal((await manager.detach({ force: true })).detached, false);
  assert.equal(manager.window, child);
  assert.deepEqual(actions, ["restore", "show", "raise", "focus", "content"]);
  manager.close();
  assert.equal(manager.focus(), false);
});

test("关闭 AI 原生窗口会安全收回主工作台，关闭标签则完全关闭", async () => {
  const docked = fixture();
  await docked.manager.detach({ force: true });
  const child = docked.manager.window;
  const closeEvent = child.closeFromUser();
  assert.equal(closeEvent.prevented, true);
  assert.equal(docked.manager.window, null);
  assert.equal(docked.mainWindow.focusCount > 0, true);
  assert.deepEqual(docked.events.at(-1), { mode: "attached", reason: "window-close" });

  const closed = fixture();
  await closed.manager.detach({ force: true });
  const result = closed.manager.close();
  assert.deepEqual(result, { mode: "closed", closed: true });
  assert.deepEqual(closed.events.at(-1), { mode: "closed", reason: "close-tab" });
});
