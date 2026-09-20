"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { runWorker, validateRoomRuntime, declaredRuntimeTimeout } = require("../src/main/room-runtime-validator.cjs");

test("runtime timeout includes declared waits and reloads with a bounded ceiling", () => {
  assert.equal(declaredRuntimeTimeout(undefined), 45000);
  const definition = { version: 1, scenarios: [{ actions: [{ type: "wait", ms: 5000 }, { type: "reload" }, { type: "click", selector: "button" }] }] };
  assert.equal(declaredRuntimeTimeout(definition), 62100);
  definition.scenarios[0].actions = Array.from({ length: 100 }, () => ({ type: "wait", ms: 5000 }));
  assert.equal(declaredRuntimeTimeout(definition), 300000);
});

function stalledWorker() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.destroy = () => { child.stderrDestroyed = true; };
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test("runtime check timeout finishes even when the Electron child never emits exit or close", async () => {
  const child = stalledWorker();
  await assert.rejects(runWorker("input.json", null, 20, () => child), /运行检查超时/);
  assert.equal(child.killed, true);
  assert.equal(child.stderrDestroyed, true);
});

test("declared OCR fixtures exercise real file handles, directory paging and persisted image blobs", async () => {
  const spec = {
    formatVersion: "room-app@1", kind: "custom", name: "书页输入契约回归", description: "虚构图片验证读取、模型入参和重载", theme: "light", hostModules: [],
    capabilities: { database: true, files: ["pickMany", "directoryRead"], ai: { roles: ["vision"] } },
    files: {
      html: '<main><button id="pick">选择图片</button><button id="folder">选择文件夹</button><button id="ocr">识别</button><output id="out"></output></main>',
      css: 'main{padding:20px;display:grid;gap:20px}',
      javascript: `const out=document.getElementById('out');
document.getElementById('pick').onclick=async()=>{try{const [f]=await room.files.pickMany({extensions:['png']}); if(f.read)throw Error('不是纯句柄'); const c=await room.files.readBinary(f.token,{offset:0,length:4}); await room.files.closeBinary(f.token);const blob=await room.blobs.put({name:f.name,mimeType:'image/png'},c.data); await room.storage.set('image',blob.id);out.textContent='已保存 '+f.name+' '+c.nextOffset;}catch(e){out.textContent=e.message;}};
document.getElementById('folder').onclick=async()=>{try{const g=await room.files.openDirectory();const p=await room.files.listDirectory(g.id,{limit:1,extensions:['png']});const c=await room.files.readDirectoryFile(g.id,p.entries[0].relativePath,{offset:0,length:4});out.textContent='目录 '+p.entries[0].name+' '+c.nextOffset;}catch(e){out.textContent=e.message;}};
document.getElementById('ocr').onclick=async()=>{try{const id=await room.storage.get('image');if(!id)return;const models=await room.ai.listModels(); const r=await room.ai.generate('OCR',{profileId:models[0].id,images:[{blobId:id}]});out.textContent=r.text;}catch(e){out.textContent=e.message;}};`,
      "room-tests.json": JSON.stringify({ version: 1, mocks: { files: [{ name: "page1.png", base64: "iVBORw0KGgo=" }], ai: [{ text: "识别一页", expectedImageCount: 1 }] }, scenarios: [{ name: "图片读取与重载", actions: [
        { type: "click", selector: "#pick" }, { type: "wait", ms: 300 }, { type: "assertText", selector: "#out", value: "已保存 page1.png 4" },
        { type: "click", selector: "#folder" }, { type: "wait", ms: 300 }, { type: "assertText", selector: "#out", value: "目录 page1.png 4" },
        { type: "reload" }, { type: "click", selector: "#ocr" }, { type: "wait", ms: 300 }, { type: "assertText", selector: "#out", value: "识别一页" }
      ] }] })
    }
  };
  const result = await validateRoomRuntime({ spec });
  assert.equal(result.passed, true, JSON.stringify(result));
});

test("runtime check abort finishes without waiting for a stuck child process", async () => {
  const child = stalledWorker();
  const controller = new AbortController();
  const pending = runWorker("input.json", controller.signal, 10_000, () => child);
  controller.abort();
  await assert.rejects(pending, /运行检查已停止/);
  assert.equal(child.killed, true);
});

