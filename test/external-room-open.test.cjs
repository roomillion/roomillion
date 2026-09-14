"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { roomPackagePathsFromArguments } = require("../src/main/external-room-open.cjs");

test("file association arguments select current and legacy room packages", () => {
  const cwd = path.resolve("shared");
  const legacyRoom = path.resolve(cwd, "..", "rooms", "旧房间.ZROOM");
  assert.deepEqual(roomPackagePathsFromArguments([
    "千万间 Roomillion", "demo.room", "notes.txt", "demo.room", legacyRoom
  ], cwd), [path.resolve(cwd, "demo.room"), legacyRoom]);
});
