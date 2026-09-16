"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LEGACY_PROFILE_NAME = "智变工作台";
const CURRENT_PROFILE_NAME = "Roomillion";

function resolveRoomillionUserDataPath(appDataRoot, exists = fs.existsSync) {
  const legacyPath = path.join(appDataRoot, LEGACY_PROFILE_NAME);
  const currentPath = path.join(appDataRoot, CURRENT_PROFILE_NAME);
  const legacyHasData = exists(path.join(legacyPath, "mvp-data")) || exists(path.join(legacyPath, "room-storage-location.json"));
  const currentHasData = exists(path.join(currentPath, "mvp-data")) || exists(path.join(currentPath, "room-storage-location.json"));
  return legacyHasData && !currentHasData ? legacyPath : currentPath;
}

module.exports = { CURRENT_PROFILE_NAME, LEGACY_PROFILE_NAME, resolveRoomillionUserDataPath };