test("isolated document SDK creates a real Chinese PDF artifact through the preload bridge", async () => {
  const spec = {
    formatVersion: "room-app@1", kind: "custom", name: "PDF接口回归", description: "生成并读取中文PDF制品", theme: "light", hostModules: [],
    capabilities: { database: true, files: [], ai: false },
    files: {
      html: '<main><button id="pdf">生成PDF</button><output id="out"></output></main>', css: 'main{padding:20px}',
      javascript: `document.getElementById('pdf').onclick=async()=>{try{const item=await room.documents.markdownToPdf('# 第一章\\n\\n中文正文',{title:'测试书籍',name:'book.pdf'});const chunk=await room.artifacts.read(item.id,{offset:0,length:4});document.getElementById('out').textContent=String.fromCharCode(...chunk.data)+' '+item.metadata.pages;}catch(e){document.getElementById('out').textContent=e.message;}};`,
      "room-tests.json": JSON.stringify({ version: 1, scenarios: [{ name: "真实PDF文件头", actions: [{ type: "click", selector: "#pdf" }, { type: "wait", ms: 3000 }, { type: "assertText", selector: "#out", value: "%PDF 1" }] }] })
    }
  };
  const result = await validateRoomRuntime({ spec });
  assert.equal(result.passed, true, JSON.stringify(result));
});

test("runtime check resolves when the browser process exits even if stderr stays open", async () => {
  const child = stalledWorker();
  const pending = runWorker("input.json", null, 10_000, () => child);
  child.emit("exit", 0);
  await pending;
  assert.equal(child.killed, undefined);
  assert.equal(child.stderrDestroyed, true);
});

test("AI text deltas reach room callbacks and complete before the final result", async () => {
  const spec = {
    formatVersion: "room-app@1",
    kind: "custom",
    name: "合成翻译测试房间",
    description: "用模拟模型验证翻译输入和增量译文",
    theme: "light",
    hostModules: [],
    capabilities: { database: false, files: [], ai: true },
    files: {
      html: '<main><textarea id="source"></textarea><button id="translate">翻译</button><output id="target"></output></main>',
      css: 'body{font-family:sans-serif}main{display:grid;gap:1rem;padding:1rem}textarea{min-height:8rem}',
      javascript: `const source = document.getElementById("source");
const target = document.getElementById("target");
document.getElementById("translate").addEventListener("click", async () => {
  target.textContent = "";
  let chunks = 0;
  try {
    const result = await window.room.ai.generate("请翻译：" + source.value, {
      onChunk: delta => { chunks += 1; target.textContent += delta; }
    });
    if (chunks < 2 || target.textContent !== result.text) target.textContent = "增量不完整";
  } catch (error) { target.textContent = "调用失败：" + error.message; }
});`,
      "room-tests.json": JSON.stringify({
        version: 1,
        mocks: { ai: [{ text: "Hello world" }] },
        scenarios: [{ name: "翻译流式输出", actions: [
          { type: "input", selector: "#source", value: "你好，世界" },
          { type: "click", selector: "#translate" },
          { type: "wait", ms: 300 },
          { type: "assertText", selector: "#target", value: "Hello world" }
        ] }]
      })
    }
  };
  const result = await validateRoomRuntime({ spec });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.checks.find(check => check.id === "declared-scenarios")?.passed, true);
});

test("isolated exports reject invalid arguments and preserve real cancellation results", async () => {
  const spec = {
    formatVersion: "room-app@1", kind: "custom", name: "导出契约回归", description: "核对隔离与真实导出的参数及取消契约", theme: "light",
    hostModules: [], capabilities: { database: false, files: ["export"], ai: false },
    files: {
      html: '<main><button id="invalid">错误参数</button><button id="cancel">取消保存</button><output id="result"></output></main>',
      css: 'main{padding:20px;display:grid;gap:20px}',
      javascript: `const out = document.getElementById("result");
document.getElementById("invalid").addEventListener("click", async () => {
  let rejected = 0;
  try { await window.room.files.exportText({ suggestedName: "test.csv", content: "编号\\n001" }); } catch (error) { if (error.message.includes("导出内容必须是文本")) rejected += 1; }
  try { await window.room.files.exportBinary("test.bin", "text"); } catch (error) { if (error.message.includes("ArrayBuffer")) rejected += 1; }
  try { await window.room.files.exportBinary("test.bin", new Uint8Array()); } catch (error) { if (error.message.includes("不能为空")) rejected += 1; }
  out.textContent = "拒绝错误参数 " + rejected;
});
document.getElementById("cancel").addEventListener("click", async () => {
  const text = await window.room.files.exportText("test.csv", "编号\\n001");
  const binary = await window.room.files.exportBinary("test.bin", new Uint8Array([1]));
  out.textContent = text === null && binary === null ? "已取消" : "错误成功";
});`,
      "room-tests.json": JSON.stringify({ version: 1, scenarios: [{ name: "真实导出参数与取消", actions: [
        { type: "click", selector: "#invalid" }, { type: "assertText", selector: "#result", value: "拒绝错误参数 3" },
        { type: "click", selector: "#cancel" }, { type: "assertText", selector: "#result", value: "已取消" }
      ] }] })
    }
  };
  const result = await validateRoomRuntime({ spec });
  assert.equal(result.passed, true, JSON.stringify(result));
});

