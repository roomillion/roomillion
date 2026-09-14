"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { assertPortablePaths, auditPortableRoom, nativeMagicKind } = require("../src/main/portability-service.cjs");

test("portable path contract rejects case and Unicode normalization collisions", () => {
  assert.throws(
    () => assertPortablePaths(["app/Report.js", "app/report.js"]),
    /跨平台路径冲突/
  );
  assert.throws(
    () => assertPortablePaths(["app/é.txt", "app/e\u0301.txt"]),
    /跨平台路径冲突/
  );
  assert.doesNotThrow(() => assertPortablePaths(["manifest.json", "app/index.html", "assets/logo.svg"]));
});

test("native payload signatures are recognized without blocking WebAssembly", () => {
  assert.equal(nativeMagicKind(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), "PE");
  assert.equal(nativeMagicKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "ELF");
  assert.equal(nativeMagicKind(Buffer.from([0x00, 0x61, 0x73, 0x6d])), null);
});

test("room portability audit rejects native extensions and binary magic", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-portability-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const nativeByName = path.join(root, "addon.node");
  const nativeByMagic = path.join(root, "payload.bin");
  await fsp.writeFile(nativeByName, "not-even-loaded", "utf8");
  await fsp.writeFile(nativeByMagic, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]));
  await assert.rejects(
    () => auditPortableRoom([{ fullPath: nativeByName, relativePath: "app/addon.node" }]),
    /平台原生文件/
  );
  await assert.rejects(
    () => auditPortableRoom([{ fullPath: nativeByMagic, relativePath: "assets/payload.bin" }]),
    /ELF 原生载荷/
  );
});
