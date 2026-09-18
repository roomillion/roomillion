"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const generated = path.join(root, "build", "generated");
const iconDirectory = path.join(generated, "icons");
const sourceDirectory = path.join(root, "src", "renderer", "assets");
const baseSize = 1024;
const cream = [247, 244, 226];
const lime = [218, 245, 112];

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function roundedRectDistance(x, y, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x - cx) - halfWidth + radius;
  const dy = Math.abs(y - cy) - halfHeight + radius;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function portal(left, top, right, bottom, radius) {
  const points = [[left, bottom], [left, top + radius]];
  for (let i = 1; i <= 8; i++) {
    const angle = Math.PI - i * Math.PI / 16;
    points.push([left + radius + radius * Math.cos(angle), top + radius - radius * Math.sin(angle)]);
  }
  points.push([right - radius, top]);
  for (let i = 1; i <= 8; i++) {
    const angle = Math.PI / 2 - i * Math.PI / 16;
    points.push([right - radius + radius * Math.cos(angle), top + radius - radius * Math.sin(angle)]);
  }
  points.push([right, bottom]);
  return points;
}

const backPortal = portal(64, 73, 169, 183, 25);
const frontPortal = portal(110, 101, 198, 183, 22);

function portalDistance(x, y, points) {
  let distance = Infinity;
  for (let i = 1; i < points.length; i++) {
    distance = Math.min(distance, segmentDistance(x, y, ...points[i - 1], ...points[i]));
  }
  return distance;
}

function blend(pixel, color, opacity) {
  const alpha = clamp(opacity);
  pixel[0] = pixel[0] * (1 - alpha) + color[0] * alpha;
  pixel[1] = pixel[1] * (1 - alpha) + color[1] * alpha;
  pixel[2] = pixel[2] * (1 - alpha) + color[2] * alpha;
}

function renderBase() {
  const data = Buffer.alloc(baseSize * baseSize * 4);
  const pixel = [0, 0, 0];
  const antialias = 256 / baseSize;
  for (let row = 0; row < baseSize; row++) {
    const y = (row + 0.5) * antialias;
    for (let column = 0; column < baseSize; column++) {
      const x = (column + 0.5) * antialias;
      const edge = roundedRectDistance(x, y, 128, 128, 120, 120, 47);
      const coverage = clamp(0.5 - edge / antialias);
      if (coverage <= 0) continue;
      const shade = clamp((x + y) / 512);
      const glow = clamp(1 - Math.hypot(x - 49, y - 32) / 265) * 0.16;
      pixel[0] = 31 - 13 * shade + 26 * glow;
      pixel[1] = 79 - 28 * shade + 26 * glow;
      pixel[2] = 65 - 20 * shade + 15 * glow;
      const back = clamp(0.5 - (portalDistance(x, y, backPortal) - 9.5) / antialias);
      if (back) blend(pixel, cream, back);
      const front = clamp(0.5 - (portalDistance(x, y, frontPortal) - 8.5) / antialias);
      if (front) blend(pixel, lime, front);
      const offset = (row * baseSize + column) * 4;
      data[offset] = Math.round(pixel[0]);
      data[offset + 1] = Math.round(pixel[1]);
      data[offset + 2] = Math.round(pixel[2]);
      data[offset + 3] = Math.round(255 * coverage);
    }
  }
  return data;
}

function resize(source, size) {
  const result = Buffer.alloc(size * size * 4);
  const scale = baseSize / size;
  for (let y = 0; y < size; y++) {
    const top = y * scale;
    const bottom = (y + 1) * scale;
    for (let x = 0; x < size; x++) {
      const left = x * scale;
      const right = (x + 1) * scale;
      let alpha = 0, red = 0, green = 0, blue = 0;
      for (let yy = Math.floor(top); yy < Math.min(baseSize, Math.ceil(bottom)); yy++) {
        const wy = Math.min(yy + 1, bottom) - Math.max(yy, top);
        for (let xx = Math.floor(left); xx < Math.min(baseSize, Math.ceil(right)); xx++) {
          const weight = wy * (Math.min(xx + 1, right) - Math.max(xx, left));
          const offset = (yy * baseSize + xx) * 4;
          const a = source[offset + 3] * weight;
          alpha += a;
          red += source[offset] * a;
          green += source[offset + 1] * a;
          blue += source[offset + 2] * a;
        }
      }
      const offset = (y * size + x) * 4;
      result[offset] = alpha ? Math.round(red / alpha) : 0;
      result[offset + 1] = alpha ? Math.round(green / alpha) : 0;
      result[offset + 2] = alpha ? Math.round(blue / alpha) : 0;
      result[offset + 3] = Math.round(alpha / (scale * scale));
    }
  }
  return result;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const start = 6 + index * 16;
    header[start] = entry.size === 256 ? 0 : entry.size;
    header[start + 1] = entry.size === 256 ? 0 : entry.size;
    header.writeUInt16LE(1, start + 4);
    header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(entry.png.length, start + 8);
    header.writeUInt32LE(offset, start + 12);
    offset += entry.png.length;
  }
  return Buffer.concat([header, ...entries.map(entry => entry.png)]);
}

function svgSource() {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="千万间 Roomillion：相连的两道门廊">' +
    '<defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#235746"/><stop offset="1" stop-color="#12372f"/></linearGradient></defs>' +
    '<rect x="8" y="8" width="240" height="240" rx="47" fill="url(#tile)"/>' +
    '<path d="M64 183V98a25 25 0 0 1 25-25h55a25 25 0 0 1 25 25v85" fill="none" stroke="#f7f4e2" stroke-width="19" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M110 183v-60a22 22 0 0 1 22-22h44a22 22 0 0 1 22 22v60" fill="none" stroke="#daf570" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>\n';
}

function main() {
  fs.mkdirSync(iconDirectory, { recursive: true });
  fs.mkdirSync(sourceDirectory, { recursive: true });
  const base = renderBase();
  const icoEntries = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const png = encodePng(size, resize(base, size));
    fs.writeFileSync(path.join(iconDirectory, size + "x" + size + ".png"), png);
    if (size <= 256) icoEntries.push({ size, png });
  }
  fs.writeFileSync(path.join(generated, "app.ico"), encodeIco(icoEntries));
  fs.writeFileSync(path.join(sourceDirectory, "app-icon.svg"), svgSource());
}

main();
