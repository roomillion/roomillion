(() => {
  "use strict";

  const BOOKMARKS_KEY = "browser.bookmarks.v1";
  const HISTORY_KEY = "browser.history.v1";
  const MAX_HISTORY = 200;
  const state = { browser: null, bookmarks: [], history: [], permissionRequest: null, toastTimer: null };
  const elements = Object.fromEntries([
    "tabs", "newTabButton", "addressForm", "addressInput", "securityGlyph", "loadingSpinner",
    "backButton", "forwardButton", "reloadButton", "homeButton", "bookmarkButton", "libraryButton",
    "networkBadge", "permissionPrompt", "permissionTitle", "permissionOrigin", "denyPermissionButton",
    "allowPermissionButton", "libraryPanel", "bookmarksList", "historyList", "clearBookmarksButton",
    "clearHistoryButton", "clearBrowserDataButton", "browserSurface", "emptyState", "emptyTitle",
    "emptyDescription", "statusText", "tabCount", "toast"
  ].map((id) => [id, document.getElementById(id)]));

  function activeTab() {
    return state.browser?.tabs.find((tab) => tab.id === state.browser.activeTabId) || null;
  }

  function escapeLabel(value, fallback) {
    const text = String(value || "").trim();
    return text || fallback;
  }

  function showToast(message, error = false) {
    clearTimeout(state.toastTimer);
    elements.toast.textContent = String(message || "");
    elements.toast.classList.toggle("error", error);
    elements.toast.hidden = false;
    state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
  }

  async function run(operation) {
    try {
      const result = await operation();
      if (result?.tabs) updateBrowserState(result);
      return result;
    } catch (error) {
      showToast(error?.message || String(error), true);
      elements.statusText.textContent = error?.message || "操作失败";
      return null;
    }
  }

  function createTabElement(tab) {
    const button = document.createElement("div");
    button.setAttribute("role", "tab");
    button.tabIndex = 0;
    button.className = `tab${tab.id === state.browser.activeTabId ? " active" : ""}${tab.loading ? " loading" : ""}`;
    button.title = escapeLabel(tab.title, tab.url || "新标签页");
    const loading = document.createElement("span");
    loading.className = "tabLoading";
    loading.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "tabTitle";
    title.textContent = escapeLabel(tab.title, "新标签页");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tabClose";
    close.textContent = "×";
    close.title = "关闭标签";
    close.setAttribute("aria-label", `关闭 ${title.textContent}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      run(() => room.browser.closeTab(tab.id)).then(ensureTab);
    });
    button.append(loading, title, close);
    button.addEventListener("click", () => run(() => room.browser.activateTab(tab.id)));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        run(() => room.browser.activateTab(tab.id));
      }
    });
    button.addEventListener("auxclick", (event) => {
      if (event.button === 1) run(() => room.browser.closeTab(tab.id)).then(ensureTab);
    });
    return button;
  }

  function renderTabs() {
    elements.tabs.replaceChildren(...state.browser.tabs.map(createTabElement));
    elements.newTabButton.disabled = state.browser.tabs.length >= state.browser.maximumTabs || !state.browser.permissions.navigate;
    elements.tabCount.textContent = `${state.browser.tabs.length} / ${state.browser.maximumTabs} 个标签`;
  }

  function renderToolbar() {
    const tab = activeTab();
    elements.backButton.disabled = !tab?.canGoBack;
    elements.forwardButton.disabled = !tab?.canGoForward;
    elements.reloadButton.textContent = tab?.loading ? "×" : "↻";
    elements.reloadButton.title = tab?.loading ? "停止加载" : "刷新";
    elements.loadingSpinner.classList.toggle("active", Boolean(tab?.loading));
    if (document.activeElement !== elements.addressInput) elements.addressInput.value = tab?.url || "";
    elements.securityGlyph.textContent = tab?.url?.startsWith("https:") ? "锁" : tab?.url ? "网" : "搜";
    const bookmarked = Boolean(tab?.url && state.bookmarks.some((item) => item.url === tab.url));
    elements.bookmarkButton.textContent = bookmarked ? "★" : "☆";
    elements.bookmarkButton.disabled = !tab?.url;
    elements.networkBadge.classList.toggle("online", state.browser.networkAllowed);
    elements.networkBadge.textContent = state.browser.networkAllowed ? "联网开启" : "联网关闭";
    elements.statusText.textContent = tab?.error || (tab?.loading ? `正在加载 ${tab.url}` : tab?.url || "就绪");
  }

  function renderEmptyState() {
    const tab = activeTab();
    if (!state.browser.permissions.navigate) {
      elements.emptyTitle.textContent = "浏览网页权限尚未授权";
      elements.emptyDescription.textContent = "请在工作台的房间设置中允许“浏览任意网站”，然后重新打开这个房间。";
    } else if (!state.browser.networkAllowed) {
      elements.emptyTitle.textContent = "工作台联网目前已关闭";
      elements.emptyDescription.textContent = "请在主工作台的“联网控制”中允许房间联网。浏览器不会绕过这个总开关。";
    } else if (tab?.error) {
      elements.emptyTitle.textContent = "网页加载失败";
      elements.emptyDescription.textContent = tab.error;
    } else {
      elements.emptyTitle.textContent = "在工作台中安全浏览";
      elements.emptyDescription.textContent = "在上方输入网址或搜索内容。网站在独立沙箱中运行，无法读取房间数据和工作台密钥。";
    }
  }

  function renderSavedList(root, items, kind) {
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "emptySaved";
      empty.textContent = kind === "bookmark" ? "还没有收藏网页" : "还没有浏览历史";
      root.replaceChildren(empty);
      return;
    }
    root.replaceChildren(...items.slice(0, 60).map((item) => {
      const row = document.createElement("div");
      row.className = "savedItem";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "savedLink";
      const title = document.createElement("strong");
      title.textContent = escapeLabel(item.title, item.url);
      const url = document.createElement("small");
      url.textContent = item.url;
      link.append(title, url);
      link.addEventListener("click", () => navigate(item.url));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "savedRemove";
      remove.textContent = "×";
      remove.title = "移除";
      remove.addEventListener("click", () => removeSaved(kind, item.url));
      row.append(link, remove);
      return row;
    }));
  }

  function renderLibrary() {
    renderSavedList(elements.bookmarksList, state.bookmarks, "bookmark");
    renderSavedList(elements.historyList, state.history, "history");
  }

  function render() {
    if (!state.browser) return;
    renderTabs();
    renderToolbar();
    renderEmptyState();
    renderLibrary();
    scheduleViewport();
  }

  let historyWrite = Promise.resolve();
  function rememberHistory(tab) {
    if (!tab?.url || tab.loading || tab.error) return;
    const previous = state.history[0];
    if (previous?.url === tab.url && previous?.title === tab.title) return;
    state.history = [{ url: tab.url, title: escapeLabel(tab.title, tab.url), visitedAt: new Date().toISOString() }, ...state.history.filter((item) => item.url !== tab.url)].slice(0, MAX_HISTORY);
    historyWrite = historyWrite.then(() => room.storage.set(HISTORY_KEY, state.history)).catch(() => {});
  }

  function updateBrowserState(next) {
    state.browser = next;
    rememberHistory(activeTab());
    render();
  }

  async function ensureTab() {
    if (!state.browser?.tabs.length) await run(() => room.browser.createTab());
  }

  async function navigate(input) {
    let tab = activeTab();
    if (!tab) {
      await ensureTab();
      tab = activeTab();
    }
    if (!tab) return;
    await run(() => room.browser.navigate(tab.id, input));
    elements.addressInput.blur();
  }

  async function newBlankTab() {
    await run(() => room.browser.createTab());
    elements.addressInput.value = "";
    elements.addressInput.focus();
  }

  async function addBookmark() {
    const tab = activeTab();
    if (!tab?.url) return;
    const existing = state.bookmarks.find((item) => item.url === tab.url);
    state.bookmarks = existing
      ? state.bookmarks.filter((item) => item.url !== tab.url)
      : [{ url: tab.url, title: escapeLabel(tab.title, tab.url) }, ...state.bookmarks].slice(0, 100);
    await room.storage.set(BOOKMARKS_KEY, state.bookmarks);
    render();
    showToast(existing ? "已取消收藏" : "已加入收藏夹");
  }

  async function removeSaved(kind, url) {
    if (kind === "bookmark") {
      state.bookmarks = state.bookmarks.filter((item) => item.url !== url);
      await room.storage.set(BOOKMARKS_KEY, state.bookmarks);
    } else {
      state.history = state.history.filter((item) => item.url !== url);
      await room.storage.set(HISTORY_KEY, state.history);
    }
    renderLibrary();
  }

  let viewportFrame = 0;
  async function reportViewport() {
    const rect = elements.browserSurface.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return false;
    await room.browser.setViewport({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    return true;
  }

  function scheduleViewport() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(async () => {
      try {
        await reportViewport();
      } catch (error) {
        elements.statusText.textContent = error?.message || "网页区域同步失败";
      }
    });
  }

  elements.addressForm.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(elements.addressInput.value);
  });
  elements.newTabButton.addEventListener("click", newBlankTab);
  elements.homeButton.addEventListener("click", newBlankTab);
  elements.backButton.addEventListener("click", () => { const tab = activeTab(); if (tab) run(() => room.browser.goBack(tab.id)); });
  elements.forwardButton.addEventListener("click", () => { const tab = activeTab(); if (tab) run(() => room.browser.goForward(tab.id)); });
  elements.reloadButton.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    run(() => tab.loading ? room.browser.stop(tab.id) : room.browser.reload(tab.id));
  });
  elements.bookmarkButton.addEventListener("click", () => run(addBookmark));
  elements.libraryButton.addEventListener("click", () => {
    elements.libraryPanel.hidden = !elements.libraryPanel.hidden;
    elements.libraryButton.setAttribute("aria-expanded", String(!elements.libraryPanel.hidden));
    scheduleViewport();
  });
  elements.clearBookmarksButton.addEventListener("click", () => run(async () => {
    state.bookmarks = [];
    await room.storage.set(BOOKMARKS_KEY, []);
    renderLibrary();
  }));
  elements.clearHistoryButton.addEventListener("click", () => run(async () => {
    state.history = [];
    await room.storage.set(HISTORY_KEY, []);
    renderLibrary();
  }));
  elements.clearBrowserDataButton.addEventListener("click", () => run(async () => {
    if (!confirm("清理此浏览器房间的 Cookie、站点存储和缓存？收藏夹与历史记录不会删除。")) return;
    await room.browser.clearData();
    showToast("浏览数据已清理");
  }));
  elements.denyPermissionButton.addEventListener("click", () => respondToPermission(false));
  elements.allowPermissionButton.addEventListener("click", () => respondToPermission(true));

  async function respondToPermission(allowed) {
    const request = state.permissionRequest;
    state.permissionRequest = null;
    elements.permissionPrompt.hidden = true;
    scheduleViewport();
    if (request) await run(() => room.browser.respondToPermission(request.requestId, allowed));
  }

  room.browser.onStateChanged(updateBrowserState);
  room.browser.onDownload((event) => {
    const messages = {
      blocked: "下载已被工作台拦截",
      canceled: "已取消下载",
      started: `开始下载：${event.filename || "文件"}`,
      completed: `下载完成：${event.filename || "文件"}`,
      interrupted: `下载中断：${event.filename || "文件"}`,
      failed: event.message || "下载失败"
    };
    if (messages[event.status]) showToast(messages[event.status], ["blocked", "interrupted", "failed"].includes(event.status));
  });
  room.browser.onPermissionRequest((request) => {
    state.permissionRequest = request;
    elements.permissionTitle.textContent = `${request.label}权限请求`;
    elements.permissionOrigin.textContent = request.origin;
    elements.permissionPrompt.hidden = false;
    scheduleViewport();
  });
  new ResizeObserver(scheduleViewport).observe(elements.browserSurface);
  window.addEventListener("resize", scheduleViewport);

  async function boot() {
    const [bookmarks, history, browser] = await Promise.all([
      room.storage.get(BOOKMARKS_KEY),
      room.storage.get(HISTORY_KEY),
      room.browser.getState()
    ]);
    state.bookmarks = Array.isArray(bookmarks) ? bookmarks : [];
    state.history = Array.isArray(history) ? history : [];
    updateBrowserState(browser);
    await reportViewport();
    await ensureTab();
    await reportViewport();
    document.documentElement.dataset.roomReady = "true";
  }

  boot().catch((error) => {
    document.documentElement.dataset.roomError = error?.message || String(error);
    showToast(`浏览器房间启动失败：${error?.message || error}`, true);
  });
})();
