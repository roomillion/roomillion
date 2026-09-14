"use strict";

const fsp = require("node:fs/promises");

const NATIVE_FILE_PATTERN = /(?:\.(?:exe|dll|node|dylib|msi|com|scr)|\.so(?:\.\d+)*)$/i;

function portablePathKey(relativePath) {
  if (typeof relativePath !== "string" || !relativePath) throw new Error("可移植性检查路径无效");
  return relativePath
    .split("/")
    .map((segment) => segment.normalize("NFC").toLocaleLowerCase("en-US"))
    .join("/");
}

function createPortablePathRegistry() {
  const prefixes = new Map();
  const entries = new Set();
  return {
    add(relativePath) {
      const segments = relativePath.split("/");
      for (let index = 0; index < segments.length; index += 1) {
        const original = segments.slice(0, index + 1).join("/");
        const key = portablePathKey(original);
        const existing = prefixes.get(key);
        if (existing && existing !== original) {
          throw new Error(`房间包存在跨平台路径冲突：${existing} / ${original}`);
        }
        prefixes.set(key, original);
      }
      const entryKey = portablePathKey(relativePath);
      if (entries.has(entryKey)) throw new Error(`房间包路径重复：${relativePath}`);
      entries.add(entryKey);
    }
  };
}

function assertPortablePaths(relativePaths) {
  const registry = createPortablePathRegistry();
  for (const relativePath of relativePaths) registry.add(relativePath);
  return true;
}

function nativeMagicKind(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return "PE";
  if (buffer.length >= 4 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return "ELF";
  if (buffer.length >= 4) {
    const magic = buffer.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return "Mach-O";
  }
  return null;
}

async function readMagic(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function auditPortableRoom(files) {
  if (!Array.isArray(files)) throw new Error("房间文件清单无效");
  assertPortablePaths(files.map((file) => file.relativePath));
  for (const file of files) {
    if (NATIVE_FILE_PATTERN.test(file.relativePath)) {
      throw new Error(`房间不得携带平台原生文件：${file.relativePath}`);
    }
    const magic = nativeMagicKind(await readMagic(file.fullPath));
    if (magic) throw new Error(`房间不得携带 ${magic} 原生载荷：${file.relativePath}`);
  }
  return Object.freeze({
    status: "portable",
    contractVersion: "0.1",
    targets: ["win32-x64", "linux-x64"],
    checkedFiles: files.length,
    nativePayloads: 0,
    pathCollisions: 0
  });
}

module.exports = {
  NATIVE_FILE_PATTERN,
  assertPortablePaths,
  auditPortableRoom,
  createPortablePathRegistry,
  nativeMagicKind,
  portablePathKey
};
