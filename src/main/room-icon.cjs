"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const ICON_PATH = "assets/icon.svg";
const ICON_MAX_BYTES = Number.MAX_SAFE_INTEGER;
const ICON_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const THEME_COLORS = Object.freeze({
  emerald: ["#173d32", "#d7f36a"], blue: ["#17466f", "#d9efff"],
  violet: ["#49306f", "#f0e6ff"], amber: ["#6b4014", "#fff0b8"],
  rose: ["#702f47", "#ffe5ee"], slate: ["#334155", "#f1f5f9"],
  dark: ["#17202b", "#80e1c1"], custom: ["#173d32", "#d7f36a"]
});

function normalizeHexColor(value, fallback) {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

function normalizeRoomIconSpec(value, { name = "房间", theme = "custom" } = {}) {
  const defaults = THEME_COLORS[theme] || THEME_COLORS.custom;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const requestedGlyph = Array.from(String(source.glyph ?? name).trim()).slice(0, 2).join("");
  const glyph = requestedGlyph && !/[<>&\u0000-\u001f]/.test(requestedGlyph) ? requestedGlyph : "房";
  return Object.freeze({
    glyph,
    background: normalizeHexColor(source.background, defaults[0]),
    foreground: normalizeHexColor(source.foreground, defaults[1])
  });
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function generatedRoomIconSvg(spec) {
  const icon = normalizeRoomIconSpec(spec);
  const fontSize = Array.from(icon.glyph).length > 1 ? 38 : 52;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img">
  <rect width="128" height="128" rx="30" fill="${icon.background}"/>
  <circle cx="99" cy="29" r="13" fill="${icon.foreground}" opacity=".18"/>
  <path d="M24 93c20 12 60 12 80 0" fill="none" stroke="${icon.foreground}" stroke-width="7" stroke-linecap="round" opacity=".2"/>
  <text x="64" y="77" fill="${icon.foreground}" font-family="Microsoft YaHei UI,Microsoft YaHei,sans-serif" font-size="${fontSize}" font-weight="800" text-anchor="middle">${escapeXml(icon.glyph)}</text>
</svg>\n`;
}

async function writeGeneratedRoomIcon(sourceRoot, input) {
  const icon = normalizeRoomIconSpec(input?.icon, input);
  const target = path.join(sourceRoot, ...ICON_PATH.split("/"));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, generatedRoomIconSvg(icon), "utf8");
  return { path: ICON_PATH, spec: icon };
}

function assertSafeSvg(buffer) {
  const text = buffer.toString("utf8");
  if (text.includes("\ufffd") || !/^\s*<svg\b/i.test(text) || !/<\/svg>\s*$/i.test(text)) throw new Error("房间 SVG 图标格式无效");
  if (/(?:<!doctype|<!entity|<\?xml-stylesheet|<(?:script|style|foreignObject|iframe|object|embed|image|use|a|animate|set|audio|video)\b|\son[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(|@import)/i.test(text)) {
    throw new Error("房间 SVG 图标包含外部资源或活动内容");
  }
  const allowed = new Set(["svg", "g", "rect", "circle", "ellipse", "path", "line", "polyline", "polygon", "text", "tspan", "title", "desc"]);
  for (const match of text.matchAll(/<\/?\s*([A-Za-z][\w:-]*)\b/g)) {
    if (!allowed.has(match[1])) throw new Error(`房间 SVG 图标包含不支持的元素：${match[1]}`);
  }
}

async function validateRoomIconFile(root, iconPath) {
  if (!iconPath) return null;
  const target = path.join(root, ...iconPath.split("/"));
  const stats = await fsp.stat(target);
  if (!stats.isFile() || stats.size === 0) throw new Error("房间图标必须是非空普通文件");
  const extension = path.extname(iconPath).toLowerCase();
  if (!ICON_EXTENSIONS.has(extension)) throw new Error("房间图标只支持 SVG、PNG、JPEG 或 WebP");
  const buffer = await fsp.readFile(target);
  let mimeType;
  if (extension === ".svg") { assertSafeSvg(buffer); mimeType = "image/svg+xml"; }
  else if (extension === ".png" && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) mimeType = "image/png";
  else if ([".jpg", ".jpeg"].includes(extension) && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) mimeType = "image/jpeg";
  else if (extension === ".webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") mimeType = "image/webp";
  else throw new Error("房间图标的扩展名与实际内容不一致");
  return { path: iconPath, bytes: buffer.length, mimeType, dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}` };
}

module.exports = { ICON_MAX_BYTES, ICON_PATH, generatedRoomIconSvg, normalizeRoomIconSpec, validateRoomIconFile, writeGeneratedRoomIcon };
