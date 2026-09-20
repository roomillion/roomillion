"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RoomFileAccessService } = require("../src/main/room-file-access-service.cjs");
const { RoomBlobService } = require("../src/main/room-blob-service.cjs");
const { RoomJobService } = require("../src/main/room-job-service.cjs");
const { RoomDocumentService, markdownBlocks } = require("../src/main/room-document-service.cjs");
const { normalizeCustomRoomSpec, customRoomPermissions, inspectCustomRoomSpec } = require("../src/main/custom-room.cjs");
const { RoomToolService } = require("../src/main/room-tool-service.cjs");

function store(root) {
  return { dataRoot: root, getDataRoot: (roomId) => path.join(root, "rooms", roomId, "data") };
}

test("capability v2 maps explicit AI roles, model slots and directory permissions", () => {
  const spec = normalizeCustomRoomSpec({
    formatVersion: "room-app@1", kind: "custom", name: "书籍 OCR", description: "批量识别扫描书籍",
    hostModules: [],
    capabilities: {
      database: true,
      files: ["pickMany", "directoryRead", "directoryWrite", "export"],
      ai: { roles: ["vision", "general"], slots: { ocr: { role: "vision" }, "text-review": { role: "general", minimumContextWindow: 128000 } } },
      tools: ["document.markdown-to-pdf@1"], compute: ["worker"], network: [], browser: []
    },
    files: { html: "<main><h1>OCR</h1></main>", css: "main{display:block}", javascript: "window.room.jobs.recover();" }
  });
  assert.equal(spec.capabilities.ai, true);
  assert.deepEqual(spec.capabilities.aiRoles, ["vision", "general"]);
  assert.equal(spec.capabilities.modelSlots.ocr.requiresImages, true);
  assert.equal(spec.capabilities.modelSlots["text-review"].minimumContextWindow, 128000);
  assert.deepEqual(customRoomPermissions(spec), {
    database: "private",
    files: ["pickMany", "directoryRead", "directoryWrite", "export"],
    ai: { roles: ["vision", "general"], slots: {
      ocr: { role: "vision", requiresImages: true, minimumContextWindow: 0 },
      "text-review": { role: "general", requiresImages: false, minimumContextWindow: 128000 }
    } },
    network: [],
    compute: ["worker"],
    tools: ["document.markdown-to-pdf@1"]
  });
});

test("scoped directory grants list naturally, stream reads, persist, and write only inside the grant", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-directory-v2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  await fsp.mkdir(path.join(input, "chapter"), { recursive: true });
  await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(path.join(input, "page10.jpg"), "TEN");
  await fsp.writeFile(path.join(input, "page2.jpg"), "TWO");
  await fsp.writeFile(path.join(input, "chapter", "page3.png"), "THREE");
  const service = new RoomFileAccessService(root);
  const readGrant = await service.grant("room-a", input, "read");
  const listed = await service.list("room-a", readGrant.id, { extensions: ["jpg", "png"], limit: 2 });
  assert.deepEqual(listed.entries.map((item) => item.relativePath), ["chapter/page3.png", "page2.jpg"]);
  assert.equal(listed.nextCursor, 2);
  const page = await service.read("room-a", readGrant.id, "page10.jpg", { length: 3 });
  assert.equal(Buffer.from(page.data).toString(), "TEN");
  await assert.rejects(service.read("room-b", readGrant.id, "page10.jpg"), /授权/);
  await assert.rejects(service.read("room-a", readGrant.id, "../secret"), /越界/);
  const writeGrant = await service.grant("room-a", output, "write");
  const written = await service.write("room-a", writeGrant.id, "pages/0002.md", "# 第二页");
  assert.equal(written.bytes, Buffer.byteLength("# 第二页"));
  assert.equal(await fsp.readFile(path.join(output, "pages", "0002.md"), "utf8"), "# 第二页");
  const restored = new RoomFileAccessService(root);
  assert.equal((await restored.listGrants("room-a")).length, 2);
});

