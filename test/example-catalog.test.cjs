"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EXAMPLE_CATALOG, resolveExamplePackages } = require("../src/main/example-catalog.cjs");
const { validateManifest } = require("../src/main/manifest.cjs");
const { extractAndValidate, packDirectory } = require("../src/main/room-package.cjs");

const projectRoot = path.resolve(__dirname, "..");

test("example catalog exposes six unique portable rooms", async () => {
  assert.equal(EXAMPLE_CATALOG.length, 6);
  assert.equal(new Set(EXAMPLE_CATALOG.map((item) => item.id)).size, EXAMPLE_CATALOG.length);
  assert.equal(new Set(EXAMPLE_CATALOG.map((item) => item.roomId)).size, EXAMPLE_CATALOG.length);
  for (const example of EXAMPLE_CATALOG) {
    const sourceRoot = path.join(projectRoot, "examples", example.id);
    const manifest = validateManifest(JSON.parse(await fsp.readFile(path.join(sourceRoot, "manifest.json"), "utf8")));
    assert.equal(manifest.id, example.roomId);
    assert.equal(manifest.name, example.name);
    assert.deepEqual(manifest.permissions.network, []);
    for (const requiredFile of ["app/index.html", "app/styles.css", "app/app.js"]) {
      assert.equal((await fsp.stat(path.join(sourceRoot, ...requiredFile.split("/")))).isFile(), true);
    }
    const program = (await Promise.all(["index.html", "styles.css", "app.js"].map((file) =>
      fsp.readFile(path.join(sourceRoot, "app", file), "utf8")
    ))).join("\n");
    assert.doesNotMatch(program, /https?:\/\//i, `${example.id} must not reference remote resources`);
    if (program.includes("room.db.")) assert.equal(manifest.permissions.database, "private");
    if (program.includes("room.files.pickText")) assert.ok(manifest.permissions.files?.includes("pick"));
    if (program.includes("room.files.pickBinary")) assert.ok(manifest.permissions.files?.includes("pick"));
    if (program.includes("room.files.exportText")) assert.ok(manifest.permissions.files?.includes("export"));
    if (program.includes("room.largeText.")) assert.ok(manifest.permissions.files?.includes("largeText"));
    if (program.includes("room.ai.generate")) assert.ok(manifest.permissions.ai?.roles?.length);
    if (program.includes("room.browser.")) assert.ok(manifest.permissions.browser?.includes("navigate"));
    if (example.id === "browser") {
      assert.deepEqual(manifest.permissions.browser, ["navigate", "download"]);
      assert.equal(manifest.permissions.database, "private");
      assert.match(program, /room\.browser\.setViewport/);
      assert.match(program, /await reportViewport\(\)/);
      assert.match(program, /room\.browser\.onStateChanged/);
      assert.match(program, /room\.browser\.onPermissionRequest/);
      assert.doesNotMatch(program, /<iframe|<webview|fetch\(|XMLHttpRequest/i);
    }
    if (example.id === "ai-debate") {
      assert.match(program, /room\.ai\.listModels/);
      assert.match(program, /room\.ai\.generate\(prompt, \{ profileId \}\)/);
      assert.doesNotMatch(program, /apiKey|baseUrl|fetch\(|EventSource/);
      assert.ok(manifest.permissions.files.includes("export"));
    }
    if (example.id === "ai-model-benchmark") {
      assert.equal(manifest.permissions.database, "private");
      assert.ok(manifest.permissions.ai.roles.includes("general"));
      assert.ok(manifest.permissions.ai.roles.includes("vision"));
      assert.match(program, /room\.ai\.listModels/);
      assert.match(program, /room\.ai\.generate\(result\.item\.prompt/);
      assert.match(program, /images, maxTokens/);
      assert.match(program, /CREATE TABLE IF NOT EXISTS benchmark_runs/);
      assert.match(program, /CREATE TABLE IF NOT EXISTS benchmark_custom_cases/);
      assert.match(program, /suite_version/);
      assert.match(program, /zhibian-benchmark-case@1/);
      assert.match(program, /resultDetailDialog/);
      assert.match(program, /customCaseDialog/);
      assert.ok(manifest.permissions.files.includes("pick"));
      assert.doesNotMatch(program, /apiKey|baseUrl|EventSource/);
    }
    if (example.id === "offline-3d-collector") {
      assert.deepEqual(manifest.hostModules, ["graphics.three@1", "physics.rapier@1", "game.input@1", "game.audio@1", "game.assets@1"]);
      assert.match(program, /window\.RAPIER\.init/);
    }
  }
});

test("every example packs and passes the cross-platform room contract", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-examples-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  for (const example of EXAMPLE_CATALOG) {
    const packagePath = path.join(tempRoot, example.packageName);
    await packDirectory(path.join(projectRoot, "examples", example.id), packagePath);
    const extracted = await extractAndValidate(packagePath, path.join(tempRoot, `extract-${example.id}`));
    assert.equal(extracted.manifest.id, example.roomId);
    assert.equal(extracted.packageInfo.portability.status, "portable");
    assert.deepEqual(extracted.packageInfo.portability.targets, ["win32-x64", "linux-x64"]);
  }
});

test("example package resolver keeps private paths out of public metadata", () => {
  const source = resolveExamplePackages({ isPackaged: false, appPath: "C:\\workbench", resourcesPath: "C:\\ignored" });
  const packaged = resolveExamplePackages({ isPackaged: true, appPath: "/ignored", resourcesPath: "/opt/zhibian/resources" });
  const sourceInventory = source.find((item) => item.id === "inventory");
  const packagedInventory = packaged.find((item) => item.id === "inventory");
  assert.equal(sourceInventory.packagePath, path.join("C:\\workbench", "resources", "examples", "inventory.room"));
  assert.equal(packagedInventory.packagePath, path.join("/opt/zhibian/resources", "examples", "inventory.room"));
  assert.equal(Object.hasOwn(sourceInventory, "packageName"), false);
});
