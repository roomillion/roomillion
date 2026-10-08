"use strict";
(() => {
  if (window.top !== window || window.room || !window.RoomillionNative) return;
  // Android 12's bundled WebView predates Array.at, which public document modules use.
  if (!Array.prototype.at) Object.defineProperty(Array.prototype, "at", {
    configurable: true, writable: true,
    value(index) { const position = Math.trunc(Number(index) || 0); return this[position < 0 ? this.length + position : position]; }
  });
  if (globalThis.crypto?.getRandomValues && !crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value() {
      const data = crypto.getRandomValues(new Uint8Array(16));
      data[6] = (data[6] & 15) | 64;
      data[8] = (data[8] & 63) | 128;
      const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  });
  let nextId = 0;
  const pending = new Map();
  const modelListeners = new Set();
  window.addEventListener("roomillion:models-changed", () => {
    for (const listener of modelListeners) {
      try { listener(); } catch (error) { console.error(error); }
    }
  });
  window.RoomillionNative.onmessage = (event) => {
    let response;
    try { response = JSON.parse(event.data); } catch { return; }
    const request = pending.get(response.id);
    if (!request) return;
    if (response.event === "chunk") {
      if (typeof request.onChunk === "function") {
        request.queue = request.queue.then(() => request.onChunk(response.delta, response.fullText))
          .catch((error) => console.error(error));
      }
      return;
    }
    pending.delete(response.id);
    request.queue.then(() => {
      if (response.ok) request.resolve(response.result);
      else request.reject(new Error(response.error || "房间操作失败"));
    });
  };
  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = String(++nextId);
      pending.set(id, { resolve, reject, queue: Promise.resolve() });
      try { window.RoomillionNative.postMessage(JSON.stringify({ id, method, args })); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  function callGenerate(prompt, requestOptions, onChunk) {
    if (typeof onChunk !== "function") return call("ai.generate", prompt, requestOptions);
    return new Promise((resolve, reject) => {
      const id = String(++nextId);
      pending.set(id, { resolve, reject, onChunk, queue: Promise.resolve() });
      try { window.RoomillionNative.postMessage(JSON.stringify({ id, method: "ai.generate", args: [prompt, { ...requestOptions, stream: true }] })); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  const MAX_AI_MEDIA_BYTES = 16 * 1024 * 1024;
  async function stageAiMedia(kind, item) {
    if (!item || typeof item !== "object" || item.directory || item.uploadToken) {
      throw new TypeError("安卓 AI 只接受直接数据或房间 Blob 引用");
    }
    if (typeof item.blobId === "string" && item.blobId && item.data === undefined) {
      return { blobId: item.blobId, ...(item.mimeType ? { mimeType: item.mimeType } : {}) };
    }
    const data = typeof item.data === "string" ? fromBase64(item.data) : exportChunkBytes(item.data);
    if (data.length < 1 || data.length > MAX_AI_MEDIA_BYTES) throw new RangeError("单个 AI 媒体文件必须在 1 字节至 16 MiB 之间");
    const handle = await call("ai.mediaBegin", kind);
    try {
      for (let offset = 0; offset < data.length; offset += 256 * 1024) {
        await call("ai.mediaWrite", handle.token, toBase64(data.subarray(offset, offset + 256 * 1024)));
      }
      return { uploadToken: handle.token, ...(item.mimeType ? { mimeType: item.mimeType } : {}) };
    } catch (error) {
      await call("ai.mediaAbort", handle.token).catch(() => {});
      throw error;
    }
  }
  async function generate(prompt, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("AI 调用选项无效");
    const { onChunk, images, audio, ...requestOptions } = options;
    if (images !== undefined && !Array.isArray(images)) throw new TypeError("AI 图片输入必须是数组");
    if (audio !== undefined && !Array.isArray(audio)) throw new TypeError("AI 音频输入必须是数组");
    const media = [...(images || []), ...(audio || [])];
    if (media.length > 8) throw new RangeError("一次 AI 请求最多携带 8 个媒体文件");
    const tokens = [];
    try {
      const stagedImages = [];
      const stagedAudio = [];
      for (const item of images || []) {
        const staged = await stageAiMedia("image", item);
        if (staged.uploadToken) tokens.push(staged.uploadToken);
        stagedImages.push(staged);
      }
      for (const item of audio || []) {
        const staged = await stageAiMedia("audio", item);
        if (staged.uploadToken) tokens.push(staged.uploadToken);
        stagedAudio.push(staged);
      }
      return await callGenerate(prompt, { ...requestOptions,
        ...(images !== undefined ? { images: stagedImages } : {}),
        ...(audio !== undefined ? { audio: stagedAudio } : {}) }, onChunk);
    } finally {
      await Promise.all(tokens.map((token) => call("ai.mediaAbort", token).catch(() => {})));
    }
  }
  function fromBase64(base64) {
    const raw = atob(base64);
    const data = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) data[index] = raw.charCodeAt(index);
    return data;
  }
  async function readBinary(token, options = {}) {
    const result = await call("files.readBinary", token, options);
    return { data: fromBase64(result.base64), offset: result.offset, nextOffset: result.nextOffset, eof: result.eof };
  }
  async function pickBinary(options = {}) {
    const handle = await call("files.openBinary", options);
    if (!handle) return null;
    try {
      if (handle.size > 32 * 1024 * 1024) throw new Error("文件超过直接读取的 32 MiB 上限，请使用分块读取");
      const data = new Uint8Array(handle.size);
      let offset = 0;
      while (offset < handle.size) {
        const chunk = await readBinary(handle.token, { offset, length: handle.maxChunkBytes });
        if (chunk.nextOffset <= offset) throw new Error("读取文件时没有取得新数据");
        data.set(chunk.data, offset);
        offset = chunk.nextOffset;
      }
      return { name: handle.name, size: handle.size, type: handle.type, data };
    } finally { await call("files.closeBinary", handle.token); }
  }
  function toBase64(data) {
    let binary = "";
    for (let offset = 0; offset < data.length; offset += 8192) {
      binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }
  function exportChunkBytes(content) {
    if (typeof content === "string") return new TextEncoder().encode(content);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    throw new TypeError("导出分块必须是文本或二进制数据");
  }
  function beginExport(suggestedName = "export.bin") {
    return call("files.beginExport", suggestedName);
  }
  async function writeExport(token, content) {
    const bytes = exportChunkBytes(content);
    if (bytes.length < 1 || bytes.length > 256 * 1024) {
      throw new RangeError("导出分块必须在 1 字节至 256 KiB 之间");
    }
    return call("files.writeExport", token, toBase64(bytes));
  }
  function finishExport(token) {
    return call("files.finishExport", token);
  }
  function abortExport(token) {
    return call("files.abortExport", token);
  }
  const SQL_BLOB_KEY = "__roomillionSqlBlobBase64";
  const MAX_SQL_BLOB_BYTES = 512 * 1024;
  function sqlParams(params) {
    if (!Array.isArray(params)) throw new TypeError("SQL 参数必须是数组");
    return params.map((value) => {
      if (!(value instanceof Uint8Array)) return value;
      if (value.length > MAX_SQL_BLOB_BYTES) throw new RangeError("数据库二进制参数超过 512 KiB，请使用房间文件或附件接口");
      return { [SQL_BLOB_KEY]: toBase64(value) };
    });
  }
  function sqlRows(rows) {
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      value && typeof value === "object" && Object.keys(value).length === 1 && typeof value[SQL_BLOB_KEY] === "string"
        ? fromBase64(value[SQL_BLOB_KEY]) : value
    ])));
  }
  function blobBegin(options = {}) { return call("blobs.begin", options); }
  async function blobWrite(token, content) {
    const data = exportChunkBytes(content);
    let result = null;
    if (!data.length) return call("blobs.write", token, "");
    for (let offset = 0; offset < data.length; offset += 256 * 1024) {
      result = await call("blobs.write", token, toBase64(data.subarray(offset, offset + 256 * 1024)));
    }
    return result;
  }
  function blobFinish(token) { return call("blobs.finish", token); }
  function blobAbort(token) { return call("blobs.abort", token); }
  async function blobPut(options, content) {
    const opened = await blobBegin(options);
    try {
      await blobWrite(opened.token, content);
      return await blobFinish(opened.token);
    } finally { await blobAbort(opened.token).catch(() => {}); }
  }
  async function blobRead(id, options = {}) {
    const length = options?.length;
    if (length === undefined || length <= 256 * 1024) {
      const result = await call("blobs.read", id, options);
      const { base64, ...metadata } = result;
      return { ...metadata, data: fromBase64(base64) };
    }
    if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024) {
      throw new RangeError("安卓附件每次最多读取 8 MiB，请分块读取");
    }
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("附件读取位置无效");
    const data = new Uint8Array(length);
    let count = 0;
    let result;
    do {
      result = await call("blobs.read", id, { offset: offset + count, length: Math.min(256 * 1024, length - count) });
      const chunk = fromBase64(result.base64);
      if (!chunk.length && !result.eof) throw new Error("附件读取未继续前进");
      data.set(chunk, count);
      count += chunk.length;
    } while (count < length && !result.eof);
    const { base64, ...metadata } = result;
    return { ...metadata, offset, data: data.subarray(0, count) };
  }
  async function exportBinary(suggestedName, content) {
    const data = content instanceof Uint8Array ? content : new Uint8Array(content);
    if (!data.length) throw new Error("导出二进制内容不能为空");
    const handle = await beginExport(suggestedName);
    if (!handle) return null;
    try {
      for (let offset = 0; offset < data.length; offset += 256 * 1024) {
        await writeExport(handle.token, data.subarray(offset, offset + 256 * 1024));
      }
      const saved = await finishExport(handle.token);
      return saved?.path ?? null;
    } finally { await abortExport(handle.token); }
  }
  window.room = Object.freeze({
    multiplayer: Object.freeze({
      getStatus: () => call("multiplayer.getStatus"),
      create: (options = {}) => call("multiplayer.create", options),
      join: (options) => call("multiplayer.join", options),
      send: (data, options = {}) => call("multiplayer.send", data, options),
      read: (options = {}) => call("multiplayer.read", options),
      leave: () => call("multiplayer.leave")
    }),
    getInfo: () => call("getInfo"),
    db: Object.freeze({
      query: async (sql, params = []) => sqlRows(await call("db.query", sql, sqlParams(params))),
      run: async (sql, params = []) => call("db.run", sql, sqlParams(params))
    }),
    storage: Object.freeze({
      get: (key) => call("storage.get", key),
      set: (key, value) => call("storage.set", key, value)
    }),
    blobs: Object.freeze({
      list: (options = {}) => call("blobs.list", options),
      put: blobPut, begin: blobBegin, write: blobWrite, finish: blobFinish, abort: blobAbort,
      read: blobRead, remove: (id) => call("blobs.remove", id)
    }),
    artifacts: Object.freeze({
      list: () => call("blobs.list", { kind: "artifact" }),
      put: (name, content, options = {}) => blobPut({ ...options, name, kind: "artifact" }, content),
      begin: (name, options = {}) => blobBegin({ ...options, name, kind: "artifact" }),
      write: blobWrite, finish: blobFinish, abort: blobAbort, read: blobRead,
      remove: (id) => call("blobs.remove", id)
    }),
    documents: Object.freeze({
      markdownToPdf: (source, options = {}) => call("documents.markdownToPdf", source, options)
    }),
    files: Object.freeze({
      pickText: () => call("files.pickText"),
      exportText: (suggestedName, content) => call("files.exportText", suggestedName, content),
      openBinary: (options = {}) => call("files.openBinary", options),
      readBinary,
      closeBinary: (token) => call("files.closeBinary", token),
      pickBinary,
      exportBinary,
      beginExport,
      writeExport,
      finishExport,
      abortExport
    }),
    ai: Object.freeze({
      listModels: () => call("ai.listModels"),
      generate,
      onModelsChanged: (callback) => {
        if (typeof callback !== "function") throw new TypeError("模型目录监听器必须是函数");
        modelListeners.add(callback);
        return () => modelListeners.delete(callback);
      }
    })
  });
})();