test("business scenarios distinguish durable storage from memory across reload", async () => {
  const spec = {
    formatVersion: "room-app@1", kind: "custom", name: "持久化回归", description: "测试页面重载后的私有存储", theme: "light",
    hostModules: [], capabilities: { database: true, files: [], ai: false },
    files: {
      html: '<main><button id="save">保存测试记录</button><output id="result"></output></main>',
      css: 'body{padding:20px}main{display:grid;gap:20px}',
      javascript: `const result = document.getElementById("result");
window.room.storage.get("record").then(value => { result.textContent = value || "空"; });
document.getElementById("save").addEventListener("click", async () => {
  await window.room.storage.set("record", "合成记录");
  result.textContent = "合成记录";
});`,
      "room-tests.json": JSON.stringify({ version: 1, scenarios: [{ name: "保存并重载", actions: [
        { type: "click", selector: "#save" }, { type: "wait", ms: 150 },
        { type: "assertText", selector: "#result", value: "合成记录" },
        { type: "reload" }, { type: "wait", ms: 150 },
        { type: "assertText", selector: "#result", value: "合成记录" }
      ] }] })
    }
  };
  const persisted = await validateRoomRuntime({ spec });
  assert.equal(persisted.passed, true, JSON.stringify(persisted));
  spec.files.javascript = `const result = document.getElementById("result");
result.textContent = "空";
document.getElementById("save").addEventListener("click", () => { result.textContent = "合成记录"; });`;
  const memoryOnly = await validateRoomRuntime({ spec });
  assert.equal(memoryOnly.passed, false);
  assert.match(memoryOnly.checks.find(check => check.id === "declared-scenarios").error, /实际为 "空"/);
});

test("room cancellation crosses the real preload bridge and a new translation can finish", async () => {
  const spec = {
    formatVersion: "room-app@1", kind: "custom", name: "取消回归", description: "测试增量请求取消", theme: "light",
    hostModules: [], capabilities: { database: false, files: [], ai: true },
    files: {
      html: '<main><button id="run">翻译</button><button id="cancel">取消</button><output id="result"></output></main>',
      css: 'body{padding:20px}main{display:grid;gap:20px}',
      javascript: `const out = document.getElementById("result"); let active, count = 0;
document.getElementById("run").addEventListener("click", async () => {
  if (active) return;
  const id = "test-" + (++count); active = id; out.textContent = "";
  try {
    const result = await window.room.ai.generate("synthetic", { requestId: id, onChunk: (_delta, full) => { if (active === id) out.textContent = full; } });
    if (active === id) out.textContent = result.text;
  } catch (error) { if (active === id) out.textContent = error.message; }
  finally { if (active === id) active = null; }
});
document.getElementById("cancel").addEventListener("click", async () => {
  const id = active; if (!id) return; active = null;
  const result = await window.room.ai.cancel(id); out.textContent = result.cancelled ? "已取消" : "未取消";
});`,
      "room-tests.json": JSON.stringify({ version: 1, mocks: { ai: [{ text: "partial translation", chunkDelayMs: 80 }, { text: "new complete" }] }, scenarios: [
        { name: "取消后不再追加", actions: [
          { type: "click", selector: "#run", count: 12 }, { type: "click", selector: "#cancel", count: 12 },
          { type: "wait", ms: 300 }, { type: "assertText", selector: "#result", value: "已取消" }
        ] },
        { name: "新请求成功", actions: [
          { type: "click", selector: "#run" }, { type: "wait", ms: 100 },
          { type: "assertText", selector: "#result", value: "new complete" }
        ] }
      ] })
    }
  };
  const result = await validateRoomRuntime({ spec });
  assert.equal(result.passed, true, JSON.stringify(result));
});
