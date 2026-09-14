"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const iconv = require("iconv-lite");
const {
  LargeTextService,
  detectEncoding,
  normalizeEncoding
} = require("../src/main/large-text-service.cjs");

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-large-text-test-"));
  const service = new LargeTextService({ defaultChunkBytes: 4096, maxChunkBytes: 8192 });
  t.after(async () => {
    await service.dispose();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, service };
}

function waitForTask(service, roomId, token, query, options = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const task = service.startSearch(roomId, token, query, options, (event) => {
      events.push(event);
      if (event.type === "complete" || event.type === "cancelled") resolve({ task, event, events });
      if (event.type === "error") reject(new Error(event.message));
    });
  });
}

test("encoding detection recognizes BOM, UTF-8 and aliases", () => {
  assert.equal(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 65])).encoding, "utf8");
  assert.equal(detectEncoding(Buffer.from([0xff, 0xfe, 65, 0])).encoding, "utf16le");
  assert.equal(detectEncoding(Buffer.from("中文 UTF-8", "utf8")).encoding, "utf8");
  assert.equal(normalizeEncoding("GBK"), "gb18030");
  assert.throws(() => normalizeEncoding("binary"), /不支持的文本编码/);
});

test("large text is decoded in bounded chunks without exposing its path", async (t) => {
  const { root, service } = await fixture(t);
  const source = `${"甲乙丙丁\n".repeat(1800)}跨块结尾`;
  const filePath = path.join(root, "large-utf8.txt");
  await fsp.writeFile(filePath, source, "utf8");

  const opened = await service.open("room.a", filePath, { encoding: "auto" });
  assert.equal(opened.name, "large-utf8.txt");
  assert.equal(opened.encoding, "utf8");
  assert.equal(Object.hasOwn(opened, "path"), false);
  assert.equal(Object.hasOwn(opened, "filePath"), false);

  let reconstructed = "";
  let chunkCount = 0;
  while (true) {
    const chunk = await service.readNext("room.a", opened.token, { maxBytes: 4096 });
    reconstructed += chunk.text;
    chunkCount += 1;
    assert.ok(chunk.bytesRead <= 4096);
    if (chunk.eof) break;
  }
  assert.ok(chunkCount > 2);
  assert.equal(reconstructed, source);
  assert.equal((await service.readNext("room.a", opened.token)).text, "");
  await assert.rejects(() => service.readNext("room.b", opened.token), /令牌无效/);
});

test("a sparse file larger than 1 GiB opens without whole-file allocation", async (t) => {
  const { root, service } = await fixture(t);
  const filePath = path.join(root, "over-one-gib.txt");
  const size = 1024 * 1024 * 1024 + 1024 * 1024;
  const handle = await fsp.open(filePath, "w");
  await handle.write(Buffer.from("start\n", "utf8"), 0, 6, 0);
  await handle.truncate(size);
  await handle.close();
  const opened = await service.open("room.gib", filePath);
  assert.equal(opened.size, size);
  const chunk = await service.readNext("room.gib", opened.token, { maxBytes: 4096 });
  assert.equal(chunk.bytesRead, 4096);
  assert.equal(chunk.position, 4096);
  assert.equal(chunk.eof, false);
  await assert.rejects(() => service.readNext("room.gib", opened.token, null), /选项必须是对象/);
});

test("GB18030 content survives decoder boundaries and encoding changes reset position", async (t) => {
  const { root, service } = await fixture(t);
  const source = `${"中文编码测试，千万间 Roomillion。\n".repeat(900)}完成`;
  const filePath = path.join(root, "legacy.txt");
  await fsp.writeFile(filePath, iconv.encode(source, "gb18030"));
  let opened = await service.open("room.gb", filePath, { encoding: "auto" });
  assert.equal(opened.encoding, "gb18030");
  opened = await service.setEncoding("room.gb", opened.token, "gbk");
  assert.equal(opened.encoding, "gb18030");
  const first = await service.readNext("room.gb", opened.token, { maxBytes: 4097 });
  let reconstructed = first.text;
  while (true) {
    const chunk = await service.readNext("room.gb", opened.token, { maxBytes: 4097 });
    reconstructed += chunk.text;
    if (chunk.eof) break;
  }
  assert.equal(reconstructed, source);
  const reset = await service.reset("room.gb", opened.token);
  assert.equal(reset.position, 0);
});

test("background search handles chunk boundaries and very long lines", async (t) => {
  const { root, service } = await fixture(t);
  const prefix = "x".repeat(262140);
  const source = `首行\n中文 Needle 一\n${prefix}NEEDLE跨块\n末行 needle`;
  const filePath = path.join(root, "search.log");
  await fsp.writeFile(filePath, source, "utf8");
  const opened = await service.open("room.search", filePath);
  const { event, events } = await waitForTask(service, "room.search", opened.token, "needle", { maxResults: 10 });
  assert.equal(event.type, "complete");
  assert.equal(event.truncated, false);
  assert.equal(event.results.length, 3);
  assert.equal(event.results[0].line, 2);
  assert.equal(event.results[0].column, 4);
  assert.equal(event.results[1].line, 3);
  assert.ok(events.some((item) => item.type === "progress"));
});

test("search result caps, cancellation and changed-file checks are enforced", async (t) => {
  const { root, service } = await fixture(t);
  const filePath = path.join(root, "limits.txt");
  await fsp.writeFile(filePath, "hit\n".repeat(20000), "utf8");
  const opened = await service.open("room.limit", filePath);
  const capped = await waitForTask(service, "room.limit", opened.token, "hit", { maxResults: 7 });
  assert.equal(capped.event.results.length, 7);
  assert.equal(capped.event.truncated, true);

  const cancellation = new Promise((resolve, reject) => {
    const task = service.startSearch("room.limit", opened.token, "missing", {}, (event) => {
      if (event.type === "cancelled") resolve(event);
      if (event.type === "error") reject(new Error(event.message));
    });
    assert.equal(service.cancelTask("room.limit", task.taskId), true);
  });
  assert.equal((await cancellation).type, "cancelled");

  await new Promise((resolve) => setTimeout(resolve, 20));
  await fsp.appendFile(filePath, "changed", "utf8");
  await assert.rejects(() => service.readNext("room.limit", opened.token), /发生变化/);
});
