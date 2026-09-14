"use strict";

const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const iconv = require("iconv-lite");

const MAX_LARGE_TEXT_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_CHUNK_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_RESULTS = Number.MAX_SAFE_INTEGER;
const MAX_OPEN_FILES_PER_ROOM = Number.MAX_SAFE_INTEGER;
const SAMPLE_BYTES = 64 * 1024;
const SEARCH_STREAM_BYTES = 256 * 1024;
const SEARCH_CONTEXT_CHARS = 120;

const ENCODINGS = Object.freeze({
  utf8: Object.freeze({ id: "utf8", label: "UTF-8", iconv: "utf8" }),
  gb18030: Object.freeze({ id: "gb18030", label: "GB18030 / GBK", iconv: "gb18030" }),
  utf16le: Object.freeze({ id: "utf16le", label: "UTF-16 LE", iconv: "utf16-le" }),
  utf16be: Object.freeze({ id: "utf16be", label: "UTF-16 BE", iconv: "utf16-be" }),
  big5: Object.freeze({ id: "big5", label: "Big5", iconv: "big5" })
});

const ENCODING_ALIASES = Object.freeze({
  "utf-8": "utf8",
  utf8: "utf8",
  gb18030: "gb18030",
  gbk: "gb18030",
  gb2312: "gb18030",
  "utf-16le": "utf16le",
  utf16le: "utf16le",
  "utf-16be": "utf16be",
  utf16be: "utf16be",
  big5: "big5"
});

function normalizeEncoding(value, { allowAuto = false } = {}) {
  const normalized = String(value ?? (allowAuto ? "auto" : "utf8")).trim().toLowerCase();
  if (allowAuto && normalized === "auto") return "auto";
  const encoding = ENCODING_ALIASES[normalized];
  if (!encoding) throw new Error("不支持的文本编码；可选 UTF-8、GB18030、UTF-16 LE/BE 或 Big5");
  return encoding;
}

function likelyUtf16(sample) {
  if (sample.length < 4) return null;
  const length = Math.min(sample.length, 4096);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const pairs = Math.floor(length / 2);
  if (oddZeros > pairs * 0.3 && evenZeros < pairs * 0.05) return "utf16le";
  if (evenZeros > pairs * 0.3 && oddZeros < pairs * 0.05) return "utf16be";
  return null;
}

function detectEncoding(sample) {
  if (!Buffer.isBuffer(sample)) sample = Buffer.from(sample ?? []);
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return { encoding: "utf8", confidence: "bom", label: ENCODINGS.utf8.label };
  }
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return { encoding: "utf16le", confidence: "bom", label: ENCODINGS.utf16le.label };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return { encoding: "utf16be", confidence: "bom", label: ENCODINGS.utf16be.label };
  }
  const utf16 = likelyUtf16(sample);
  if (utf16) return { encoding: utf16, confidence: "heuristic", label: ENCODINGS[utf16].label };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return { encoding: "utf8", confidence: "validated", label: ENCODINGS.utf8.label };
  } catch {
    return { encoding: "gb18030", confidence: "fallback", label: ENCODINGS.gb18030.label };
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function validateOptions(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("超长文本选项必须是对象");
  return value;
}

function progress(position, size) {
  if (size === 0) return 1;
  return Math.min(1, Math.max(0, position / size));
}

function publicSession(session) {
  return {
    token: session.token,
    name: session.name,
    size: session.size,
    modifiedAt: new Date(session.mtimeMs).toISOString(),
    encoding: session.encoding,
    encodingLabel: ENCODINGS[session.encoding].label,
    encodingDetection: session.encodingDetection,
    supportedEncodings: Object.values(ENCODINGS).map(({ id, label }) => ({ id, label }))
  };
}

function advanceTextPosition(text, state) {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    state.column += text.length;
    return;
  }
  let lineBreaks = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lineBreaks += 1;
  }
  state.line += lineBreaks;
  state.column = text.length - lastNewline;
}

function compactSnippet(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, " ↵ ").replace(/\s+/g, " ").trim();
}

