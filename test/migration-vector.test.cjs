"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { packDirectory } = require("../src/main/room-package.cjs");
const {
  consumeTargetVector,
  createSourceVector,
  loadVector,
  verifyReturnVector
} = require("../src/main/migration-vector.cjs");

async function createRoomPackage(root) {
  const source = path.join(root, "room-source");
  const packagePath = path.join(root, "source-room.room");
  await fsp.mkdir(path.join(source, "app"), { recursive: true });
  await fsp.writeFile(path.join(source, "manifest.json"), JSON.stringify({
    formatVersion: "0.1",
    id: "cn.zhibian.migration-test",
    name: "跨平台迁移测试",
    version: "1.0.0",
    runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" },
    entry: "app/index.html",
    permissions: { database: "private", network: [] },
    hostModules: []
  }), "utf8");
  await fsp.writeFile(path.join(source, "app", "index.html"), "<!doctype html><meta charset=utf-8><title>迁移</title>", "utf8");
  await packDirectory(source, packagePath);
  return packagePath;
}

test("migration vector completes Windows to Linux to Windows data round-trip", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-migration-vector-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const roomPackagePath = await createRoomPackage(root);
  const sourceRoot = path.join(root, "windows-source");
  const returnRoot = path.join(root, "linux-return");
  const source = await createSourceVector({ roomPackagePath, outputRoot: sourceRoot, sourceRuntime: "win32-x64" });
  assert.equal(source.vector.expected.rowCount, 1);
  assert.match(source.rows[0].text_value, /中文.*emoji/);
  const reused = await createSourceVector({ roomPackagePath, outputRoot: sourceRoot, sourceRuntime: "win32-x64" });
  assert.equal(reused.reused, true);
  assert.equal(reused.vector.files.dataSha256, source.vector.files.dataSha256);

  const target = await consumeTargetVector({ inputRoot: sourceRoot, outputRoot: returnRoot, targetRuntime: "linux-x64" });
  assert.equal(target.report.result, "PASS");
  assert.equal(target.vector.expected.rowCount, 2);
  assert.equal(target.vector.files.roomSha256, source.vector.files.roomSha256);

  const returned = await verifyReturnVector({ sourceRoot, returnRoot, returnRuntime: "win32-x64" });
  assert.equal(returned.report.result, "PASS");
  assert.equal(returned.report.rowCount, 2);
  assert.deepEqual(returned.rows.map((row) => row.origin), ["win32-x64", "linux-x64"]);
});

test("migration vector rejects tampered room package before installation", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-migration-tamper-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const roomPackagePath = await createRoomPackage(root);
  const sourceRoot = path.join(root, "windows-source");
  await createSourceVector({ roomPackagePath, outputRoot: sourceRoot, sourceRuntime: "win32-x64" });
  await fsp.appendFile(path.join(sourceRoot, "migration-room.room"), "tamper", "utf8");
  await assert.rejects(() => loadVector(sourceRoot, "source"), /SHA-256 不匹配/);
});
