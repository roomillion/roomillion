"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RoomViewManager, normalizeBounds } = require("../src/main/room-view-manager.cjs");

let nextWebContentsId = 40;

class FakeContentView {
  constructor() { this.children = new Set(); }
  addChildView(view) { this.children.add(view); }
  removeChildView(view) { this.children.delete(view); }
}

class FakeWebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.id = nextWebContentsId++;
    this.destroyed = false;
    this.url = "";
    this.focusCount = 0;
    this.session = {
      protocol: { isProtocolHandled: () => true, handle: () => {} },
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {}
    };
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  async loadURL(url) { this.url = url; }
  focus() { this.focusCount += 1; }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.owner.webContents = undefined;
    this.emit("destroyed");
  }
}

class FakeView {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents(this);
    this.bounds = null;
  }
  setBackgroundColor() {}
  setBounds(bounds) { this.bounds = { ...bounds }; }
}

class FakeMainWindow extends EventEmitter {
  constructor() {
    super();
    this.contentView = new FakeContentView();
    this.bounds = { x: 100, y: 80, width: 1200, height: 800 };
    this.destroyed = false;
    this.focusCount = 0;
  }
  getBounds() { return { ...this.bounds }; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  show() { this.shown = true; }
  focus() { this.focusCount += 1; }
}

class FakeDetachedWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.contentView = new FakeContentView();
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = (handler) => { this.windowOpenHandler = handler; };
    this.focusCount = 0;
    FakeDetachedWindow.instances.push(this);
  }
  removeMenu() { this.menuRemoved = true; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height }; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  show() { this.shown = true; }
  focus() { this.focusCount += 1; }
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

function fixture({ cursor = { x: 1600, y: 300 }, windowStatePath } = {}) {
  const mainWindow = new FakeMainWindow();
  const rooms = new Map([["cn.zhibian.test.room", {
    id: "cn.zhibian.test.room",
    name: "测试房间",
    version: "1.0.0",
    entry: "app/index.html"
  }]]);
  const events = [];
  const manager = new RoomViewManager(
    mainWindow,
    { dataRoot: path.dirname(windowStatePath || path.join(os.tmpdir(), "unused.json")), getRoom: (roomId) => rooms.get(roomId) || null, assertRoomCompatible: async () => {} },
    () => {},
    {
      ViewClass: FakeView,
      WindowClass: FakeDetachedWindow,
      screenApi: {
        getCursorScreenPoint: () => ({ ...cursor }),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 2560, height: 1440 } })
      },
      onWindowStateChange: (payload) => events.push(payload),
      ...(windowStatePath ? { windowStatePath } : {})
    }
  );
  return { manager, mainWindow, events };
}

test("file dialogs follow the room through detach and dock, and reject closed windows", async () => {
  const { manager, mainWindow } = fixture();
  const roomId = "cn.zhibian.test.room";
  await manager.open(roomId);
  assert.equal(manager.getDialogParent(roomId), mainWindow);
  await manager.detach(roomId);
  const detached = manager.detachedWindows.get(roomId).window;
  assert.equal(manager.getDialogParent(roomId), detached);
  detached.destroyed = true;
  assert.throws(() => manager.getDialogParent(roomId), /窗口已关闭/);
  detached.destroyed = false;
  await manager.dock(roomId);
  assert.equal(manager.getDialogParent(roomId), mainWindow);
  mainWindow.destroyed = true;
  assert.throws(() => manager.getDialogParent(roomId), /窗口已关闭/);
  mainWindow.destroyed = false;
  manager.close(roomId);
  assert.throws(() => manager.getDialogParent(roomId), /窗口已关闭/);
});

test("closing a room does not read webContents after Electron destroys it", () => {
  const { manager } = fixture();
  const view = manager.createView("cn.zhibian.test.room");
  const senderId = view.webContents.id;
  assert.equal(manager.getRoomIdForSender(senderId), "cn.zhibian.test.room");
  assert.doesNotThrow(() => manager.close("cn.zhibian.test.room"));
  assert.equal(manager.getRoomIdForSender(senderId), null);
  assert.equal(manager.views.has("cn.zhibian.test.room"), false);
  assert.doesNotThrow(() => manager.close("cn.zhibian.test.room"));
});

test("room renderers remain unthrottled while the workbench is in the background", () => {
  const { manager } = fixture();
  const view = manager.createView("cn.zhibian.test.room");
  assert.equal(view.options.webPreferences.backgroundThrottling, false);
  manager.close("cn.zhibian.test.room");
});

