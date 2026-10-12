"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Android action bridge rolls back invalid registrations and preserves task cancellation and result signatures", async () => {
  const calls = [], page = { addEventListener() {} }; page.top = page;
  page.RoomillionNative = { postMessage(serialized) {
    const { id, method, args } = JSON.parse(serialized); calls.push({ method, args });
    const invalid = method === "actions.register" && args[0].includes("undeclared");
    page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: !invalid, result: true, error: "只能注册声明的操作" }) });
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8"), { window: page, AbortController });
  await page.room.actions.register("sum", async ({ quantity }, context) => { await context.report("正在执行"); context.throwIfCancelled(); return { quantity }; });
  await assert.rejects(page.room.actions.register("undeclared", () => null), /声明/);
  await page.room.actions.register("stop", async (_input, context) => { page.__roomillionActionCancel(context.taskId); context.throwIfCancelled(); });
  assert.deepEqual(calls.filter(call => call.method === "actions.register").at(-1).args[0], ["sum", "stop"]);
  await page.__roomillionActionInvoke({ taskId: "one", actionId: "sum", input: { quantity: 7 } });
  assert.deepEqual(calls.filter(call => call.method === "actions.reply").at(-1).args[0], { taskId: "one", ok: true, result: { quantity: 7 } });
  await page.__roomillionActionInvoke({ taskId: "two", actionId: "stop", input: {} });
  assert.equal(calls.filter(call => call.method === "actions.reply").at(-1).args[0].ok, false);
});

test("Android multiplayer bridge uses the same room-scoped method signatures as desktop", async () => {
  const calls = [], page = { addEventListener() {} }; page.top = page;
  page.RoomillionNative = { postMessage(serialized) {
    const { id, method, args } = JSON.parse(serialized); calls.push([method, args]);
    page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result: { connected: true } }) });
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8"), { window: page });
  await page.room.multiplayer.getStatus(); await page.room.multiplayer.create({ name: "游戏" });
  await page.room.multiplayer.join({ invitation: "test" }); await page.room.multiplayer.send({ vote: 1 }, { to: "host" });
  await page.room.multiplayer.read({ timeoutMs: 500 }); await page.room.multiplayer.leave();
  assert.deepEqual(calls, [["multiplayer.getStatus", []], ["multiplayer.create", [{ name: "游戏" }]],
    ["multiplayer.join", [{ invitation: "test" }]], ["multiplayer.send", [{ vote: 1 }, { to: "host" }]],
    ["multiplayer.read", [{ timeoutMs: 500 }]], ["multiplayer.leave", []]]);
});

test("Android Room bridge assembles binary chunks and closes its opaque handle", async () => {
  const calls = [];
  const page = { addEventListener() {} };
  page.top = page;
  page.RoomillionNative = {
    postMessage(serialized) {
      const { id, method, args } = JSON.parse(serialized);
      calls.push(method);
      let result;
      if (method === "files.openBinary") result = { token: "opaque", name: "scan.png", size: 4, type: "image/png", maxChunkBytes: 2 };
      else if (method === "files.readBinary") {
        const offset = args[1].offset;
        result = { base64: Buffer.from(offset === 0 ? [0, 255] : [10, 128]).toString("base64"), offset, nextOffset: offset + 2, eof: offset > 0 };
      } else if (method === "files.closeBinary") result = true;
      else throw new Error(`Unexpected method: ${method}`);
      page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result }) });
    }
  };
  const bridge = fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8");
  vm.runInNewContext(bridge, { window: page, atob, btoa });
  const selected = await page.room.files.pickBinary({ extensions: ["png"] });
  assert.equal(selected.name, "scan.png");
  assert.equal(selected.type, "image/png");
  assert.deepEqual(Array.from(selected.data), [0, 255, 10, 128]);
  assert.deepEqual(calls, ["files.openBinary", "files.readBinary", "files.readBinary", "files.closeBinary"]);
});

test("Android Room bridge sends binary export in bounded chunks and clears its token", async () => {
  const methods = [];
  const chunks = [];
  const page = { addEventListener() {} };
  page.top = page;
  page.RoomillionNative = {
    postMessage(serialized) {
      const { id, method, args } = JSON.parse(serialized);
      methods.push(method);
      if (method === "files.writeExport") chunks.push(Buffer.from(args[1], "base64"));
      const result = method === "files.beginExport" ? { token: "opaque-export", path: "结果.bin", bytes: 0 }
        : method === "files.finishExport" ? { path: "结果.bin", bytes: 300000 } : true;
      page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result }) });
    }
  };
  const bridge = fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8");
  vm.runInNewContext(bridge, { window: page, atob, btoa });
  const bytes = Uint8Array.from({ length: 300000 }, (_, index) => index % 251);
  assert.equal(await page.room.files.exportBinary("结果.bin", bytes.buffer), "结果.bin");
  assert.equal(chunks.length, 2);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  assert.deepEqual(methods, ["files.beginExport", "files.writeExport", "files.writeExport", "files.finishExport", "files.abortExport"]);
});

