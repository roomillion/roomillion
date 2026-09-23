"use strict";

const crypto = require("node:crypto");
const { BrowserWindow, session } = require("electron");

const PAGE_LOAD_TIMEOUT_MS = 120_000;
const PAGE_SETTLE_MS = 1800;

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

function createAgentPageRenderer({ BrowserWindowClass = BrowserWindow, sessionApi = session } = {}) {
  return async function renderAgentPage(rawUrl, { maxChars = 30_000, validateUrl } = {}) {
    if (typeof validateUrl !== "function") throw new Error("网页渲染缺少地址校验器");
    const partition = `roomillion-agent-web-${crypto.randomUUID()}`;
    const browserSession = sessionApi.fromPartition(partition, { cache: true });
    const filter = { urls: ["http://*/*", "https://*/*"] };
    browserSession.setPermissionCheckHandler?.(() => false);
    browserSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    browserSession.webRequest.onBeforeRequest(filter, (details, callback) => {
      Promise.resolve(validateUrl(details.url)).then(
        () => callback({ cancel: false }),
        () => callback({ cancel: true })
      );
    });
    const window = new BrowserWindowClass({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    });
    window.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    try {
      await withTimeout(window.loadURL(rawUrl), PAGE_LOAD_TIMEOUT_MS, "JavaScript 网页加载超时");
      await wait(PAGE_SETTLE_MS);
      const page = await window.webContents.executeJavaScript(`(() => {
        const body = document.body?.innerText || document.documentElement?.innerText || "";
        const links = Array.from(document.querySelectorAll("a[href]"), (item) => ({
          text: String(item.innerText || item.textContent || "").trim().slice(0, 300),
          url: item.href
        })).filter((item) => item.text || item.url).slice(0, 300);
        return { title: document.title || "", url: location.href, text: body, links };
      })()`);
      const text = String(page?.text || "").trim();
      return {
        url: String(page?.url || rawUrl),
        title: String(page?.title || "").slice(0, 500),
        contentType: "text/html; rendered=javascript",
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        totalCharacters: text.length,
        links: Array.isArray(page?.links) ? page.links : [],
        renderedJavaScript: true
      };
    } finally {
      if (!window.isDestroyed?.()) window.destroy();
      browserSession.webRequest.onBeforeRequest(filter, null);
      await browserSession.clearStorageData?.().catch(() => {});
      await browserSession.clearCache?.().catch(() => {});
    }
  };
}

module.exports = { PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_MS, createAgentPageRenderer };
