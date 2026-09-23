"use strict";

const dns = require("node:dns/promises");
const net = require("node:net");

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 20;

function decodeEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return String(value || "").replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      try { return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : match; } catch { return match; }
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isBlockedAddress(rawAddress) {
  const address = String(rawAddress || "").replace(/^\[|\]$/g, "").toLowerCase();
  const kind = net.isIP(address);
  if (kind === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 127 || parts[0] >= 224 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 192 && [0, 2].includes(parts[1])) ||
      (parts[0] === 198 && parts[1] === 51) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
  }
  if (kind === 6) {
    if (address.startsWith("::ffff:")) return isBlockedAddress(address.slice(7));
    return address === "::" || address === "::1" || /^fe[89ab]/.test(address) || address.startsWith("ff") || address.startsWith("2001:db8:");
  }
  return false;
}

function parseUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || "")); } catch { throw new Error("网页 URL 无效"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("网页研究只支持 HTTP 和 HTTPS");
  if (url.username || url.password) throw new Error("网页 URL 不能包含用户名或密码");
  if (!url.hostname || url.hostname.toLowerCase() === "localhost") throw new Error("网页研究不能访问工作台自身的本机地址");
  return url;
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`网页内容超过 ${maxBytes} 字节上限`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

class AgentWebService {
  constructor({ networkService, fetchImpl = globalThis.fetch, lookup = dns.lookup, pageRenderer = null } = {}) {
    this.networkService = networkService;
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.pageRenderer = pageRenderer;
  }

  assertEnabled() {
    if (this.networkService?.getPublicState?.().roomNetworkEnabled !== true) {
      throw new Error("工作台联网已关闭。请先在“设置 → 联网控制”中开启，AI 创建房间才能检索和读取网页");
    }
  }

  getStatus() {
    const enabled = this.networkService?.getPublicState?.().roomNetworkEnabled === true;
    return Object.freeze({ available: enabled, intranetAllowed: true, javascriptRendering: Boolean(this.pageRenderer) });
  }

  async assertAllowedUrl(rawUrl) {
    const url = parseUrl(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(hostname)) {
      if (isBlockedAddress(hostname)) throw new Error("网页研究不能访问回环、链路本地或保留地址");
      return url;
    }
    let records;
    try { records = await this.lookup(hostname, { all: true, verbatim: true }); }
    catch (error) { throw new Error(`无法解析网页地址：${String(error?.message || error).slice(0, 160)}`); }
    if (!records.length || records.some((record) => isBlockedAddress(record.address))) throw new Error("网页研究不能访问解析到回环、链路本地或保留地址的站点");
    return url;
  }

  async fetchText(rawUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.assertEnabled();
    if (typeof this.fetchImpl !== "function") throw new Error("当前运行环境没有可用的网页请求能力");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    let url = await this.assertAllowedUrl(rawUrl);
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        let response;
        try {
          response = await this.fetchImpl(url, {
            method: "GET",
            headers: { accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.2", "user-agent": "Roomillion-Agent-Web/1" },
            redirect: "manual",
            signal: controller.signal
          });
        } catch (error) {
          if (controller.signal.aborted) throw new Error("网页请求超时或已取消");
          throw new Error(`网页请求失败：${String(error?.message || error).slice(0, 300)}`);
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (!location) throw new Error("网页返回了没有目标地址的重定向");
          if (redirects === MAX_REDIRECTS) throw new Error("网页重定向次数过多");
          url = await this.assertAllowedUrl(new URL(location, url).toString());
          continue;
        }
        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (/^(image|audio|video)\//.test(contentType) || contentType.includes("application/octet-stream")) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`网页研究暂不读取二进制内容（${contentType || "未知类型"}）`);
        }
        const body = await readBoundedBody(response, maxBytes);
        if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}：${htmlToText(body).slice(0, 300)}`);
        return { url: url.toString(), status: response.status, contentType, body };
      }
      throw new Error("网页重定向次数过多");
    } finally {
      clearTimeout(timeout);
    }
  }

  async search(query, { limit = 5 } = {}) {
    const normalized = String(query || "").trim();
    if (!normalized) throw new Error("网页检索词不能为空");
    const safeLimit = Math.min(20, Math.max(1, Number(limit) || 5));
    const result = await this.fetchText(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(normalized)}&count=${safeLimit}`, { maxBytes: 768 * 1024 });
    const items = [];
    for (const match of result.body.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const field = (name) => {
        const found = match[1].match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, "i"));
        return decodeEntities(found?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      };
      const url = field("link");
      if (url) items.push({ title: field("title"), url, snippet: field("description") });
      if (items.length >= safeLimit) break;
    }
    if (!items.length) throw new Error("搜索服务没有返回可解析的结果；可以稍后重试或直接读取已知网址");
    return { query: normalized, results: items };
  }

  async read(rawUrl, { maxChars = 30_000, renderJavaScript = false } = {}) {
    const safeMaxChars = Math.min(100_000, Math.max(2000, Number(maxChars) || 30_000));
    if (renderJavaScript === true) {
      this.assertEnabled();
      if (!this.pageRenderer) throw new Error("当前工作台无法渲染 JavaScript 网页；可先关闭 renderJavaScript 读取原始页面");
      const url = await this.assertAllowedUrl(rawUrl);
      return this.pageRenderer(url.toString(), {
        maxChars: safeMaxChars,
        validateUrl: (candidate) => this.assertAllowedUrl(candidate)
      });
    }
    const result = await this.fetchText(rawUrl);
    const text = result.contentType.includes("html") || /<html\b|<body\b/i.test(result.body)
      ? htmlToText(result.body)
      : result.body.trim();
    return {
      url: result.url,
      contentType: result.contentType,
      text: text.slice(0, safeMaxChars),
      truncated: text.length > safeMaxChars,
      totalCharacters: text.length
    };
  }
}

module.exports = { AgentWebService, htmlToText, isBlockedAddress, parseUrl };