test("room blobs stream private data and artifacts without loading a whole project", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-blobs-v2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = new RoomBlobService(store(root));
  const opened = await service.begin("room-a", { name: "0001.md", mimeType: "text/markdown", kind: "artifact", metadata: { page: 1 } });
  await service.write("room-a", opened.token, "# 标题\n");
  await service.write("room-a", opened.token, "正文");
  const item = await service.finish("room-a", opened.token);
  assert.equal(item.size, Buffer.byteLength("# 标题\n正文"));
  assert.equal((await service.list("room-a", { kind: "artifact" }))[0].metadata.page, 1);
  const read = await service.read("room-a", item.id, { offset: 0, length: 100 });
  assert.equal(Buffer.from(read.data).toString(), "# 标题\n正文");
  await assert.rejects(service.read("room-b", item.id), /不存在/);
  assert.equal(await service.remove("room-a", item.id), true);
  assert.deepEqual(await service.list("room-a"), []);
});

test("PDF excludes metadata and comments without discarding ordinary book content", () => {
  const blocks = markdownBlocks('---\ntitle: "测试"\n---\n# 书名\n<!-- 页1 -->\n正文\n---\n<!-- 结束\n标记 -->\n');
  assert.deepEqual(blocks.filter(block => block.text).map(block => block.text), ["书名", "正文"]);
});

test("PDF recognizes Markdown tables and preserves cell content without treating code as a table", () => {
  const input = '| 日期 | 温度 |\n| :--- | ---: |\n| 4月6日 | 21.5℃ |\n| a\\|b | x |';
  assert.deepEqual(markdownBlocks(input), [{ table: { headers: ["日期", "温度"], rows: [["4月6日", "21.5℃"], ["a|b", "x"]] } }]);
  assert.equal(markdownBlocks('```\n' + input + '\n```').some(block => block.table), false);
});

test("Markdown documents render to paginated Chinese PDF artifacts", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-documents-v2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const blobs = new RoomBlobService(store(root));
  const documents = new RoomDocumentService({ resourcesPath: path.resolve(__dirname, "..", "resources"), blobService: blobs });
  const pdf = await documents.renderMarkdown("room-a", "# 第一章\n\n这是中文正文。\n\n## 小节\n\n- 项目一\n- 项目二\n\n| 日期 | 温度 |\n| --- | --- |\n| 4月6日 | 21.5℃ |" + "\n\n<!-- 空尾 -->\n".repeat(100), { title: "测试书籍", name: "book.pdf" });
  assert.equal(pdf.mimeType, "application/pdf");
  assert.equal(pdf.kind, "artifact");
  assert.equal(pdf.metadata.pages, 1, "尾部空白不能产生额外空白页");
  const stored = await blobs.getFile("room-a", pdf.id);
  assert.equal((await fsp.readFile(stored.path)).subarray(0, 4).toString(), "%PDF");
  const { PDFDocument, PDFName, decodePDFRawStream } = require("pdf-lib");
  const loaded = await PDFDocument.load(await fsp.readFile(stored.path));
  const fonts = loaded.getPages()[0].node.Resources().lookup(PDFName.of("Font"));
  const descendant = fonts.lookup(fonts.keys()[0]).lookup(PDFName.of("DescendantFonts")).lookup(0);
  assert.equal(descendant.get(PDFName.of("Subtype")).toString(), "/CIDFontType0");
  const descriptor = descendant.lookup(PDFName.of("FontDescriptor"));
  assert.equal(descriptor.has(PDFName.of("FontFile2")), false);
  const fontStream = descriptor.lookup(PDFName.of("FontFile3"));
  assert.equal(fontStream.dict.get(PDFName.of("Subtype")).toString(), "/OpenType");
  // Preserve the actual CJK outlines, not merely the extractable Unicode map.
  assert.deepEqual(Buffer.from(decodePDFRawStream(fontStream).decode()), await documents.fontBytes());
});

