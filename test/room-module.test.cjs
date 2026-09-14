"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOM_MODULE_CATALOG, expandHostModules, getPublicRoomModuleCatalog, recommendRoomModules } = require("../src/main/room-module-catalog.cjs");
const { resolveRoomModuleAsset } = require("../src/main/room-module-service.cjs");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("official room module catalog contains pinned and license-inventoried office, visualization and 3D modules", async () => {
  assert.equal(ROOM_MODULE_CATALOG.length, 39);
  assert.equal(new Set(ROOM_MODULE_CATALOG.map((module) => module.id)).size, ROOM_MODULE_CATALOG.length);
  assert.ok(ROOM_MODULE_CATALOG.every((module) => /^\d+\.\d+(?:\.\d+)?/.test(module.packageVersion)));
  assert.ok(ROOM_MODULE_CATALOG.every((module) => [
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "BSD-2-Clause",
    "ISC",
    "OFL-1.1"
  ].includes(module.selectedLicense)));
  assert.deepEqual(expandHostModules(["document.markdown@1"]), ["security.sanitize@1", "document.markdown@1"]);
  assert.deepEqual(expandHostModules(["document.pdf.compose@1"]), [
    "font.cjk@1",
    "document.pdf.fontkit@1",
    "document.pdf.compose@1"
  ]);
  assert.equal(ROOM_MODULE_CATALOG.find((module) => module.id === "document.spreadsheet@1").packageName, "xlsx");
  assert.equal(ROOM_MODULE_CATALOG.find((module) => module.id === "document.spreadsheet.rich@1").packageName, "exceljs");
  assert.equal(ROOM_MODULE_CATALOG.find((module) => module.id === "graphics.three@1").packageName, "three");
  assert.equal(ROOM_MODULE_CATALOG.find((module) => module.id === "physics.rapier@1").packageName, "@dimforge/rapier3d-compat");
  assert.equal(ROOM_MODULE_CATALOG.find((module) => module.id === "ui.datagrid@1").packageName, "tabulator-tables");
  assert.equal(ROOM_MODULE_CATALOG.find((module) => module.id === "diagram.mermaid@1").packageName, "mermaid");
  assert.equal(ROOM_MODULE_CATALOG.find((module) => module.id === "ui.chart.advanced@1").packageName, "echarts");
  assert.deepEqual(getPublicRoomModuleCatalog().find((module) => module.id === "editor.richtext@1").globals, ["Quill"]);
  assert.deepEqual(expandHostModules(["game.assets@1"]), ["graphics.three@1", "game.assets@1"]);
  const recommendations = recommendRoomModules("做一个可编辑数据网格和拖拽看板，包含流程图、热力图、富文本、地图、矩阵、回归、图片裁剪、白板、D3 和知识图谱");
  for (const moduleId of [
    "ui.datagrid@1", "ui.sortable@1", "diagram.mermaid@1", "ui.chart.advanced@1",
    "editor.richtext@1", "map.leaflet@1", "math.general@1", "stats.simple@1",
    "media.cropper@1", "graphics.canvas@1", "visualization.d3@1", "visualization.graph@1"
  ]) assert.ok(recommendations.includes(moduleId), `缺少推荐模块 ${moduleId}`);

  const resourcesRoot = path.resolve(__dirname, "..", "resources", "room-modules");
  const generated = JSON.parse(await fsp.readFile(path.join(resourcesRoot, "catalog.json"), "utf8"));
  assert.equal(generated.moduleCount, ROOM_MODULE_CATALOG.length);
  for (const module of generated.modules) {
    assert.ok((await fsp.stat(path.join(resourcesRoot, module.id, module.licenseFile ?? "LICENSE.txt"))).isFile());
    if (ROOM_MODULE_CATALOG.find((candidate) => candidate.id === module.id).noticeSource) {
      assert.ok((await fsp.stat(path.join(resourcesRoot, module.id, "NOTICE.txt"))).isFile());
    }
    for (const asset of module.assets) {
      const buffer = await fsp.readFile(path.join(resourcesRoot, ...asset.path.split("/")));
      assert.equal(buffer.length, asset.bytes);
      assert.equal(sha256(buffer), asset.sha256);
    }
  }
});

