"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { RoomAiRequests } = require("../src/main/room-ai-requests.cjs");
const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });

test("AI cancellation is scoped to sender and room and cleans up completed requests", () => {
  const requests = new RoomAiRequests();
  const a = sender(), b = sender();
  const first = requests.start(a, "room-a", "translate-1");
  const other = requests.start(b, "room-b", "translate-1");
  assert.deepEqual(requests.cancel(a, "room-b", "translate-1"), { cancelled: false });
  assert.equal(first.signal.aborted, false);
  assert.throws(() => requests.start(a, "room-a", "translate-1"), /正在使用/);
  assert.deepEqual(requests.cancel(a, "room-a", "translate-1"), { cancelled: true });
  assert.equal(first.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  first.finish(); other.finish();
  assert.equal(a.listenerCount("destroyed"), 0);
  assert.deepEqual(requests.cancel(a, "room-a", "translate-1"), { cancelled: false });
  for (const invalid of [null, 3, "", "bad id", "a".repeat(102)]) {
    assert.throws(() => requests.start(a, "room-a", invalid), /标识无效/);
    assert.throws(() => requests.cancel(a, "room-a", invalid), /标识无效/);
  }
});

test("room reload and destruction abort active AI requests without affecting new requests", () => {
  const requests = new RoomAiRequests();
  const a = sender();
  const old = requests.start(a, "room-a", "same-id");
  a.emit("did-start-navigation", {}, "room://room-a", true, true);
  assert.equal(old.signal.aborted, false);
  a.emit("did-start-navigation", {}, "room://room-a", false, false);
  assert.equal(old.signal.aborted, false);
  a.emit("did-start-navigation", {}, "room://room-a", false, true);
  assert.equal(old.signal.aborted, true);
  const fresh = requests.start(a, "room-a", "same-id");
  old.finish();
  assert.equal(fresh.signal.aborted, false);
  a.emit("destroyed");
  assert.equal(fresh.signal.aborted, true);
  fresh.finish();
  assert.equal(a.listenerCount("did-start-navigation"), 0);
});