class LargeTextService {
  constructor({
    maxFileBytes = MAX_LARGE_TEXT_BYTES,
    defaultChunkBytes = DEFAULT_CHUNK_BYTES,
    maxChunkBytes = MAX_CHUNK_BYTES,
    maxSearchResults = MAX_SEARCH_RESULTS,
    maxOpenFilesPerRoom = MAX_OPEN_FILES_PER_ROOM
  } = {}) {
    this.maxFileBytes = maxFileBytes;
    this.defaultChunkBytes = defaultChunkBytes;
    this.maxChunkBytes = maxChunkBytes;
    this.maxSearchResults = maxSearchResults;
    this.maxOpenFilesPerRoom = maxOpenFilesPerRoom;
    this.sessions = new Map();
    this.tasks = new Map();
  }

  async open(roomId, filePath, options = {}) {
    options = validateOptions(options);
    if (typeof roomId !== "string" || !roomId) throw new Error("房间 ID 无效");
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("必须选择本地文本文件");
    const handle = await fsp.open(filePath, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error("所选项目不是普通文件");
      if (stats.size > this.maxFileBytes) throw new Error("文件超过当前文件系统可寻址范围");
      const sample = Buffer.alloc(Math.min(stats.size, SAMPLE_BYTES));
      if (sample.length) await handle.read(sample, 0, sample.length, 0);
      const detected = detectEncoding(sample);
      const requested = normalizeEncoding(options.encoding, { allowAuto: true });
      const encoding = requested === "auto" ? detected.encoding : requested;
      await this.#makeRoomCapacity(roomId);
      const token = crypto.randomUUID();
      const session = {
        token,
        roomId,
        filePath,
        name: path.basename(filePath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino,
        handle,
        encoding,
        encodingDetection: requested === "auto" ? detected.confidence : "selected",
        decoder: iconv.getDecoder(ENCODINGS[encoding].iconv),
        position: 0,
        decoderEnded: false,
        busy: false,
        openedAt: Date.now()
      };
      this.sessions.set(token, session);
      return publicSession(session);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async readNext(roomId, token, options = {}) {
    options = validateOptions(options);
    const session = this.#getSession(roomId, token);
    return this.#withSession(session, async () => {
      await this.#assertUnchanged(session);
      if (session.decoderEnded) {
        return {
          text: "",
          bytesRead: 0,
          position: session.position,
          size: session.size,
          progress: progress(session.position, session.size),
          eof: true,
          encoding: session.encoding
        };
      }
      const maxBytes = boundedInteger(options.maxBytes, this.defaultChunkBytes, 4096, this.maxChunkBytes);
      const remaining = Math.max(0, session.size - session.position);
      const buffer = Buffer.alloc(Math.min(maxBytes, remaining));
      let bytesRead = 0;
      if (buffer.length) {
        ({ bytesRead } = await session.handle.read(buffer, 0, buffer.length, session.position));
        session.position += bytesRead;
      }
      let text = bytesRead ? session.decoder.write(buffer.subarray(0, bytesRead)) : "";
      const eof = session.position >= session.size || bytesRead === 0;
      if (eof) {
        text += session.decoder.end();
        session.decoderEnded = true;
      }
      return {
        text,
        bytesRead,
        position: session.position,
        size: session.size,
        progress: progress(session.position, session.size),
        eof,
        encoding: session.encoding
      };
    });
  }

  async reset(roomId, token) {
    const session = this.#getSession(roomId, token);
    return this.#withSession(session, async () => {
      await this.#assertUnchanged(session);
      await session.handle.close();
      session.handle = await fsp.open(session.filePath, "r");
      session.decoder = iconv.getDecoder(ENCODINGS[session.encoding].iconv);
      session.position = 0;
      session.decoderEnded = false;
      return { position: 0, size: session.size, progress: progress(0, session.size), encoding: session.encoding };
    });
  }

  async setEncoding(roomId, token, encoding) {
    const session = this.#getSession(roomId, token);
    const normalized = normalizeEncoding(encoding);
    return this.#withSession(session, async () => {
      await this.#assertUnchanged(session);
      await session.handle.close();
      session.handle = await fsp.open(session.filePath, "r");
      session.encoding = normalized;
      session.encodingDetection = "selected";
      session.decoder = iconv.getDecoder(ENCODINGS[normalized].iconv);
      session.position = 0;
      session.decoderEnded = false;
      return { ...publicSession(session), position: 0, progress: progress(0, session.size) };
    });
  }

  startSearch(roomId, token, query, options = {}, emit = () => {}) {
    options = validateOptions(options);
    const session = this.#getSession(roomId, token);
    if (typeof query !== "string" || query.length === 0) {
      throw new Error("搜索内容必须是 1-200 个字符");
    }
    const taskId = crypto.randomUUID();
    const task = {
      id: taskId,
      roomId,
      token,
      cancelled: false,
      stream: null,
      emit: (event) => {
        try {
          emit({ taskId, ...event });
        } catch {
          // 房间可能已关闭；任务仍会在宿主侧安全清理。
        }
      }
    };
    this.tasks.set(taskId, task);
    setImmediate(() => {
      this.#runSearch(task, session, query, options)
        .catch((error) => {
          if (task.cancelled) task.emit({ type: "cancelled" });
          else task.emit({ type: "error", message: error.message });
        })
        .finally(() => this.tasks.delete(taskId));
    });
    return { taskId };
  }

  cancelTask(roomId, taskId) {
    const task = this.tasks.get(String(taskId));
    if (!task || task.roomId !== roomId) return false;
    task.cancelled = true;
    task.stream?.destroy();
    return true;
  }

  async close(roomId, token) {
    const session = this.sessions.get(String(token));
    if (!session || session.roomId !== roomId) return false;
    for (const task of this.tasks.values()) {
      if (task.token === token && task.roomId === roomId) this.cancelTask(roomId, task.id);
    }
    this.sessions.delete(token);
    await session.handle.close().catch(() => {});
    return true;
  }

  async closeRoom(roomId) {
    const closings = [];
    for (const [token, session] of this.sessions) {
      if (session.roomId === roomId) closings.push(this.close(roomId, token));
    }
    await Promise.allSettled(closings);
  }

  async dispose() {
    for (const task of this.tasks.values()) {
      task.cancelled = true;
      task.stream?.destroy();
    }
    const closings = [...this.sessions.values()].map((session) => session.handle.close().catch(() => {}));
    this.sessions.clear();
    await Promise.allSettled(closings);
  }

  async #runSearch(task, session, query, options) {
    await this.#assertUnchanged(session);
    const searchHandle = await fsp.open(session.filePath, "r");
    const searchStats = await searchHandle.stat();
    if (!this.#matchesSession(session, searchStats)) {
      await searchHandle.close();
      throw new Error("源文件在读取期间发生变化，请重新选择");
    }
    const caseSensitive = Boolean(options.caseSensitive);
    const maxResults = boundedInteger(options.maxResults, 200, 1, this.maxSearchResults);
    const needle = caseSensitive ? query : query.toLowerCase();
    const decoder = iconv.getDecoder(ENCODINGS[session.encoding].iconv);
    const stream = searchHandle.createReadStream({ highWaterMark: SEARCH_STREAM_BYTES, autoClose: false });
    task.stream = stream;
    const results = [];
    let bytesRead = 0;
    let buffer = "";
    let bufferStartOffset = 0;
    const basePosition = { line: 1, column: 1 };
    let lastProgressAt = 0;
    const retainedCharacters = Math.max(query.length - 1, SEARCH_CONTEXT_CHARS);

    const processBuffer = (final = false) => {
      const safeLength = final ? buffer.length : Math.max(0, buffer.length - retainedCharacters);
      if (safeLength === 0) return false;
      const haystack = caseSensitive ? buffer : buffer.toLowerCase();
      const matchPosition = { ...basePosition };
      let matchCursor = 0;
      let searchFrom = 0;
      while (searchFrom <= safeLength - query.length) {
        const index = haystack.indexOf(needle, searchFrom);
        if (index === -1 || index >= safeLength) break;
        advanceTextPosition(buffer.slice(matchCursor, index), matchPosition);
        matchCursor = index;
        const snippetStart = Math.max(0, index - SEARCH_CONTEXT_CHARS);
        const snippetEnd = Math.min(buffer.length, index + query.length + SEARCH_CONTEXT_CHARS);
        results.push({
          line: matchPosition.line,
          column: matchPosition.column,
          characterOffset: bufferStartOffset + index,
          snippet: compactSnippet(buffer.slice(snippetStart, snippetEnd))
        });
        if (results.length >= maxResults) return true;
        searchFrom = index + Math.max(1, query.length);
      }
      const committed = buffer.slice(0, safeLength);
      advanceTextPosition(committed, basePosition);
      bufferStartOffset += safeLength;
      buffer = buffer.slice(safeLength);
      return false;
    };

    try {
      for await (const chunk of stream) {
        if (task.cancelled) break;
        bytesRead += chunk.length;
        buffer += decoder.write(chunk);
        const truncated = processBuffer(false);
        const now = Date.now();
        if (now - lastProgressAt >= 150 || truncated) {
          task.emit({
            type: "progress",
            bytesRead,
            size: session.size,
            progress: progress(bytesRead, session.size),
            matches: results.length
          });
          lastProgressAt = now;
        }
        if (truncated) {
          stream.destroy();
          task.emit({
            type: "complete",
            bytesRead,
            size: session.size,
            progress: progress(bytesRead, session.size),
            results,
            truncated: true
          });
          return;
        }
      }
      if (task.cancelled) {
        task.emit({ type: "cancelled" });
        return;
      }
      buffer += decoder.end();
      const truncated = processBuffer(true);
      await this.#assertUnchanged(session);
      task.emit({
        type: "complete",
        bytesRead,
        size: session.size,
        progress: 1,
        results,
        truncated
      });
    } finally {
      task.stream = null;
      if (!stream.destroyed) stream.destroy();
      await searchHandle.close().catch(() => {});
    }
  }

  #getSession(roomId, token) {
    const session = this.sessions.get(String(token));
    if (!session || session.roomId !== roomId) throw new Error("超长文本令牌无效或已关闭");
    return session;
  }

  async #assertUnchanged(session) {
    let stats;
    try {
      stats = await session.handle.stat();
    } catch {
      throw new Error("源文件已不可用，请重新选择");
    }
    if (!this.#matchesSession(session, stats)) {
      throw new Error("源文件在读取期间发生变化，请重新选择");
    }
  }

  #matchesSession(session, stats) {
    return Boolean(
      stats.isFile() &&
      stats.size === session.size &&
      stats.mtimeMs === session.mtimeMs &&
      (!session.ino || !stats.ino || stats.ino === session.ino) &&
      (!session.dev || !stats.dev || stats.dev === session.dev)
    );
  }

  async #withSession(session, action) {
    if (session.busy) throw new Error("该文本正在执行另一项分块操作，请稍后重试");
    session.busy = true;
    try {
      return await action();
    } finally {
      session.busy = false;
    }
  }

  async #makeRoomCapacity(roomId) {
    const roomSessions = [...this.sessions.values()]
      .filter((session) => session.roomId === roomId)
      .sort((left, right) => left.openedAt - right.openedAt);
    while (roomSessions.length >= this.maxOpenFilesPerRoom) {
      const oldest = roomSessions.shift();
      await this.close(roomId, oldest.token);
    }
  }
}

module.exports = {
  DEFAULT_CHUNK_BYTES,
  ENCODINGS,
  LargeTextService,
  MAX_CHUNK_BYTES,
  MAX_LARGE_TEXT_BYTES,
  MAX_SEARCH_RESULTS,
  detectEncoding,
  normalizeEncoding,
  validateOptions
};
