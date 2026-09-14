"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validateManifest } = require("../src/main/manifest.cjs");
const { bundleRoomDependency } = require("../src/main/room-dependency-bundler.cjs");
const { extractAndValidate, packDirectory } = require("../src/main/room-package.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");

async function createRoomSource(root, id = "cn.zhibian.dependency-test") {
  await fsp.mkdir(path.join(root, "app"), { recursive: true });
  await fsp.writeFile(path.join(root, "manifest.json"), `${JSON.stringify({
    formatVersion: "0.1",
    id,
    name: "依赖测试房间",
    version: "1.0.0",
    runtime: { roomSdk: "1", minimumWorkbench: "0.3.0-alpha.1" },
    entry: "app/index.html",
    permissions: { database: "private", network: [] },
    hostModules: [],
    embeddedDependencies: []
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(root, "app", "index.html"), "<!doctype html><title>dependency test</title>", "utf8");
}

test("bundler references workbench packages without copying them and embeds external packages", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-dependency-bundler-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const roomRoot = path.join(tempRoot, "room");
  await createRoomSource(roomRoot);

  const official = await bundleRoomDependency({ roomSourceRoot: roomRoot, packageName: "papaparse" });
  assert.equal(official.kind, "host-module");
  assert.equal(official.bundled, false);
  assert.deepEqual(official.manifest.hostModules, ["data.csv@1"]);
  await assert.rejects(() => fsp.access(path.join(roomRoot, "embedded", "npm.papaparse")), /ENOENT/);

  const packageRoot = path.join(tempRoot, "tiny-helper-package");
  await fsp.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fsp.writeFile(path.join(packageRoot, "LICENSE"), "MIT License\n\nCopyright Example\n", "utf8");
  await fsp.writeFile(path.join(packageRoot, "dist", "tiny-helper.min.js"), "window.TinyHelper={double:(value)=>value*2};\n", "utf8");
  const embedded = await bundleRoomDependency({
    roomSourceRoot: roomRoot,
    packageName: "tiny-helper",
    packageVersion: "2.1.0",
    license: "MIT",
    source: "npm:tiny-helper@2.1.0",
    packageRoot,
    licenseSource: "LICENSE",
    assets: [{ source: "dist/tiny-helper.min.js", target: "tiny-helper.min.js" }]
  });
  assert.equal(embedded.kind, "embedded");
  assert.equal(embedded.bundled, true);
  assert.equal(embedded.licenseReviewed, true);
  assert.equal(embedded.dependency.root, "embedded/npm.tiny-helper");
  assert.deepEqual(embedded.manifest.hostModules, ["data.csv@1"]);
  assert.equal(embedded.manifest.embeddedDependencies.length, 1);

  const packagePath = path.join(tempRoot, "dependency-room.room");
  await packDirectory(roomRoot, packagePath);
  const extracted = await extractAndValidate(packagePath, path.join(tempRoot, "extract"));
  assert.equal(extracted.manifest.embeddedDependencies[0].package, "tiny-helper");
  assert.equal(extracted.packageInfo.embeddedDependencies[0].fileCount, 2);
  assert.match(extracted.packageInfo.embeddedDependencies[0].contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    await fsp.readFile(path.join(extracted.stagingPath, "embedded", "npm.tiny-helper", "tiny-helper.min.js"), "utf8"),
    "window.TinyHelper={double:(value)=>value*2};\n"
  );

  const store = await new RoomStore(path.join(tempRoot, "data")).init();
  const inspection = await store.inspectPackage(packagePath, { source: "external" });
  assert.equal(inspection.room.hostModules[0], "data.csv@1");
  assert.equal(inspection.room.embeddedDependencies[0].package, "tiny-helper");
  assert.equal(inspection.package.embeddedDependencyCount, 1);
  assert.ok(inspection.risks.some((risk) => risk.code === "embedded-dependencies"));
  const installed = await store.commitImport(inspection.token, ["database.private"]);
  assert.equal(installed.embeddedDependencies[0].version, "2.1.0");
  const installedEntrypoint = await store.resolveProgramFile(installed.id, embedded.dependency.entrypoints[0]);
  assert.equal(await fsp.readFile(installedEntrypoint, "utf8"), "window.TinyHelper={double:(value)=>value*2};\n");
});

test("package rejects undeclared embedded files and duplicate copies of official packages", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-dependency-policy-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const roomRoot = path.join(tempRoot, "room");
  await createRoomSource(roomRoot, "cn.zhibian.dependency-policy-test");
  await fsp.mkdir(path.join(roomRoot, "embedded"), { recursive: true });
  await fsp.writeFile(path.join(roomRoot, "embedded", "rogue.js"), "window.rogue=true;", "utf8");
  await assert.rejects(() => packDirectory(roomRoot, path.join(tempRoot, "rogue.room")), /未声明的额外依赖文件/);

  await fsp.rm(path.join(roomRoot, "embedded", "rogue.js"), { force: true });
  const manifest = JSON.parse(await fsp.readFile(path.join(roomRoot, "manifest.json"), "utf8"));
  manifest.embeddedDependencies = [{
    id: "npm.papaparse",
    package: "papaparse",
    version: "5.7.0",
    license: "MIT",
    source: "npm:papaparse@5.7.0",
    root: "embedded/npm.papaparse",
    licenseFile: "embedded/npm.papaparse/LICENSE.txt",
    files: ["embedded/npm.papaparse/LICENSE.txt", "embedded/npm.papaparse/papaparse.min.js"],
    entrypoints: ["embedded/npm.papaparse/papaparse.min.js"]
  }];
  assert.equal(validateManifest(manifest).embeddedDependencies[0].package, "papaparse");
  await fsp.mkdir(path.join(roomRoot, "embedded", "npm.papaparse"), { recursive: true });
  await fsp.writeFile(path.join(roomRoot, "embedded", "npm.papaparse", "LICENSE.txt"), "MIT", "utf8");
  await fsp.writeFile(path.join(roomRoot, "embedded", "npm.papaparse", "papaparse.min.js"), "window.Papa={};", "utf8");
  await fsp.writeFile(path.join(roomRoot, "manifest.json"), JSON.stringify(manifest), "utf8");
  await assert.rejects(() => packDirectory(roomRoot, path.join(tempRoot, "duplicate-official.room")), /新房间不得重复打包/);

  const legacyPath = path.join(tempRoot, "legacy-duplicate.room");
  await packDirectory(roomRoot, legacyPath, { enforceCurrentDependencyPolicy: false });
  const store = await new RoomStore(path.join(tempRoot, "legacy-data")).init();
  const inspection = await store.inspectPackage(legacyPath, { source: "external" });
  assert.equal(inspection.room.embeddedDependencies[0].hostModuleEquivalent, "data.csv@1");
  assert.ok(inspection.risks.some((risk) => risk.code === "replaceable-embedded-dependencies"));
  const installed = await store.commitImport(inspection.token, ["database.private"]);
  const reexportedPath = path.join(tempRoot, "legacy-reexported.room");
  await store.exportRoom(installed.id, reexportedPath);
  assert.ok((await fsp.stat(reexportedPath)).size > 0);
});

test("unreviewed embedded dependency licenses are visible as high risk", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-dependency-license-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const roomRoot = path.join(tempRoot, "room");
  await createRoomSource(roomRoot, "cn.zhibian.dependency-license-test");
  const packageRoot = path.join(tempRoot, "custom-package");
  await fsp.mkdir(packageRoot, { recursive: true });
  await fsp.writeFile(path.join(packageRoot, "LICENSE"), "Custom license text", "utf8");
  await fsp.writeFile(path.join(packageRoot, "index.js"), "window.CustomPackage=true;", "utf8");
  await bundleRoomDependency({
    roomSourceRoot: roomRoot,
    packageName: "custom-package",
    packageVersion: "1.0.0",
    license: "LicenseRef-Organization-Review",
    source: "local:approved-media/custom-package-1.0.0",
    packageRoot,
    licenseSource: "LICENSE",
    assets: [{ source: "index.js", target: "index.js" }]
  });
  const packagePath = path.join(tempRoot, "custom.room");
  await packDirectory(roomRoot, packagePath);
  const store = await new RoomStore(path.join(tempRoot, "data")).init();
  const inspection = await store.inspectPackage(packagePath, { source: "external" });
  assert.equal(inspection.riskLevel, "high");
  assert.ok(inspection.risks.some((risk) => risk.code === "unreviewed-dependency-license"));
});
