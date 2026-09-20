"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RoomStore } = require("../src/main/room-store.cjs");
const {
  applyCustomRuntimeCompatibility,
  analyzeCustomIndexPatch,
  createCustomRoom,
  generatedCustomBootstrap,
  generatedCustomIndexHtml,
  inspectCustomRoomSpec,
  loadCustomRoomSpec,
  validateCustomRoomSpec
} = require("../src/main/custom-room.cjs");

test("installed HTML patches preserve the host shell and validate new body content", () => {
  const spec = billiardsSpec();
  const html = generatedCustomIndexHtml(spec);
  assert.deepEqual(analyzeCustomIndexPatch(html, html.replace("</h1>", '</h1><button id="dedupe">去重</button>')), []);
  for (const inserted of ['<script>alert(1)</script>', '<button onclick="alert(1)">x</button>', '<iframe src="x"></iframe>']) {
    assert.ok(analyzeCustomIndexPatch(html, html.replace("</h1>", `</h1>${inserted}`)).some(item => item.severity === "error"));
  }
  for (const updated of [html.replace("./bootstrap.mjs", "./other.mjs"), html.replace('<meta charset="UTF-8">', '<script src="x"></script>'), html.replace('<body ', '<body onclick="alert(1)" ')]) {
    assert.ok(analyzeCustomIndexPatch(html, updated).some(item => item.code === "html.host-shell"));
  }
});

function billiardsSpec() {
  return {
    formatVersion: "room-app@1",
    kind: "custom",
    name: "离线 3D 台球练习室",
    description: "使用鼠标瞄准和击球的离线三维台球小游戏",
    theme: "dark",
    hostModules: ["graphics.three@1", "game.audio@1"],
    capabilities: { database: false, files: [], ai: false },
    files: {
      html: `<main class="game-shell"><header><h1>离线 3D 台球</h1><p>拖动鼠标瞄准，释放击球</p><button id="restart" type="button">重新开始</button></header><section id="score" aria-live="polite">得分 0</section><div id="viewport"></div></main>`,
      css: `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07120e;color:#effff7;font-family:sans-serif}.game-shell{min-height:100dvh;display:grid;grid-template-rows:auto auto 1fr}header{display:flex;gap:1rem;align-items:center;padding:1rem}#viewport{min-height:60vh}canvas{display:block;width:100%;height:100%}@media(max-width:700px){header{align-items:flex-start;flex-direction:column}}`,
      javascript: `const viewport=document.getElementById("viewport");
const score=document.getElementById("score");
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(50,1,0.1,100);
camera.position.set(0,7,9);
const renderer=new THREE.WebGLRenderer({antialias:true});
viewport.appendChild(renderer.domElement);
const ball=new THREE.Mesh(new THREE.SphereGeometry(0.3),new THREE.MeshStandardMaterial({color:0xffffff}));
scene.add(ball,new THREE.HemisphereLight(0xffffff,0x223322,2));
let velocity=0;
function resize(){renderer.setSize(Math.max(1,viewport.clientWidth),Math.max(1,viewport.clientHeight));camera.aspect=Math.max(1,viewport.clientWidth)/Math.max(1,viewport.clientHeight);camera.updateProjectionMatrix();}
function restart(){ball.position.set(0,0,0);velocity=0;score.textContent="得分 0";}
renderer.domElement.addEventListener("pointerdown",()=>{velocity=0.08;});
document.getElementById("restart").addEventListener("click",restart);
window.addEventListener("resize",resize);resize();
function frame(){ball.position.x+=velocity;velocity*=0.98;if(Math.abs(ball.position.x)>3)velocity*=-1;renderer.render(scene,camera);requestAnimationFrame(frame);}frame();`
    }
  };
}

test("custom room lint reports injection line numbers and requires portable persistent storage", () => {
  const spec = billiardsSpec();
  spec.files.javascript = 'const x = document.createElement("div");\nx.innerHTML = "unsafe";\nlocalStorage.setItem("records","[]");';
  const report = inspectCustomRoomSpec(spec).report;
  assert.equal(report.errors.find(error => error.code === "js.html-injection").line, 2);
  assert.ok(report.errors.some(error => error.code === "js.volatile-storage"));
  spec.files.javascript = 'window.room.storage.set("records",[]);';
  assert.ok(inspectCustomRoomSpec(spec).report.errors.some(error => error.code === "js.database-undeclared"));
  spec.capabilities.database = true;
  assert.equal(inspectCustomRoomSpec(spec).report.passed, true);
});

test("custom room reports malformed declared scenarios before Electron startup", () => {
  const spec = billiardsSpec();
  spec.files["room-tests.json"] = "[内容已由 Harness 保存；需要复查时使用读取工具]";
  let report = inspectCustomRoomSpec(spec).report;
  assert.equal(report.passed, false);
  assert.equal(report.errors.find(error => error.code === "tests.invalid")?.file, "room-tests.json");
  spec.files["room-tests.json"] = JSON.stringify({ version: 1, scenarios: [{ name: "重开", actions: [{ type: "assertExists", selector: "#restart" }] }] });
  report = inspectCustomRoomSpec(spec).report;
  assert.equal(report.passed, true);
});