test("Android Room bridge exposes the desktop chunked export methods with bounded typed and text chunks", async () => {
  const chunks = [];
  const page = { addEventListener() {} };
  page.top = page;
  page.RoomillionNative = {
    postMessage(serialized) {
      const { id, method, args } = JSON.parse(serialized);
      let result;
      if (method === "files.beginExport") result = { token: "opaque-stream", path: "记录.txt", bytes: 0 };
      else if (method === "files.writeExport") {
        chunks.push(Buffer.from(args[1], "base64"));
        result = { bytes: chunks.reduce((total, chunk) => total + chunk.length, 0) };
      } else if (method === "files.finishExport") result = { path: "记录.txt", bytes: 8 };
      else if (method === "files.abortExport") result = true;
      else throw new Error(`Unexpected method: ${method}`);
      page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result }) });
    }
  };
  const bridge = fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8");
  vm.runInNewContext(bridge, { window: page, atob, btoa, TextEncoder, Uint8Array });
  const handle = await page.room.files.beginExport("记录.txt");
  assert.equal(handle.path, "记录.txt");
  assert.equal((await page.room.files.writeExport(handle.token, "你好")).bytes, 6);
  assert.equal((await page.room.files.writeExport(handle.token, Uint8Array.from([0, 255]))).bytes, 8);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from("你好"), Buffer.from([0, 255])]));
  const finished = await page.room.files.finishExport(handle.token);
  assert.equal(finished.path, "记录.txt");
  assert.equal(finished.bytes, 8);
  assert.equal(await page.room.files.abortExport(handle.token), true);
  await assert.rejects(page.room.files.writeExport(handle.token, new Uint8Array(256 * 1024 + 1)), /256 KiB/);
});

test("Android Room bridge waits for async AI text chunks before returning the final result", async () => {
  const seen = [];
  const page = { addEventListener() {} };
  page.top = page;
  page.RoomillionNative = {
    postMessage(serialized) {
      const { id, method, args } = JSON.parse(serialized);
      assert.equal(method, "ai.generate");
      assert.equal(args[1].stream, true);
      assert.equal(Object.hasOwn(args[1], "onChunk"), false);
      for (const [delta, fullText] of [["你", "你"], ["好", "你好"]]) {
        page.RoomillionNative.onmessage({ data: JSON.stringify({ id, event: "chunk", delta, fullText }) });
      }
      page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result: { text: "你好" } }) });
    }
  };
  const bridge = fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8");
  vm.runInNewContext(bridge, { window: page, console });
  const result = await page.room.ai.generate("问候", { onChunk: async (delta, fullText) => {
    await Promise.resolve();
    seen.push([delta, fullText]);
  } });
  seen.push(["final", result.text]);
  assert.deepEqual(seen, [["你", "你"], ["好", "你好"], ["final", "你好"]]);
});

test("Android Room bridge stages image and audio in bounded chunks, then cleans up tokens", async () => {
  const uploads = new Map();
  const calls = [];
  const page = { addEventListener() {} };
  page.top = page;
  page.RoomillionNative = {
    postMessage(serialized) {
      const { id, method, args } = JSON.parse(serialized);
      calls.push(method);
      let result = true;
      if (method === "ai.mediaBegin") {
        const token = `${args[0]}-${uploads.size}`;
        uploads.set(token, []);
        result = { token, maxChunkBytes: 256 * 1024 };
      } else if (method === "ai.mediaWrite") {
        const bytes = Buffer.from(args[1], "base64");
        assert.ok(bytes.length <= 256 * 1024);
        uploads.get(args[0]).push(bytes);
        result = { bytes: uploads.get(args[0]).reduce((sum, part) => sum + part.length, 0) };
      } else if (method === "ai.generate") {
        assert.equal(args[1].images[0].uploadToken, "image-0");
        assert.equal(args[1].audio[0].uploadToken, "audio-1");
        assert.equal(Object.hasOwn(args[1].images[0], "data"), false);
        assert.equal(Object.hasOwn(args[1].audio[0], "data"), false);
        result = { text: "识别完成" };
      } else if (method !== "ai.mediaAbort") throw new Error(`Unexpected method: ${method}`);
      page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result }) });
    }
  };
  const bridge = fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8");
  vm.runInNewContext(bridge, { window: page, atob, btoa, Uint8Array });
  const image = Uint8Array.from({ length: 300000 }, (_, index) => index % 251);
  const audio = Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
  assert.equal((await page.room.ai.generate("看和听", {
    images: [{ data: image, mimeType: "image/png" }], audio: [{ data: audio }]
  })).text, "识别完成");
  assert.deepEqual(Buffer.concat(uploads.get("image-0")), Buffer.from(image));
  assert.deepEqual(Buffer.concat(uploads.get("audio-1")), Buffer.from(audio));
  assert.deepEqual(calls, ["ai.mediaBegin", "ai.mediaWrite", "ai.mediaWrite", "ai.mediaBegin",
    "ai.mediaWrite", "ai.generate", "ai.mediaAbort", "ai.mediaAbort"]);
  await assert.rejects(page.room.ai.generate("看图", { images: [{ directory: { grantId: "unsupported" } }] }), /直接数据或房间 Blob/);
  await assert.rejects(page.room.ai.generate("看图", { images: [{ data: new Uint8Array(16 * 1024 * 1024 + 1) }] }), /16 MiB/);
});

