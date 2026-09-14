"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { resolveRoomillionUserDataPath } = require("../src/main/brand-profile.cjs");

test("Roomillion keeps legacy user data and uses the new profile for fresh installs", () => {
  const appDataRoot = path.resolve("profiles");
  const legacyData = path.join(appDataRoot, "智变工作台", "mvp-data");
  const currentData = path.join(appDataRoot, "Roomillion", "mvp-data");
  assert.equal(resolveRoomillionUserDataPath(appDataRoot, () => false), path.join(appDataRoot, "Roomillion"));
  assert.equal(resolveRoomillionUserDataPath(appDataRoot, (candidate) => candidate === legacyData), path.join(appDataRoot, "智变工作台"));
  assert.equal(resolveRoomillionUserDataPath(appDataRoot, (candidate) => candidate === legacyData || candidate === currentData), path.join(appDataRoot, "Roomillion"));
});