test("parallel OCR artifacts keep every index entry across writes, removals and restart", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-parallel-artifacts-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = new RoomBlobService(store(root));
  const items = await Promise.all(Array.from({ length: 12 }, (_, i) => service.put("room-a", { name: `${i}.md`, kind: "artifact" }, `page ${i}`)));
  assert.equal((await service.list("room-a")).length, 12);
  const added = await Promise.all(items.slice(0, 6).map(async (item, i) => {
    await service.remove("room-a", item.id);
    return service.put("room-a", { name: `new${i}.md`, kind: "artifact" }, `new ${i}`);
  }));
  const restored = new RoomBlobService(store(root));
  assert.deepEqual(new Set((await restored.list("room-a")).map(item => item.id)), new Set([...items.slice(6), ...added].map(item => item.id)));
  for (const item of added) assert.match(Buffer.from((await restored.read("room-a", item.id)).data).toString(), /^new /);
  await assert.rejects(restored.read("room-b", added[0].id), /不存在/);
});

test("durable jobs keep checkpoints and recover interrupted work to the queue", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-jobs-v2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const roomStore = store(root);
  const service = new RoomJobService(roomStore);
  const job = await service.create("room-a", { type: "book.ocr", total: 20, payload: { directoryGrantId: "opaque" } });
  const running = await service.transition("room-a", job.id, { state: "running", progress: { completed: 3, message: "第三页" }, checkpoint: { next: 4 } });
  assert.equal(running.attempts, 1);
  assert.deepEqual(running.checkpoint, { next: 4 });
  const restored = new RoomJobService(roomStore);
  assert.deepEqual(await restored.recover("room-a"), { recovered: 1, active: 1 });
  const queued = await restored.get("room-a", job.id);
  assert.equal(queued.state, "queued");
  assert.match(queued.error, /恢复/);
  await restored.transition("room-a", job.id, { state: "running" });
  const complete = await restored.transition("room-a", job.id, { state: "completed", result: { artifactId: "done" } });
  assert.equal(complete.result.artifactId, "done");
});

test("Web Worker requires an explicit compute grant while privileged workers stay blocked", () => {
  const base = {
    formatVersion: "room-app@1", kind: "custom", name: "本地计算", description: "在沙箱中执行批量排序",
    hostModules: [], capabilities: { database: false, files: [], ai: false, network: [], browser: [] },
    files: { html: "<main><h1>计算</h1><button>开始计算</button></main>", css: "main{min-height:20vh}", javascript: 'const worker = new Worker("./worker.js", { type: "module" }); document.querySelector("button").addEventListener("click",()=>worker.postMessage([2,1]));', "worker.js": "self.onmessage = event => postMessage(event.data.sort());" }
  };
  assert.equal(inspectCustomRoomSpec(base).report.errors.some((item) => item.code === "js.worker-undeclared"), true);
  const allowed = inspectCustomRoomSpec({ ...base, capabilities: { ...base.capabilities, compute: ["worker"] } });
  assert.equal(allowed.report.errors.some((item) => /worker/.test(item.code)), false);
  const privileged = inspectCustomRoomSpec({ ...base, capabilities: { ...base.capabilities, compute: ["worker"] }, files: { ...base.files, javascript: "navigator.serviceWorker.register('./worker.js');" } });
  assert.equal(privileged.report.errors.some((item) => item.code === "js.privileged-worker"), true);
});

test("host tools are discoverable and callable only when explicitly granted", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-tools-v2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const blobs = new RoomBlobService(store(root));
  const documents = new RoomDocumentService({ resourcesPath: path.resolve(__dirname, "..", "resources"), blobService: blobs });
  const tools = new RoomToolService({ documentService: documents, blobService: blobs });
  const room = { id: "room-a", permissions: { tools: ["document.markdown-to-pdf@1"] }, requestedPermissions: { tools: ["document.markdown-to-pdf@1"] }, grantedPermissions: { database: "private", tools: ["document.markdown-to-pdf@1"] } };
  assert.deepEqual(tools.list(room).map((item) => item.id), ["document.markdown-to-pdf@1"]);
  const pdf = await tools.call(room, "document.markdown-to-pdf@1", { source: "# 工具生成 PDF" });
  assert.equal(pdf.mimeType, "application/pdf");
  await assert.rejects(tools.call({ ...room, grantedPermissions: { database: "private", tools: [] } }, "document.markdown-to-pdf@1", { source: "x" }), /没有工具权限/);
});
