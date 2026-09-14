"use strict";

const path = require("node:path");
const { getRoomModule } = require("./room-module-catalog.cjs");

const MODULE_PREFIX = "_modules/";

const MODULE_MIME_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
});

function resolveRoomModuleAsset({ room, relativePath, resourcesRoot }) {
  if (!relativePath.startsWith(MODULE_PREFIX)) return null;
  const parts = relativePath.split("/");
  if (parts.length < 3 || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error("宿主模块资源路径无效");
  }
  const [, moduleId, ...assetParts] = parts;
  const publicName = assetParts.join("/");
  if (!Array.isArray(room?.hostModules) || !room.hostModules.includes(moduleId)) {
    throw new Error("房间没有声明该宿主模块");
  }
  const module = getRoomModule(moduleId);
  const asset = module?.assets.find((candidate) => candidate.directory
    ? publicName.startsWith(`${candidate.publicName}/`)
    : candidate.publicName === publicName);
  if (!module || !asset) throw new Error("宿主模块资源不存在");

  const root = path.resolve(resourcesRoot);
  const moduleRoot = path.resolve(root, moduleId);
  const filePath = path.resolve(moduleRoot, ...assetParts);
  if (!filePath.startsWith(`${moduleRoot}${path.sep}`)) throw new Error("宿主模块资源路径越界");
  return {
    filePath,
    contentType: MODULE_MIME_TYPES[path.extname(publicName).toLowerCase()] ?? "application/octet-stream",
    module,
    asset
  };
}

module.exports = { MODULE_PREFIX, resolveRoomModuleAsset };