test("Android Room bridge preserves SQLite binary parameters and BLOB result types", async () => {
  const bytes = Uint8Array.from([0, 128, 255]);
  const encoded = Buffer.from(bytes).toString("base64");
  const page = { addEventListener() {} };
  page.top = page;
  page.RoomillionNative = {
    postMessage(serialized) {
      const { id, method, args } = JSON.parse(serialized);
      if (method === "db.run") assert.deepEqual(args[1], [{ __roomillionSqlBlobBase64: encoded }]);
      const result = method === "db.query" ? [{ payload: { __roomillionSqlBlobBase64: encoded }, label: "文本" }] : { changes: 1 };
      page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result }) });
    }
  };
  const bridge = fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8");
  vm.runInNewContext(bridge, { window: page, atob, btoa, Uint8Array });
  assert.equal((await page.room.db.run("INSERT INTO probe VALUES (?)", [bytes])).changes, 1);
  const rows = await page.room.db.query("SELECT payload, label FROM probe");
  assert.ok(rows[0].payload instanceof Uint8Array);
  assert.deepEqual(Array.from(rows[0].payload), [0, 128, 255]);
  assert.equal(rows[0].label, "文本");
  await assert.rejects(page.room.db.run("SELECT ?", [new Uint8Array(512 * 1024 + 1)]), /512 KiB/);
});

test("Android Room bridge persists blobs and artifacts in chunks and passes an opaque image reference to AI", async () => {
  const chunks = [];
  const calls = [];
  const page = { addEventListener() {} };
  page.top = page;
  page.RoomillionNative = {
    postMessage(serialized) {
      const { id, method, args } = JSON.parse(serialized);
      calls.push(method);
      let result = true;
      if (method === "blobs.begin") {
        assert.equal(args[0].kind, "artifact");
        result = { token: "write-opaque", id: "a".repeat(32) };
      } else if (method === "blobs.write") {
        chunks.push(Buffer.from(args[1], "base64"));
        assert.ok(chunks.at(-1).length <= 256 * 1024);
        result = { id: "a".repeat(32), bytes: chunks.reduce((sum, part) => sum + part.length, 0) };
      } else if (method === "blobs.finish") result = { id: "a".repeat(32), name: "page.png", kind: "artifact", size: 300000 };
      else if (method === "blobs.list") result = [{ id: "a".repeat(32), kind: "artifact" }];
      else if (method === "blobs.read") result = { item: { id: "a".repeat(32) }, base64: Buffer.from([0, 128, 255]).toString("base64"), offset: 0, nextOffset: 3, eof: true };
      else if (method === "ai.generate") {
        assert.equal(args[1].images[0].blobId, "a".repeat(32));
        assert.equal(Object.hasOwn(args[1].images[0], "data"), false);
        result = { text: "一页" };
      } else if (method !== "blobs.abort" && method !== "blobs.remove") throw new Error(method);
      page.RoomillionNative.onmessage({ data: JSON.stringify({ id, ok: true, result }) });
    }
  };
  const bridge = fs.readFileSync(path.join(__dirname, "../android/app/src/main/assets/room-bridge.js"), "utf8");
  vm.runInNewContext(bridge, { window: page, atob, btoa, Uint8Array, TextEncoder });
  const bytes = Uint8Array.from({ length: 300000 }, (_, index) => index % 251);
  const saved = await page.room.artifacts.put("page.png", bytes, { mimeType: "image/png" });
  assert.equal(saved.id, "a".repeat(32));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  assert.equal((await page.room.artifacts.list()).length, 1);
  assert.deepEqual(Array.from((await page.room.blobs.read(saved.id)).data), [0, 128, 255]);
  assert.equal((await page.room.ai.generate("识别", { images: [{ blobId: saved.id }] })).text, "一页");
  assert.deepEqual(calls, ["blobs.begin", "blobs.write", "blobs.write", "blobs.finish", "blobs.abort",
    "blobs.list", "blobs.read", "ai.generate"]);
});
