"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

test("room AI IPC validates permission and ownership and cancellation wins during setup", async () => {
  const handlers = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const sender = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: () => {} });
  const a = { sender: sender(1) }, b = { sender: sender(2) }, unknown = { sender: sender(99) };
  let allowed = true;
  let signalSeen;
  module.exports.registerIpcHandlers({
    roomViews: { getRoomIdForSender: id => ({ 1: "a", 2: "b" })[id] },
    roomStore: { getRoom: id => ({ id, name: id }), hasPermission: () => allowed },
    aiService: { resolveRoomModelProfile: () => "test", complete: async ({ signal }) => {
      signalSeen = signal;
      signal.throwIfAborted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } }
  });
  const generate = handlers.get("room:aiGenerate"), cancel = handlers.get("room:aiCancel");
  await assert.rejects(cancel(unknown, "test"), /无法识别/);
  allowed = false;
  await assert.rejects(cancel(a, "test"), /权限/);
  await assert.rejects(generate(a, "test", {}), /权限/);
  allowed = true;
  await assert.rejects(generate(a, "OCR", { input: [{ type: "image" }] }), /images.*不是 input/);
  await assert.rejects(generate(a, "OCR", { model: "fake" }), /profileId/);
  await assert.rejects(generate(a, "OCR", { signal: {} }), /requestId.*room.ai.cancel/);
  await assert.rejects(generate(a, "test", { requestId: "bad id" }), /标识无效/);
  await assert.rejects(generate(a, "test", { requestId: null }), /标识无效/);
  const pending = generate(a, "test", { requestId: "test" });
  const rejected = assert.rejects(pending, /已取消/);
  assert.deepEqual(await cancel(b, "test"), { cancelled: false });
  assert.deepEqual(await cancel(a, "test"), { cancelled: true });
  await rejected;
  assert.equal(signalSeen.aborted, true);
  assert.deepEqual(await cancel(a, "test"), { cancelled: false });
  assert.equal(a.sender.listenerCount("destroyed"), 0);
  await assert.rejects(generate(a, "test", { requestId: "invalid-options", maxTokens: -1 }), /正整数/);
  assert.equal(a.sender.listenerCount("destroyed"), 0);
});

test("room AI IPC gates audio input behind the ai.audio role and validates the audio array", async () => {
  const handlers = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const sender = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: () => {} });
  const a = { sender: sender(1) };
  let audioGranted = false;
  let audioSeen;
  module.exports.registerIpcHandlers({
    roomViews: { getRoomIdForSender: id => ({ 1: "a" })[id] },
    roomStore: {
      getRoom: id => ({ id, name: id }),
      hasPermission: (_roomId, domain, value) => domain === "ai" && (value === undefined || (value === "audio" ? audioGranted : false))
    },
    aiService: {
      resolveRoomModelProfile: () => "test",
      getModelCapabilities: async () => ({ supportsImages: false, supportsAudio: true, contextWindow: 128000 }),
      complete: async ({ audio }) => {
        audioSeen = audio;
        return { text: "ok", usage: {}, model: "m" };
      }
    }
  });
  const generate = handlers.get("room:aiGenerate");
  await assert.rejects(generate(a, "听写", { audio: "not-an-array" }), /AI 音频输入必须是数组/);
  const wav = new Uint8Array(Buffer.concat([
    Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)
  ]));
  await assert.rejects(
    generate(a, "听写", { audio: [{ mimeType: "audio/wav", data: wav }] }),
    /房间没有音频 AI 权限/
  );
  await assert.rejects(
    generate(a, "听写", { audio: [{ mimeType: "audio/wav", data: new Uint8Array(8) }] }),
    /AI 音频格式或内容无效/
  );
  audioGranted = true;
  const result = await generate(a, "听写", { audio: [{ mimeType: "audio/wav", data: wav }] });
  assert.equal(result.text, "ok");
  assert.equal(audioSeen.length, 1);
  assert.equal(audioSeen[0].mimeType, "audio/wav");
  assert.equal(Buffer.from(audioSeen[0].data, "base64").subarray(0, 4).toString("ascii"), "RIFF");
});

test("room AI IPC exposes configured embedding, rerank and intuition through the capability gateway", async () => {
  const handlers = new Map();
  const filename = path.resolve(__dirname, "../src/main/ipc.cjs");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) } } : localRequire(id), module, module.exports);
  const event = { sender: Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: () => {} }) };
  let allowed = true;
  const calls = [];
  module.exports.registerIpcHandlers({
    roomViews: { getRoomIdForSender: () => "room" },
    roomStore: { getRoom: () => ({ id: "room", name: "测试房间" }), hasPermission: () => allowed },
    aiService: { getRoomModelSelection: () => ({ profileId: "legacy" }) },
    aiCapabilityService: {
      getPublicProfile: kind => kind === "embedding" ? { kind } : null,
      getRoomCatalog: () => ({ embedding: { configured: true, ready: true }, rerank: { configured: true, ready: true }, intuition: { configured: true, ready: true } }),
      embed: async (texts, options) => { calls.push(["embed", texts, options]); return { embeddings: [[1, 0]], dimensions: 2 }; },
      rerank: async (query, documents, options) => { calls.push(["rerank", query, documents, options]); return { results: [{ index: 0, relevanceScore: 1 }] }; },
      intuition: async (state, questions, options) => { calls.push(["intuition", state, questions, options]); return { answers: { yes: { type: "noul", noul: 0.9 } } }; }
    }
  });
  assert.equal((await handlers.get("room:aiGetCapabilities")(event)).intuition.ready, true);
  assert.equal((await handlers.get("room:aiEmbed")(event, ["文本"], {})).dimensions, 2);
  assert.equal((await handlers.get("room:aiRerank")(event, "查找", ["文档"], {})).results[0].index, 0);
  assert.equal((await handlers.get("room:aiIntuition")(event, "状态", { yes: { type: "noul" } }, {})).answers.yes.noul, 0.9);
  assert.deepEqual(calls.map((entry) => entry[0]), ["embed", "rerank", "intuition"]);
  allowed = false;
  await assert.rejects(handlers.get("room:aiRerank")(event, "查找", ["文档"], {}), /权限/);
  await assert.rejects(handlers.get("room:aiIntuition")(event, "状态", { yes: { type: "noul" } }, {}), /权限/);
});