test("a local node property is allowed while Node module specifiers stay forbidden", () => {
  const spec = billiardsSpec();
  spec.files.javascript = 'const live = { text: "", node: null }; live.node = document.createElement("p");';
  assert.equal(inspectCustomRoomSpec(spec).report.passed, true);
  for (const literal of ['"node:fs"', "'node:fs'", '`node:fs`']) {
    spec.files.javascript = `const moduleName = ${literal};`;
    assert.ok(inspectCustomRoomSpec(spec).report.errors.some(error => error.code === "js.node"));
  }
});

test("room-app@1 accepts material offline code and expands only built-in modules", () => {
  const inspected = inspectCustomRoomSpec(billiardsSpec());
  assert.equal(inspected.report.passed, true);
  assert.deepEqual(inspected.spec.hostModules, ["graphics.three@1", "game.audio@1"]);
  assert.equal(inspected.report.checks.noExternalNetwork, true);
  assert.equal(inspected.report.checks.noHostEscape, true);
  assert.ok(inspected.report.metrics.javascriptCharacters > 500);
  assert.match(generatedCustomBootstrap(inspected.spec.hostModules), /import\("\.\/app\.js"\)/);
});

test("room-app@1 loads declared shared module styles before room styles", () => {
  const candidate = billiardsSpec();
  candidate.hostModules = ["ui.datagrid@1", "editor.richtext@1", "map.leaflet@1"];
  const spec = validateCustomRoomSpec(candidate).spec;
  const html = generatedCustomIndexHtml(spec);
  for (const asset of ["tabulator.min.css", "quill.snow.css", "leaflet.css"]) assert.match(html, new RegExp(asset.replace(".", "\\.")));
  assert.ok(html.indexOf("tabulator.min.css") < html.indexOf("./styles.css"));
  assert.ok(html.indexOf("quill.js") < html.indexOf("./bootstrap.mjs"));
});

test("custom room runtime initializes Rapier before app code and upgrades legacy bootstraps", () => {
  const modules = ["graphics.three@1", "physics.rapier@1"];
  const bootstrap = generatedCustomBootstrap(modules);
  assert.match(bootstrap, /zhibian-runtime:rapier-ready@1/);
  assert.ok(bootstrap.indexOf("await globalThis.RAPIER.init()") < bootstrap.indexOf('await import(".\/app.js")'));

  const legacy = '"use strict";\nawait import("./app.js");\n';
  const upgraded = applyCustomRuntimeCompatibility(legacy, modules);
  assert.match(upgraded, /await globalThis\.RAPIER\.init\(\)/);
  assert.ok(upgraded.indexOf("RAPIER.init") < upgraded.indexOf('import("./app.js")'));
  assert.equal(applyCustomRuntimeCompatibility(upgraded, modules), upgraded);
  assert.equal(applyCustomRuntimeCompatibility(legacy, ["graphics.three@1"]), legacy);
});

test("room-app@1 blocks external, host, dynamic-code and HTML injection escape routes", () => {
  const cases = [
    ["fetch('https://example.com')", /网络|外部 URL/],
    ["require('node:fs')", /Node\.js/],
    ["eval('2+2')", /eval/],
    ["document.body.innerHTML='<b>bad</b>'", /HTML 字符串注入/]
  ];
  for (const [javascript, expected] of cases) {
    const candidate = billiardsSpec();
    candidate.files.javascript += `\n${javascript};`;
    assert.throws(() => validateCustomRoomSpec(candidate), expected);
  }
  const inline = billiardsSpec();
  inline.files.html = `<main><h1>危险</h1><button onclick="run()">执行</button></main>`;
  assert.throws(() => validateCustomRoomSpec(inline), /内联事件/);
});

test("room-app@1 allows declared origins only through the controlled Room SDK", () => {
  const controlled = billiardsSpec();
  controlled.capabilities.network = ["https://api.example.com"];
  controlled.files.javascript += `\nasync function refreshScore(){const response=await window.room.network.request({url:"https://api.example.com/scores",timeoutMs:5000});if(!response.ok)throw new Error("服务暂不可用");score.textContent=JSON.parse(response.text).label;}\ndocument.getElementById("score").addEventListener("dblclick",()=>refreshScore().catch((error)=>{score.textContent=error.message;}));`;
  const inspected = validateCustomRoomSpec(controlled);
  assert.equal(inspected.report.passed, true);
  assert.deepEqual(inspected.spec.capabilities.network, ["https://api.example.com"]);
  assert.equal(inspected.report.metrics.networkOriginCount, 1);

  const undeclared = structuredClone(controlled);
  undeclared.capabilities.network = [];
  assert.throws(() => validateCustomRoomSpec(undeclared), /未在 capabilities\.network 声明|没有声明服务源/);

  const direct = structuredClone(controlled);
  direct.files.javascript += `\nfetch("https://api.example.com/scores");`;
  assert.throws(() => validateCustomRoomSpec(direct), /直接网络 API/);
});

