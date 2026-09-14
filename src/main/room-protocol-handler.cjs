"use strict";
const fsp = require("node:fs/promises");
const path = require("node:path");
const { resolveRoomModuleAsset } = require("./room-module-service.cjs");
const { applyCustomRuntimeCompatibility } = require("./custom-room.cjs");
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff", ".otf": "font/otf", ".ttf": "font/ttf" };
function createRoomProtocolHandler({ roomStore, resourcesRoot }) {
  return async request => {
    try {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const url = new URL(request.url);
      const room = roomStore.getRoom(url.hostname);
      if (!room) return new Response("Room Not Found", { status: 404 });
      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, "") || room.entry);
      if (relativePath.includes("\\") || relativePath.split("/").some(part => part === ".." || part === "")) return new Response("Invalid Path", { status: 400 });
      const asset = resolveRoomModuleAsset({ room, relativePath, resourcesRoot });
      const filePath = asset?.filePath ?? await roomStore.resolveProgramFile(room.id, relativePath);
      let body = await fsp.readFile(filePath);
      if (!asset && relativePath === "app/bootstrap.mjs" && room.hostModules.includes("physics.rapier@1")) body = Buffer.from(applyCustomRuntimeCompatibility(body.toString("utf8"), room.hostModules));
      return new Response(body, { headers: {
        "Content-Type": asset?.contentType ?? MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin"
      } });
    } catch (error) {
      return new Response(error.code === "ENOENT" ? "Not Found" : "Room Resource Error", { status: error.code === "ENOENT" ? 404 : 500 });
    }
  };
}
module.exports = { createRoomProtocolHandler };
