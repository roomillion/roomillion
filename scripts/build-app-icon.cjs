"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const generated = path.join(root, "build", "generated");
const iconDirectory = path.join(generated, "icons");
const sourceDirectory = path.join(root, "src", "renderer", "assets");
const baseSize = 1024;
const tile = [8, 13, 11];
const deepGreen = [36, 107, 81];
const litGreen = [159, 183, 126];
const mutedEdge = [205, 210, 181];

const leftFace = [[56, 104], [128, 42], [128, 108], [56, 164]];
const rightFace = [[128, 42], [200, 98], [200, 150], [128, 108]];
const leftStrokes = [
  [56, 207, 56, 104],
  [56, 104, 128, 42],
  [56, 164, 128, 108]
];
const rightBorder = [
  [128, 42, 200, 98],
  [200, 98, 200, 150],
  [200, 150, 128, 108],
  [128, 108, 128, 42]
];

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

function segmentSetDistance(x, y, segments) {
  let distance = Infinity;
  for (const segment of segments) distance = Math.min(distance, segmentDistance(x, y, ...segment));
  return distance;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const [cx, cy] = points[current];
    const [px, py] = points[previous];
    if ((cy > y) !== (py > y) && x < ((px - cx) * (y - cy)) / (py - cy) + cx) inside = !inside;
  }
  return inside;
}

function polygonCoverage(x, y, points, antialias) {
  let distance = Infinity;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    distance = Math.min(distance, segmentDistance(x, y, ...current, ...next));
  }
  const signedDistance = pointInPolygon(x, y, points) ? distance : -distance;
  return clamp(0.5 + signedDistance / antialias);
}

function strokeCoverage(x, y, segments, radius, antialias) {
  return clamp(0.5 - (segmentSetDistance(x, y, segments) - radius) / antialias);
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
      const edge = roundedRectDistance(x, y, 128, 128, 120, 120, 56);
      const coverage = clamp(0.5 - edge / antialias);
      if (coverage <= 0) continue;
      pixel[0] = tile[0];
      pixel[1] = tile[1];
      pixel[2] = tile[2];

      blend(pixel, deepGreen, polygonCoverage(x, y, leftFace, antialias));
      blend(pixel, deepGreen, strokeCoverage(x, y, leftStrokes, 5, antialias));
      blend(pixel, mutedEdge, strokeCoverage(x, y, [[200, 146, 200, 207]], 5, antialias));
      blend(pixel, litGreen, polygonCoverage(x, y, rightFace, antialias));
      blend(pixel, mutedEdge, strokeCoverage(x, y, rightBorder, 5, antialias));
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
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="千万间 Roomillion：深绿空间房屋">' +
    '<rect x="8" y="8" width="240" height="240" rx="56" fill="#080D0B"/>' +
    '<path d="M56 104 128 42V108L56 164Z" fill="#246B51"/>' +
    '<path d="M56 207V104L128 42M56 164 128 108" fill="none" stroke="#246B51" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M200 146V207" fill="none" stroke="#CDD2B5" stroke-width="10" stroke-linecap="round"/>' +
    '<path d="M128 42 200 98V150L128 108Z" fill="#9FB77E" stroke="#CDD2B5" stroke-width="10" stroke-linejoin="round"/>' +
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