test("room-app@1 allows arbitrary web navigation only through declared room.browser", () => {
  const browser = billiardsSpec();
  browser.name = "浏览器外壳";
  browser.capabilities.browser = ["navigate", "download"];
  browser.files.javascript += `\nasync function openSite(){const state=await window.room.browser.getState();const tab=state.tabs[0]||null;if(tab)await window.room.browser.navigate(tab.id,"https://example.com");}\ndocument.getElementById("score").addEventListener("dblclick",()=>openSite().catch((error)=>{score.textContent=error.message;}));`;
  const inspected = validateCustomRoomSpec(browser);
  assert.deepEqual(inspected.spec.capabilities.browser, ["navigate", "download"]);
  assert.equal(inspected.report.checks.controlledBrowserOnly, true);
  assert.equal(inspected.report.metrics.browserCapabilityCount, 2);

  const undeclared = structuredClone(browser);
  undeclared.capabilities.browser = [];
  assert.throws(() => validateCustomRoomSpec(undeclared), /capabilities\.browser|外部 URL/);

  const downloadOnly = billiardsSpec();
  downloadOnly.capabilities.browser = ["download"];
  assert.throws(() => validateCustomRoomSpec(downloadOnly), /同时声明 navigate/);
});

test("custom room compiler installs and reloads a self-contained shared-module room", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-custom-room-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const first = await createCustomRoom({ spec: billiardsSpec(), roomStore });
  assert.equal(first.room.version, "1.0.0");
  assert.deepEqual(first.room.embeddedDependencies, []);
  const programRoot = roomStore.getProgramRoot(first.room.id);
  const manifest = JSON.parse(await fsp.readFile(path.join(programRoot, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions.network, []);
  assert.deepEqual(manifest.embeddedDependencies, []);
  assert.deepEqual(manifest.hostModules, ["graphics.three@1", "game.audio@1"]);
  assert.equal(manifest.icon, "assets/icon.svg");
  const firstIcon = await fsp.readFile(path.join(programRoot, "assets", "icon.svg"));
  assert.match(firstIcon.toString("utf8"), />离线</);
  const indexHtml = await fsp.readFile(path.join(programRoot, "app", "index.html"), "utf8");
  assert.match(indexHtml, /\/_modules\/graphics\.three@1\/three\.min\.js/);
  assert.doesNotMatch(indexHtml, /https?:\/\//i);
  const restored = await loadCustomRoomSpec(roomStore, first.room.id);
  assert.equal(restored.name, billiardsSpec().name);
  assert.match(restored.files.javascript, /THREE\.WebGLRenderer/);

  const changed = billiardsSpec();
  changed.name = "离线 3D 台球挑战赛";
  changed.files.html = changed.files.html.replace("练习室", "挑战赛");
  const updated = await createCustomRoom({ spec: changed, roomStore, roomId: first.room.id, version: "1.0.1" });
  assert.equal(updated.room.id, first.room.id);
  assert.equal(updated.room.version, "1.0.1");
  assert.deepEqual(await fsp.readFile(path.join(programRoot, "assets", "icon.svg")), firstIcon);
  assert.equal((await loadCustomRoomSpec(roomStore, first.room.id)).name, changed.name);
});

test("custom room packages and restores arbitrary local ES modules", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-custom-modules-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const roomStore = await new RoomStore(dataRoot).init();
  const spec = billiardsSpec();
  spec.files.javascript = 'import { label } from "./modules/label.js";\ndocument.getElementById("score").textContent=label;';
  spec.files["modules/label.js"] = 'export const label = "多文件已启动";';
  spec.files["styles/panel.css"] = ".panel{display:grid}";
  spec.files["assets/defaults.json"] = '{"level":1}';
  const built = await createCustomRoom({ spec, roomStore });
  const programRoot = roomStore.getProgramRoot(built.room.id);
  assert.equal(await fsp.readFile(path.join(programRoot, "app", "modules", "label.js"), "utf8"), spec.files["modules/label.js"]);
  assert.match(await fsp.readFile(path.join(programRoot, "app", "index.html"), "utf8"), /styles\/panel\.css/);
  const restored = await loadCustomRoomSpec(roomStore, built.room.id);
  assert.equal(restored.files["assets/defaults.json"], spec.files["assets/defaults.json"]);
  assert.equal(restored.files["modules/label.js"], spec.files["modules/label.js"]);
});

test("custom room can package a creator-supplied image as its icon", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-custom-icon-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const iconFile = path.join(dataRoot, "creator.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await fsp.writeFile(iconFile, png);
  const roomStore = await new RoomStore(path.join(dataRoot, "data")).init();
  const built = await createCustomRoom({ spec: billiardsSpec(), roomStore, iconFile });
  assert.equal(built.room.icon, "assets/icon.png");
  assert.deepEqual(await fsp.readFile(path.join(roomStore.getProgramRoot(built.room.id), "assets", "icon.png")), png);
});