test("module resolver only serves assets explicitly declared by the room", () => {
  const resourcesRoot = path.resolve("resources", "room-modules");
  const resolved = resolveRoomModuleAsset({
    room: { hostModules: ["data.csv@1"] },
    relativePath: "_modules/data.csv@1/papaparse.min.js",
    resourcesRoot
  });
  assert.equal(resolved.module.id, "data.csv@1");
  assert.ok(resolved.filePath.endsWith(path.join("data.csv@1", "papaparse.min.js")));
  assert.throws(() => resolveRoomModuleAsset({
    room: { hostModules: [] },
    relativePath: "_modules/data.csv@1/papaparse.min.js",
    resourcesRoot
  }), /没有声明/);
  assert.throws(() => resolveRoomModuleAsset({
    room: { hostModules: ["data.csv@1"] },
    relativePath: "_modules/data.csv@1/LICENSE.txt",
    resourcesRoot
  }), /不存在/);
  const nested = resolveRoomModuleAsset({
    room: { hostModules: ["document.pdf.view@1"] },
    relativePath: "_modules/document.pdf.view@1/cmaps/78-EUC-H.bcmap",
    resourcesRoot
  });
  assert.equal(nested.contentType, "application/octet-stream");
  assert.ok(nested.filePath.endsWith(path.join("document.pdf.view@1", "cmaps", "78-EUC-H.bcmap")));
  assert.throws(() => resolveRoomModuleAsset({
    room: { hostModules: ["document.pdf.view@1"] },
    relativePath: "_modules/document.pdf.view@1/cmaps/../LICENSE.txt",
    resourcesRoot
  }), /路径无效/);
});

test("release compliance files cover the module catalog and use approved license families", async () => {
  const complianceRoot = path.resolve(__dirname, "..", "resources", "compliance");
  const sbom = JSON.parse(await fsp.readFile(path.join(complianceRoot, "sbom.cdx.json"), "utf8"));
  const properties = Object.fromEntries(sbom.metadata.properties.map((item) => [item.name, item.value]));
  assert.ok(Number(properties["cn.zhibian:production-component-count"]) > 0);
  assert.equal(properties["cn.zhibian:official-room-module-count"], String(ROOM_MODULE_CATALOG.length));
  assert.ok(Number(properties["cn.zhibian:official-room-source-component-count"]) > ROOM_MODULE_CATALOG.length);
  assert.equal(properties["cn.zhibian:packaged-third-party-component-count"], String(sbom.components.length));
  const allowed = new Set([
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "BSD-2-Clause",
    "BSD",
    "ISC",
    "0BSD",
    "OFL-1.1",
    "MIT/X11",
    "Unlicense",
    "BlueOak-1.0.0",
    "(MIT AND Zlib)",
    "(MIT OR GPL-3.0-or-later)",
    "(MPL-2.0 OR Apache-2.0)",
    "MIT OR SEE LICENSE IN FEEL-FREE.md"
  ]);
  for (const component of sbom.components) {
    const licenses = component.licenses.map((item) => item.license?.id ?? item.expression);
    assert.ok(licenses.length > 0, `${component.name} 缺少许可证`);
    assert.ok(licenses.every((license) => allowed.has(license)), `${component.name} 许可证未审核：${licenses.join(", ")}`);
  }
  const notices = await fsp.readFile(path.join(complianceRoot, "THIRD-PARTY-NOTICES.md"), "utf8");
  for (const module of ROOM_MODULE_CATALOG) {
    assert.match(notices, new RegExp(module.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("room CSP permits WebAssembly without enabling JavaScript eval or external connections", async () => {
  const source = await fsp.readFile(path.resolve(__dirname, "..", "src", "main", "room-protocol-handler.cjs"), "utf8");
  assert.match(source, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(source, /script-src 'self' 'unsafe-eval'/);
  assert.match(source, /connect-src 'self'/);
});