test("detaching and docking reparents the same live WebContentsView without reloading", async () => {
  FakeDetachedWindow.instances.length = 0;
  const { manager, mainWindow, events } = fixture();
  await manager.open("cn.zhibian.test.room");
  const view = manager.views.get("cn.zhibian.test.room");
  const webContents = view.webContents;
  const url = webContents.getURL();
  assert.equal(mainWindow.contentView.children.has(view), true);

  const detached = await manager.detach("cn.zhibian.test.room", { force: true });
  assert.equal(detached.mode, "detached");
  assert.equal(manager.views.get("cn.zhibian.test.room"), view);
  assert.equal(view.webContents, webContents);
  assert.equal(webContents.getURL(), url);
  assert.equal(webContents.isDestroyed(), false);
  assert.equal(mainWindow.contentView.children.has(view), false);
  assert.equal(FakeDetachedWindow.instances[0].contentView.children.has(view), true);
  assert.equal(manager.getRoomIdForSender(webContents.id), "cn.zhibian.test.room");
  assert.deepEqual(manager.getWindowStates(), [{ roomId: "cn.zhibian.test.room", mode: "detached" }]);

  const docked = await manager.dock("cn.zhibian.test.room");
  assert.equal(docked.docked, true);
  assert.equal(manager.views.get("cn.zhibian.test.room").webContents, webContents);
  assert.equal(webContents.getURL(), url);
  assert.equal(mainWindow.contentView.children.has(view), true);
  assert.equal(manager.activeRoomId, "cn.zhibian.test.room");
  assert.equal(FakeDetachedWindow.instances[0].destroyed, true);
  assert.deepEqual(events.map((event) => event.mode), ["detached", "attached"]);
});

test("reopening a minimized detached room restores and raises the existing window", async () => {
  const { manager } = fixture();
  const roomId = "cn.zhibian.test.room";
  await manager.detach(roomId, { force: true });
  const { window, view } = manager.detachedWindows.get(roomId);
  const actions = [];
  window.isMinimized = () => true;
  window.restore = () => actions.push("restore");
  window.show = () => actions.push("show");
  window.moveTop = () => actions.push("raise");
  window.focus = () => actions.push("focus");
  view.webContents.focus = () => actions.push("content");
  assert.equal((await manager.detach(roomId, { force: true })).detached, false);
  assert.deepEqual(actions, ["restore", "show", "raise", "focus", "content"]);
  manager.close(roomId);
  assert.equal(manager.focusDetached(roomId), false);
});

test("closing a detached native window safely docks it back into the workbench", async () => {
  FakeDetachedWindow.instances.length = 0;
  const { manager, mainWindow, events } = fixture();
  await manager.open("cn.zhibian.test.room");
  const view = manager.views.get("cn.zhibian.test.room");
  await manager.detach("cn.zhibian.test.room", { force: true });
  const event = FakeDetachedWindow.instances[0].closeFromUser();
  assert.equal(event.prevented, true);
  assert.equal(manager.detachedWindows.has("cn.zhibian.test.room"), false);
  assert.equal(mainWindow.contentView.children.has(view), true);
  assert.equal(view.webContents.isDestroyed(), false);
  assert.equal(events.at(-1).reason, "window-close");
});

test("tab drag detaches only after the pointer leaves the main window", async () => {
  const inside = fixture({ cursor: { x: 300, y: 200 } });
  await inside.manager.open("cn.zhibian.test.room");
  assert.deepEqual(await inside.manager.detach("cn.zhibian.test.room", { fromDrag: true }), {
    roomId: "cn.zhibian.test.room", mode: "attached", detached: false
  });
  assert.equal(inside.manager.detachedWindows.size, 0);

  const outside = fixture({ cursor: { x: 1800, y: 400 } });
  await outside.manager.open("cn.zhibian.test.room");
  assert.equal((await outside.manager.detach("cn.zhibian.test.room", { fromDrag: true })).detached, true);
  assert.equal(outside.manager.detachedWindows.size, 1);
  outside.manager.destroyAll();
});

test("detached window bounds are persisted and restored with validation", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-window-state-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const statePath = path.join(dataRoot, "room-window-state.json");
  const first = fixture({ windowStatePath: statePath });
  await first.manager.init();
  await first.manager.open("cn.zhibian.test.room");
  await first.manager.detach("cn.zhibian.test.room", { force: true });
  const window = first.manager.detachedWindows.get("cn.zhibian.test.room").window;
  window.bounds = { x: 420, y: 160, width: 1100, height: 760 };
  window.emit("move");
  await first.manager.persistWindowStates();

  const second = fixture({ windowStatePath: statePath });
  await second.manager.init();
  assert.deepEqual(second.manager.windowBounds.get("cn.zhibian.test.room"), { x: 420, y: 160, width: 1100, height: 760 });
  assert.equal(normalizeBounds({ x: 0, y: 0, width: 10, height: 10 }), null);
  first.manager.destroyAll();
});

test("closing a detached tab destroys both its native window and room WebContents", async () => {
  FakeDetachedWindow.instances.length = 0;
  const { manager } = fixture();
  await manager.open("cn.zhibian.test.room");
  const view = manager.views.get("cn.zhibian.test.room");
  const webContents = view.webContents;
  await manager.detach("cn.zhibian.test.room", { force: true });
  manager.close("cn.zhibian.test.room");
  assert.equal(FakeDetachedWindow.instances[0].destroyed, true);
  assert.equal(webContents.isDestroyed(), true);
  assert.equal(manager.views.has("cn.zhibian.test.room"), false);
  assert.equal(manager.detachedWindows.has("cn.zhibian.test.room"), false);
});
