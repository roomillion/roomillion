"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, dialog, protocol, safeStorage, session } = require("electron");
const { RoomStore } = require("./room-store.cjs");
const { RoomDatabaseService } = require("./database.cjs");
const { AiService } = require("./ai-service.cjs");
const { RoomAgentService } = require("./room-agent-service.cjs");
const { DataBackupService } = require("./data-backup-service.cjs");
const { LargeTextService } = require("./large-text-service.cjs");
const { NetworkService } = require("./network-service.cjs");
const { RoomCredentialService } = require("./room-credential-service.cjs");
const { GitService } = require("./git-service.cjs");
const { resolveBundledGit } = require("./platform-runtime.cjs");
const { DiagnosticService } = require("./diagnostic-service.cjs");
const { RoomViewManager } = require("./room-view-manager.cjs");
const { RoomBrowserService } = require("./room-browser-service.cjs");
const { AgentWindowManager } = require("./agent-window-manager.cjs");
const { registerIpcHandlers } = require("./ipc.cjs");
const { resolveExamplePackages } = require("./example-catalog.cjs");
const { resolveRoomModuleAsset } = require("./room-module-service.cjs");
const { ROOM_MODULE_CATALOG } = require("./room-module-catalog.cjs");
const { resolveRoomillionUserDataPath } = require("./brand-profile.cjs");
const { RoomStorageLocation } = require("./room-storage-location.cjs");
const { createComposedRoom, createGeneratedRoom } = require("./generated-room.cjs");
const { applyCustomRuntimeCompatibility, createCustomRoom } = require("./custom-room.cjs");
const { bundleRoomDependency } = require("./room-dependency-bundler.cjs");
const { packDirectory } = require("./room-package.cjs");
const { roomPackagePathsFromArguments } = require("./external-room-open.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "room",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true }
  }
]);

app.setName("千万间 Roomillion");

const smokeMode = process.argv.includes("--smoke");
const previewMode = process.argv.includes("--preview");
const offlineAuditMode = process.argv.includes("--offline-audit");
const runtimeCheckInput = process.argv.find(argument => argument.startsWith("--room-runtime-check="))?.slice("--room-runtime-check=".length);

// Existing alpha installations keep using their original profile when it
// contains user data. Fresh installations use the Roomillion profile.
if (smokeMode || previewMode || runtimeCheckInput) {
  const isolatedProfilePath = path.join(
    app.getPath("temp"),
    `roomillion-${smokeMode ? "smoke" : previewMode ? "preview" : "runtime-check"}-${process.pid}`
  );
  app.setPath("userData", isolatedProfilePath);
  app.setPath("sessionData", path.join(isolatedProfilePath, "session"));
  if (smokeMode) {
    app.commandLine.appendSwitch("disable-gpu");
    app.disableHardwareAcceleration();
  }
} else {
  app.setPath("userData", resolveRoomillionUserDataPath(app.getPath("appData")));
}

let mainWindow;
let roomStore;
let storageLocation;
let database;
let aiService;
let roomAgent;
let dataBackups;
let largeText;
let networkService;
let credentialService;
let gitService;
let diagnostics;
let roomViews;
let roomBrowser;
let agentWindows;
let unregisterIpc;
const ownsPrimaryInstance = Boolean(runtimeCheckInput) || smokeMode || previewMode || app.requestSingleInstanceLock();
const pendingExternalRoomPaths = [];
let externalRoomConsumerReady = false;
let offlineNetworkAttempts = 0;

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function queueExternalRoomPaths(paths) {
  for (const packagePath of paths) {
    if (externalRoomConsumerReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("workbench:roomImportRequested", packagePath);
    else if (!pendingExternalRoomPaths.includes(packagePath)) pendingExternalRoomPaths.push(packagePath);
  }
  focusMainWindow();
}

if (!runtimeCheckInput && !smokeMode && ownsPrimaryInstance) {
  queueExternalRoomPaths(roomPackagePathsFromArguments(process.argv));
  app.on("second-instance", (_event, commandLine, workingDirectory) => {
    queueExternalRoomPaths(roomPackagePathsFromArguments(commandLine, workingDirectory));
  });
  app.on("open-file", (event, packagePath) => {
    event.preventDefault();
    queueExternalRoomPaths(roomPackagePathsFromArguments([packagePath]));
  });
}

function getWorkbenchWindows() {
  if (agentWindows) return agentWindows.getWorkbenchWindows();
  return mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : [];
}

function broadcastWorkbench(channel, payload) {
  for (const window of getWorkbenchWindows()) {
    if (!window.webContents?.isDestroyed?.()) window.webContents.send(channel, payload);
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function createRoomProtocolHandler() {
  return require("./room-protocol-handler.cjs").createRoomProtocolHandler({
    roomStore,
    resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "room-modules") : path.join(app.getAppPath(), "resources", "room-modules")
  });
}

function getExamplePackages() {
  return resolveExamplePackages({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  });
}

function getBundledGit() {
  return resolveBundledGit({
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#edf2ef",
    title: "千万间 Roomillion",
    ...(process.platform === "linux" ? { icon: app.isPackaged
      ? path.join(process.resourcesPath, "app-icon.png")
      : path.join(__dirname, "..", "..", "build", "generated", "icons", "256x256.png") } : {}),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f7faf8",
      symbolColor: "#42574e",
      height: 38
    },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "workbench-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", () => {
    roomViews?.destroyAll();
    agentWindows?.dispose();
  });
  return mainWindow;
}

function terminateSmoke(code) {
  // Multi-view smoke runs must return their exact code without leaving Chromium children in CI.
  if (typeof process.reallyExit === "function") process.reallyExit(code);
  process.exit(code);
}

async function writeSmokeReport(payload) {
  const requestedPath = process.env.ZHIBIAN_SMOKE_REPORT_PATH;
  if (!requestedPath) return null;
  if (typeof requestedPath !== "string" || requestedPath.length > 2000 || path.extname(requestedPath).toLowerCase() !== ".json") {
    throw new Error("冒烟报告路径无效");
  }
  const reportPath = path.resolve(requestedPath);
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, `${JSON.stringify({
    kind: "roomillion-smoke-report",
    formatVersion: "0.1",
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    ...payload
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return reportPath;
}

async function runSmokeCheck(dataRoot) {
  const richText = await mainWindow.webContents.executeJavaScript(`(() => {
    const node=document.createElement('div');
    renderAgentRichText(node, '**方案**\\n\\n- 添加图书\\n\\n| 字段 | 说明 |\\n| --- | --- |\\n| 书名 | 文本 |\\n\\n<img src=x onerror=alert(1)>');
    return { strong: node.querySelectorAll('strong').length, items:node.querySelectorAll('li').length, rows:node.querySelectorAll('tr').length, images:node.querySelectorAll('img').length, literal:node.textContent.includes('<img') };
  })()`);
  if (richText.strong !== 1 || richText.items !== 1 || richText.rows !== 2 || richText.images !== 0 || !richText.literal) throw new Error("Agent 安全文本排版检查失败");
  const initialRooms = await mainWindow.webContents.executeJavaScript("window.workbench.getState().then((state) => state.rooms.length)");
  const providerUiResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    await showProviderDialog();
    const result = {
      dialogOpen: document.getElementById("providerDialog").open,
      title: document.querySelector("#providerDialog h2")?.textContent,
      listHeading: document.querySelector(".providerProfilesHeader strong")?.textContent,
      newConnectionAction: document.getElementById("newProviderButton")?.textContent,
      editorInitiallyHidden: document.getElementById("providerEditorPanel").hidden
    };
    startNewProvider();
    const picker = document.getElementById("providerPickerButton");
    // Adding a provider now opens the searchable directory immediately.
    Object.assign(result, {
      pickerExpanded: picker.getAttribute("aria-expanded") === "true" && !document.getElementById("providerChoiceList").hidden,
      pickerChoiceCount: document.querySelectorAll("[data-provider-choice]").length,
      pickerHasKimi: Boolean(document.querySelector('[data-provider-choice="kimi-coding"]'))
    });
    const search = document.getElementById("providerSearch");
    const searchChecks = [];
    const checkSearch = (label, caret) => searchChecks.push({
      label,
      focused: document.activeElement === search,
      caretPreserved: search.selectionStart === caret && search.selectionEnd === caret
    });
    const replaceSearch = (text, inputType = "insertText", isComposing = false) => {
      search.setRangeText(text, search.selectionStart, search.selectionEnd, "end");
      const caret = search.selectionStart;
      search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text, isComposing }));
      checkSearch(inputType + ":" + search.value, caret);
    };
    search.focus();
    search.select();
    replaceSearch("");
    // Do not refocus between keystrokes: this catches a picker stealing focus after one letter.
    for (const letter of "kimi") replaceSearch(letter);
    result.searchFiltersKimi = Boolean(document.querySelector('[data-provider-choice="kimi-coding"]'));
    search.setSelectionRange(2, 2);
    replaceSearch("z");
    search.setSelectionRange(2, 3);
    replaceSearch("", "deleteContentBackward");
    search.select();
    replaceSearch("zzzz-no-such-provider");
    result.searchNoMatches = document.querySelectorAll("[data-provider-choice]").length === 0;
    search.select();
    replaceSearch("", "deleteContentBackward");
    search.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    replaceSearch("中", "insertCompositionText", true);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, bubbles: true, cancelable: true }));
    checkSearch("IME arrow retains input", 1);
    replaceSearch("国", "insertCompositionText", true);
    search.dispatchEvent(new CompositionEvent("compositionend", { data: "中国", bubbles: true }));
    checkSearch("IME completed", 2);
    search.select();
    replaceSearch("kimi", "insertFromPaste");
    result.searchChecks = searchChecks;
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    result.searchArrowEntersChoices = document.activeElement.matches(".providerChoice:not(:disabled)");
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    result.searchEscapeClosesChoices = document.getElementById("providerChoiceList").hidden && document.activeElement === picker;
    search.focus();
    search.select();
    replaceSearch("", "deleteContentBackward");
    document.querySelector('[data-provider-choice="kimi-coding"]')?.click();
    Object.assign(result, {
      pickerSelectedProvider: document.getElementById("providerSelect").value,
      pickerValue: document.getElementById("providerPickerValue").textContent,
      pickerClosedAfterSelection: document.getElementById("providerChoiceList").hidden
    });
    document.querySelector('[data-provider-choice="xiaomi-token-plan-cn"]')?.click();
    Object.assign(result, {
      providerCount: document.getElementById("providerSelect").options.length,
      providerIds: [...document.getElementById("providerSelect").options].map((option) => option.value),
      providerGroups: [...document.querySelectorAll("#providerSelect optgroup")].map((group) => group.label),
      providerCatalogSummary: document.getElementById("providerCatalogSummary").textContent,
      selectedProvider: document.getElementById("providerSelect").value,
      models: [...document.querySelectorAll("[data-provider-model-id]")].map((input) => input.dataset.providerModelId),
      selectedModels: [...document.querySelectorAll("[data-provider-model-id]:checked")].map((input) => input.dataset.providerModelId),
      customFieldsHidden: document.getElementById("customProviderFields").hidden,
      apiKeyRequired: document.getElementById("providerApiKey").required,
      endpoint: document.getElementById("providerEndpoint").textContent
    });
    const source = await window.workbench.saveProvider({
      label: "冒烟 MiMo 连接",
      providerId: "xiaomi-token-plan-cn",
      model: "mimo-v2.5",
      apiKey: "smoke-mimo-token",
      rememberKey: false
    });
    let snapshot = await window.workbench.getState();
    state.provider = snapshot.provider;
    state.aiProfiles = snapshot.aiProfiles;
    state.providerEditorOpen = false;
    state.editingProviderId = null;
    state.credentialSourceProfileId = null;
    renderProvider();
    const addButton = document.querySelector('[data-add-provider-model="' + source.id + '"]');
    addButton?.click();
    result.quickAdd = {
      hasAction: Boolean(addButton),
      selectedProvider: document.getElementById("providerSelect").value,
      providerLocked: document.getElementById("providerSelect").disabled,
      selectedModels: [...document.querySelectorAll("[data-provider-model-id]:checked:not(:disabled)")].map((input) => input.dataset.providerModelId),
      enabledModelsVisible: [...document.querySelectorAll("[data-provider-model-id]:disabled")].map((input) => input.dataset.providerModelId),
      keyRequired: document.getElementById("providerApiKey").required,
      keyValue: document.getElementById("providerApiKey").value,
      reuseVisible: !document.getElementById("credentialReuseNotice").hidden,
      reuseText: document.getElementById("credentialReuseText").textContent,
      saveAction: document.getElementById("saveProviderButton").textContent
    };
    const [added] = await saveProviderSelection();
    snapshot = await window.workbench.getState();
    result.enabledModels = snapshot.aiProfiles.map((profile) => ({
      model: profile.model,
      hasSessionKey: profile.hasSessionKey,
      isActive: profile.isActive
    }));
    startEditingProvider(snapshot.aiProfiles.find((profile) => profile.id === added.id));
    result.editPreservesDefault = providerFormPayload().activate === false;
    closeProviderEditor();
    await window.workbench.deleteProvider(source.id);
    await window.workbench.deleteProvider(added.id);
    snapshot = await window.workbench.getState();
    state.provider = snapshot.provider;
    state.aiProfiles = snapshot.aiProfiles;
    state.providerEditorOpen = false;
    state.editingProviderId = null;
    state.credentialSourceProfileId = null;
    renderProvider();
    document.getElementById("providerDialog").close();
    return result;
  })()`);
  if (
    !providerUiResult.dialogOpen ||
    providerUiResult.title !== "AI 能力中心" ||
    providerUiResult.listHeading !== "已连接提供商" ||
    !providerUiResult.newConnectionAction.includes("添加提供商") ||
    !providerUiResult.editorInitiallyHidden ||
    providerUiResult.providerCount < 41 ||
    !providerUiResult.providerIds.includes("kimi-coding") ||
    !providerUiResult.providerIds.includes("moonshotai-cn") ||
    !providerUiResult.providerIds.includes("openai-codex") ||
    !providerUiResult.providerGroups.includes("中国区与编程订阅") ||
    !providerUiResult.pickerExpanded ||
    providerUiResult.pickerChoiceCount < 41 ||
    !providerUiResult.pickerHasKimi ||
    !providerUiResult.searchFiltersKimi ||
    !providerUiResult.searchNoMatches ||
    providerUiResult.searchChecks.some((check) => !check.focused || !check.caretPreserved) ||
    !providerUiResult.searchArrowEntersChoices ||
    !providerUiResult.searchEscapeClosesChoices ||
    providerUiResult.pickerSelectedProvider !== "kimi-coding" ||
    !providerUiResult.pickerValue.includes("Kimi") ||
    !providerUiResult.pickerClosedAfterSelection ||
    !providerUiResult.providerCatalogSummary.includes("Pi 原生 40 个") ||
    providerUiResult.selectedProvider !== "xiaomi-token-plan-cn" ||
    !providerUiResult.models.includes("mimo-v2.5") ||
    !providerUiResult.models.includes("mimo-v2.5-pro") ||
    providerUiResult.selectedModels.join(",") !== "mimo-v2.5" ||
    !providerUiResult.customFieldsHidden ||
    !providerUiResult.apiKeyRequired ||
    !providerUiResult.endpoint.includes("token-plan-cn.xiaomimimo.com") ||
    !providerUiResult.quickAdd?.hasAction ||
    providerUiResult.quickAdd.selectedProvider !== "xiaomi-token-plan-cn" ||
    !providerUiResult.quickAdd.providerLocked ||
    providerUiResult.quickAdd.selectedModels.join(",") !== "mimo-v2.5-pro" ||
    providerUiResult.quickAdd.enabledModelsVisible.join(",") !== "mimo-v2.5" ||
    providerUiResult.quickAdd.keyRequired ||
    providerUiResult.quickAdd.keyValue !== "" ||
    !providerUiResult.quickAdd.reuseVisible ||
    !providerUiResult.quickAdd.reuseText.includes("明文不会返回") ||
    providerUiResult.quickAdd.saveAction !== "启用所选模型" ||
    providerUiResult.enabledModels.length !== 2 ||
    providerUiResult.enabledModels.some((profile) => !profile.hasSessionKey) ||
    providerUiResult.enabledModels.filter((profile) => profile.isActive).length !== 1 ||
    !providerUiResult.editPreservesDefault
  ) {
    throw new Error(`AI 能力中心 Provider 选择检查失败：${JSON.stringify(providerUiResult)}`);
  }
  const agentUiResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    const session = await window.workbench.createRoomAgentSession();
    state.agentSessions = await window.workbench.listRoomAgentSessions();
    state.agentSession = await window.workbench.getRoomAgentSession(session.id);
    renderAgentWorkspace();
    state.agentTabOpen = true;
    state.activeSurface = "agent";
    renderTabs();
    document.getElementById("generateDialog").show();
    const result = {
      dialogOpen: document.getElementById("generateDialog").open,
      surface: state.activeSurface,
      agentTab: document.querySelector('#tabs [data-surface="agent"]')?.textContent,
      title: document.getElementById("agentSessionTitle").textContent,
      sessionCount: document.querySelectorAll("#agentSessionList .agentSessionItem").length,
      suggestionCount: document.querySelectorAll("[data-agent-suggestion]").length,
      hasTimeline: Boolean(document.getElementById("agentTimeline")),
      hasStop: Boolean(document.getElementById("stopAgentButton")),
      hasAttach: Boolean(document.getElementById("agentAttachButton")),
      imageAccept: document.getElementById("agentImageInput")?.accept,
      visionStatus: document.getElementById("agentVisionStatus")?.textContent,
      imageOnlyAllowed: !document.getElementById("generatePrompt")?.required,
      hasImagePreview: Boolean(document.getElementById("agentImagePreviewDialog")),
      skill: document.querySelector(".agentSkillCard strong")?.textContent,
      provider: document.getElementById("agentProviderLabel").textContent
    };
    if (!document.getElementById('agentProjectButton') || document.getElementById('agentProjectButton').disabled || !document.getElementById('agentProjectPanel').hidden) throw new Error('项目导入入口或初始显示异常');
    state.agentSession.sourceProject = { name: '<img src=x>源码', files: [{ path: 'app.js', bytes: 20 }], totalBytes: 20, skipped: { sensitive: 1 }, warnings: ['未执行原项目代码'] };
    state.agentSession.projectAssessment = { recommendation: 'refactor', summary: '<img src=x>需要改写' };
    renderAgentWorkspace();
    if (document.getElementById('agentProjectPanel').hidden || !document.getElementById('agentProjectSummary').textContent.includes('需要重构') || document.querySelector('#agentProjectPanel img') || !document.getElementById('agentProjectButton').disabled) throw new Error('项目评估显示、转义或重复导入保护失败');
    state.agentSession.sourceProject = null;
    state.agentSession.projectAssessment = null;
    state.agentSession.workflow = { phase: "clarifying", questions: ["谁来使用？推荐个人使用。", "多少数据？推荐百条记录。"] };
    renderAgentWorkspace();
    result.clarificationQuestions = document.querySelectorAll('.agentQuestion').length;
    result.noEarlyApproval = ![...document.querySelectorAll('.agentWorkflowCard button')].some(button => button.textContent.includes('同意方案'));
    const questionForm = document.querySelector('.agentQuestionForm');
    questionForm.dispatchEvent(new Event('submit', { cancelable: true }));
    if (!questionForm.querySelector('[role="status"]').textContent.includes('第 1 题')) throw new Error('问答漏答提示失败');
    const draftNote = questionForm.querySelector('textarea');
    draftNote.value = '仅为界面测试的答案';
    draftNote.dispatchEvent(new Event('input'));
    renderAgentWorkspace();
    if (document.querySelector('.agentQuestion textarea').value !== '仅为界面测试的答案') throw new Error('问答重绘丢失草稿');
    state.agentSession.workflow = { phase: 'clarifying', questionSetId: 'structured-smoke', questions: [{ id: 'audience', title: '谁来使用这个房间？', options: ['个人使用', '多人协作', '你来推荐'], recommended: '个人使用', example: '<img src=x>店主自己记账' }] };
    renderAgentWorkspace();
    if (document.querySelectorAll('.agentQuestion input[type="radio"]').length !== 3 || document.querySelector('.agentQuestion input:checked')) throw new Error('推荐选项应可选择但不能替用户作答');
    if (document.querySelector('.agentQuestion img') || !document.querySelector('.agentQuestion').textContent.includes('（推荐）')) throw new Error('问答示例或推荐显示异常');
    const choice = document.querySelector('.agentQuestion input');
    choice.click();
    renderAgentWorkspace();
    if (!document.querySelector('.agentQuestion input:checked')) throw new Error('选项草稿没有保留');
    if (getComputedStyle(document.querySelector('.agentQuestionOption')).display !== 'flex') throw new Error('问卷选项必须同行显示');
    state.agentSession.workflow = { phase: 'clarifying', questionSetId: 'multiple-smoke', questions: [{ id: 'features', title: '选择需要的功能', selection: 'multiple', options: ['搜索', '导出', '你来推荐'] }] };
    renderAgentWorkspace();
    const multipleInputs = [...document.querySelectorAll('.agentQuestion input[type="checkbox"]')];
    multipleInputs[0].click(); multipleInputs[1].click();
    renderAgentWorkspace();
    if (document.querySelectorAll('.agentQuestion input:checked').length !== 2) throw new Error('多选问卷丢失组合答案');
    if (document.querySelector('.agentQuestion details').open) throw new Error('未填写的补充说明应默认折叠');
    const fontBefore = getComputedStyle(document.getElementById('generatePrompt')).fontSize;
    applyWorkbenchFontSize('extra', { persist: false, broadcast: false });
    const fontAfter = getComputedStyle(document.getElementById('generatePrompt')).fontSize;
    applyWorkbenchFontSize('standard', { persist: false, broadcast: false });
    if (parseFloat(fontAfter) <= parseFloat(fontBefore)) throw new Error('字号设置没有生效');
    if (!document.getElementById('agentTopNewButton')) throw new Error('缺少常驻新对话');
    state.agentSession.workflow = { phase: "review", plan: Object.fromEntries(["overview", "features", "usage", "data", "permissions", "steps", "acceptance", "limitations"].map(key => [key, "测试方案说明：<img src=x onerror=alert(1)>不应当作为 HTML 执行"])) };
    renderAgentWorkspace();
    result.planSections = document.querySelectorAll('.agentWorkflowCard h4').length;
    result.safePlanText = !document.querySelector('.agentWorkflowCard img');
    if (!document.querySelector('.agentWorkflowCard button')?.disabled) throw new Error('缺少凭据时不应允许实施');
    const savedProfiles = state.aiProfiles;
    state.aiProfiles = [{ id: 'smoke-ui-model', model: 'test', baseUrl: 'http://localhost:1', hasSessionKey: false }];
    state.agentSession.profileId = 'smoke-ui-model';
    renderAgentWorkspace();
    result.canApprove = document.querySelector('.agentWorkflowCard button')?.disabled === false;
    state.agentSession.status = "working";
    renderAgentWorkspace();
    result.busyApprovalDisabled = document.querySelector('.agentWorkflowCard button')?.disabled === true;
    state.aiProfiles = savedProfiles;
    state.agentSession.status = "idle";
    state.agentSession.workflow = { phase: "clarifying" };
    document.getElementById("generateDialog").close();
    state.agentTabOpen = false;
    state.activeSurface = "home";
    renderTabs();
    await window.workbench.deleteRoomAgentSession(session.id);
    state.agentSessions = [];
    state.agentSession = null;
    return result;
  })()`);
  if (
    !agentUiResult.dialogOpen ||
    agentUiResult.clarificationQuestions !== 2 ||
    agentUiResult.planSections !== 8 ||
    !agentUiResult.noEarlyApproval || !agentUiResult.safePlanText || !agentUiResult.canApprove || !agentUiResult.busyApprovalDisabled ||
    agentUiResult.surface !== "agent" ||
    !agentUiResult.agentTab?.includes("AI 创建房间") ||
    agentUiResult.title !== "新房间对话" ||
    agentUiResult.sessionCount !== 1 ||
    agentUiResult.suggestionCount !== 3 ||
    !agentUiResult.hasTimeline ||
    !agentUiResult.hasStop ||
    !agentUiResult.hasAttach ||
    !agentUiResult.imageAccept.includes("image/png") ||
    !agentUiResult.visionStatus.includes("图片") ||
    !agentUiResult.visionStatus.includes("AI 对话仍可访问当前模型 API") ||
    !agentUiResult.imageOnlyAllowed ||
    !agentUiResult.hasImagePreview ||
    agentUiResult.skill !== "智变房间构建器"
  ) {
    throw new Error(`Pi Agent 工作区界面检查失败：${JSON.stringify(agentUiResult)}`);
  }
  const p1Ui = await mainWindow.webContents.executeJavaScript(`(() => {
    setAgentSidebar(false);
    const collapsed = getComputedStyle(document.querySelector('.agentSidebar')).display === 'none';
    setAgentSidebar(true);
    const expanded = getComputedStyle(document.querySelector('.agentSidebar')).display !== 'none';
    const tool = createAgentToolElement({ id: 'smoke-p1', status: 'success', label: '测试', details: { testChecks: [{ id: 'safe', passed: true }] } });
    startNewProvider();
    const profilesHidden = getComputedStyle(document.querySelector('.providerProfiles')).display === 'none';
    const choosing = elements.providerDialog.classList.contains('choosingProvider');
    const keyBeforeModels = Boolean(elements.providerApiKey.compareDocumentPosition(document.getElementById('providerModelPickerField')) & Node.DOCUMENT_POSITION_FOLLOWING);
    closeProviderEditor();
    return { collapsed, expanded, profilesHidden, choosing, keyBeforeModels, detail: Boolean(tool.querySelector('details')), duplicateProgress: Boolean(tool.querySelector('.agentToolProgress')) };
  })()`);
  if (!p1Ui.collapsed || !p1Ui.expanded || !p1Ui.profilesHidden || !p1Ui.choosing || !p1Ui.keyBeforeModels || !p1Ui.detail || p1Ui.duplicateProgress) throw new Error('P1 UI regression: ' + JSON.stringify(p1Ui));
  const agentDetachRequest = await mainWindow.webContents.executeJavaScript(`(async () => {
    await showGenerateDialog();
    const result = await detachAgentWorkspace();
    return {
      mode: result.mode,
      detachedTab: document.querySelector('#tabs [data-surface="agent"]')?.classList.contains("detached"),
      homeActive: document.querySelector('#tabs [data-surface="home"]')?.classList.contains("active")
    };
  })()`);
  const detachedAgentWindow = agentWindows.window;
  if (!detachedAgentWindow || detachedAgentWindow.isDestroyed()) throw new Error("AI 创建独立窗口未创建");
  await new Promise(resolve => setTimeout(resolve, 100));
  // Linux window managers are allowed to deny focus stealing. The Windows
  // foreground regression remains strict on the platform where it occurred.
  if (process.platform === "win32" && !detachedAgentWindow.isFocused()) throw new Error("AI 独立窗口弹出后未获得焦点");
  await mainWindow.webContents.executeJavaScript("applyWorkbenchFontSize('large')");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const detachedAgentUi = await detachedAgentWindow.webContents.executeJavaScript(`(() => ({
    agentWindow: document.body.classList.contains("agentWindow"),
    workspaceOpen: document.getElementById("generateDialog").open,
    appShellHidden: getComputedStyle(document.getElementById("appShell")).display,
    dockTitle: document.getElementById("agentWindowButton").title,
    fontSize: document.documentElement.dataset.fontSize,
    sessionCount: document.querySelectorAll("#agentSessionList .agentSessionItem").length
  }))()`);
  await mainWindow.webContents.executeJavaScript("applyWorkbenchFontSize('standard')");
  agentWindows.dock({ reason: "smoke" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const dockedAgentUi = await mainWindow.webContents.executeJavaScript(`(() => ({
    workspaceOpen: document.getElementById("generateDialog").open,
    active: document.querySelector('#tabs [data-surface="agent"]')?.classList.contains("active"),
    detached: state.agentDetached
  }))()`);
  if (
    agentDetachRequest.mode !== "detached" ||
    !agentDetachRequest.detachedTab ||
    !agentDetachRequest.homeActive ||
    !detachedAgentUi.agentWindow ||
    !detachedAgentUi.workspaceOpen ||
    detachedAgentUi.appShellHidden !== "none" ||
    detachedAgentUi.dockTitle !== "收回工作台" ||
    detachedAgentUi.fontSize !== "large" ||
    detachedAgentUi.sessionCount < 1 ||
    !dockedAgentUi.workspaceOpen ||
    !dockedAgentUi.active ||
    dockedAgentUi.detached
  ) {
    throw new Error(`AI 创建标签独立窗口检查失败：${JSON.stringify({ agentDetachRequest, detachedAgentUi, dockedAgentUi })}`);
  }
  for (const session of roomAgent.listSessions()) await roomAgent.deleteSession(session.id);
  await mainWindow.webContents.executeJavaScript(`(async () => {
    state.agentSessions = [];
    state.agentSession = null;
    await closeAgentWorkspace();
  })()`);
  const examplesResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    await showExamplesDialog();
    const result = {
      dialogOpen: document.getElementById("examplesDialog").open,
      count: document.querySelectorAll("#examplesGrid .exampleCard").length,
      names: [...document.querySelectorAll("#examplesGrid .exampleTitleRow h3")].map((item) => item.textContent)
    };
    document.getElementById("examplesDialog").close();
    return result;
  })()`);
  if (!examplesResult.dialogOpen || examplesResult.count !== 6 || !examplesResult.names.includes("千万间浏览器") || !examplesResult.names.includes("AI 辩论场") || !examplesResult.names.includes("AI模型能力测试") || !examplesResult.names.includes("离线 3D 晶体挑战")) {
    throw new Error(`示例房间库界面检查失败：${JSON.stringify(examplesResult)}`);
  }
  const inspection = await roomStore.inspectPackage(getExamplePackages()[0].packagePath, { source: "external" });
  const inspectionResult = await mainWindow.webContents.executeJavaScript(`(() => {
    renderImportInspection(${JSON.stringify(inspection)});
    const states = Object.fromEntries([...document.querySelectorAll("#importPermissions input[data-permission-key]")]
      .map((input) => [input.dataset.permissionKey, { checked: input.checked, disabled: input.disabled }]));
    return {
      dialogOpen: document.getElementById("importDialog").open,
      risk: document.getElementById("importRiskBadge").textContent,
      states
    };
  })()`);
  if (
    !inspectionResult.dialogOpen ||
    inspectionResult.risk !== "高风险" ||
    !inspectionResult.states["database.private"]?.checked ||
    !inspectionResult.states["database.private"]?.disabled ||
    inspectionResult.states["files.pick"]?.checked ||
    inspectionResult.states["files.export"]?.checked ||
    inspectionResult.states["ai.general"]?.checked
  ) {
    throw new Error(`导入预检界面检查失败：${JSON.stringify(inspectionResult)}`);
  }
  await mainWindow.webContents.executeJavaScript("cancelPendingImport()");
  if (roomStore.pendingImports.size !== 0) throw new Error("取消导入后仍残留预检内容");
  const embeddedSourceRoot = path.join(dataRoot, "embedded-smoke-source");
  const embeddedPackageRoot = path.join(dataRoot, "embedded-smoke-package");
  const embeddedPackagePath = path.join(dataRoot, "embedded-smoke.room");
  await fsp.mkdir(path.join(embeddedSourceRoot, "app"), { recursive: true });
  await fsp.mkdir(embeddedPackageRoot, { recursive: true });
  await fsp.writeFile(path.join(embeddedSourceRoot, "manifest.json"), JSON.stringify({
    formatVersion: "0.1",
    id: "cn.zhibian.smoke.embedded",
    name: "随房间依赖验收",
    version: "1.0.0",
    runtime: { roomSdk: "1", minimumWorkbench: "0.3.0-alpha.1" },
    entry: "app/index.html",
    permissions: { database: "private", network: [] },
    hostModules: [],
    embeddedDependencies: []
  }), "utf8");
  await fsp.writeFile(path.join(embeddedSourceRoot, "app", "index.html"), "<!doctype html><title>随房间依赖验收</title>", "utf8");
  await fsp.writeFile(path.join(embeddedPackageRoot, "LICENSE"), "MIT License\n", "utf8");
  await fsp.writeFile(path.join(embeddedPackageRoot, "tiny-helper.js"), "window.TinyHelper={ok:true};\n", "utf8");
  await bundleRoomDependency({
    roomSourceRoot: embeddedSourceRoot,
    packageName: "tiny-helper",
    packageVersion: "1.0.0",
    license: "MIT",
    source: "local:smoke-fixture/tiny-helper-1.0.0",
    packageRoot: embeddedPackageRoot,
    licenseSource: "LICENSE",
    assets: [{ source: "tiny-helper.js", target: "tiny-helper.js" }]
  });
  await packDirectory(embeddedSourceRoot, embeddedPackagePath);
  const embeddedInspection = await roomStore.inspectPackage(embeddedPackagePath, { source: "external" });
  const embeddedInspectionResult = await mainWindow.webContents.executeJavaScript(`(() => {
    renderImportInspection(${JSON.stringify(embeddedInspection)});
    return {
      risk: document.getElementById("importRiskBadge").textContent,
      details: document.getElementById("importPackageDetails").textContent,
      risks: document.getElementById("importRisks").textContent
    };
  })()`);
  if (
    embeddedInspectionResult.risk !== "需注意" ||
    !embeddedInspectionResult.details.includes("tiny-helper@1.0.0") ||
    !embeddedInspectionResult.details.includes("MIT") ||
    !embeddedInspectionResult.details.includes(embeddedInspection.room.embeddedDependencies[0].contentSha256) ||
    !embeddedInspectionResult.risks.includes("工作台目录外依赖")
  ) {
    throw new Error(`随房间依赖预检界面检查失败：${JSON.stringify(embeddedInspectionResult)}`);
  }
  await mainWindow.webContents.executeJavaScript("cancelPendingImport()");
  if (roomStore.pendingImports.size !== 0) throw new Error("取消额外依赖房间预检后仍残留内容");
  const workbenchResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    const room = await window.workbench.installExample();
    await openRoom(room.id);
    await openHome();
    const homeUi = {
      homeTabActive: document.querySelector('#tabs [data-surface="home"]')?.classList.contains("active"),
      cardCount: document.querySelectorAll("#installedRoomsGrid .installedRoomCard").length,
      cardRoomId: document.querySelector("#installedRoomsGrid .installedRoomCard")?.dataset.roomId,
      cardName: document.querySelector("#installedRoomsGrid .installedRoomContent strong")?.textContent,
      roomCount: document.getElementById("homeRoomCount")?.textContent
    };
    const roomListClones = [];
    const homeCardClones = [];
    for (let index = 0; index < 18; index += 1) {
      const row = document.querySelector("#roomList .roomItemRow")?.cloneNode(true);
      const card = document.querySelector("#installedRoomsGrid .installedRoomCard")?.cloneNode(true);
      if (row) {
        row.querySelector("strong") && (row.querySelector("strong").textContent = "侧栏溢出测试房间 " + (index + 1));
        elements.roomList.appendChild(row);
        roomListClones.push(row);
      }
      if (card) {
        card.querySelector("strong") && (card.querySelector("strong").textContent = "主页溢出测试房间 " + (index + 1));
        elements.installedRoomsGrid.appendChild(card);
        homeCardClones.push(card);
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const shellBounds = document.getElementById("appShell").getBoundingClientRect();
    const titlebarBounds = document.getElementById("windowTitlebar").getBoundingClientRect();
    const sidebarBounds = document.getElementById("mainSidebar").getBoundingClientRect();
    const roomViewportBounds = document.getElementById("roomViewport").getBoundingClientRect();
    const footerBounds = document.querySelector(".sidebarFooter").getBoundingClientRect();
    const homePage = document.getElementById("welcome");
    const homePageInlineStyle = homePage.getAttribute("style");
    homePage.style.height = "420px";
    homePage.style.alignSelf = "start";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const collectionOverflowUi = {
      shellFitsViewport: shellBounds.top >= titlebarBounds.bottom - 1 && shellBounds.bottom <= innerHeight + 1,
      sidebarFitsViewport: sidebarBounds.top >= shellBounds.top - 1 && sidebarBounds.bottom <= innerHeight + 1,
      roomViewportFitsViewport: roomViewportBounds.top >= shellBounds.top && roomViewportBounds.bottom <= innerHeight + 1,
      shellHeight: Math.round(shellBounds.height),
      availableHeight: Math.round(innerHeight - titlebarBounds.height),
      sidebarScrollable: elements.roomList.scrollHeight > elements.roomList.clientHeight,
      sidebarOverflowY: getComputedStyle(elements.roomList).overflowY,
      footerVisible: footerBounds.top >= sidebarBounds.top && footerBounds.bottom <= sidebarBounds.bottom + 1,
      homeScrollable: homePage.scrollHeight > homePage.clientHeight,
      homeOverflowY: getComputedStyle(homePage).overflowY,
      gridOverflow: getComputedStyle(elements.installedRoomsGrid).overflow,
      renderedHomeCards: document.querySelectorAll("#installedRoomsGrid .installedRoomCard").length
    };
    elements.roomList.scrollTop = elements.roomList.scrollHeight;
    homePage.scrollTop = homePage.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    collectionOverflowUi.sidebarScrollMoved = elements.roomList.scrollTop > 0;
    collectionOverflowUi.homeScrollMoved = homePage.scrollTop > 0;
    roomListClones.forEach((clone) => clone.remove());
    homeCardClones.forEach((clone) => clone.remove());
    if (homePageInlineStyle === null) homePage.removeAttribute("style");
    else homePage.setAttribute("style", homePageInlineStyle);
    elements.roomList.scrollTop = 0;
    homePage.scrollTop = 0;
    await openRoom(room.id);
    applySidebarState("full", { persist: false });
    await new Promise((resolve) => setTimeout(resolve, 240));
    const fullState = document.getElementById("appShell").dataset.sidebarState;
    const fullWidth = document.getElementById("mainSidebar").getBoundingClientRect().width;
    document.getElementById("sidebarToggle").click();
    await new Promise((resolve) => setTimeout(resolve, 240));
    const compactState = document.getElementById("appShell").dataset.sidebarState;
    const compactWidth = document.getElementById("mainSidebar").getBoundingClientRect().width;
    const compactViewportWidth = document.getElementById("roomViewport").getBoundingClientRect().width;
    const compactActionLabel = getComputedStyle(document.querySelector("#generateButton .actionLabel")).display;
    const compactRoomText = getComputedStyle(document.querySelector("#roomList .roomItemText")).display;
    const compactRoomIcon = document.querySelector("#roomList .roomIcon")?.textContent;
    document.getElementById("sidebarToggle").click();
    await new Promise((resolve) => setTimeout(resolve, 240));
    const hiddenWidth = document.getElementById("mainSidebar").getBoundingClientRect().width;
    const hiddenViewportWidth = document.getElementById("roomViewport").getBoundingClientRect().width;
    const sidebarUi = {
      states: [fullState, compactState, document.getElementById("appShell").dataset.sidebarState],
      fullWidth,
      compactWidth,
      hiddenWidth,
      compactViewportWidth,
      hiddenViewportWidth,
      compactActionLabel,
      compactRoomText,
      compactRoomIcon,
      hiddenAria: document.getElementById("mainSidebar").getAttribute("aria-hidden"),
      restoreAction: document.getElementById("sidebarToggle").title,
      persisted: localStorage.getItem("zhibian.sidebar.state.v1")
    };
    const windowChromeUi = {
      toggleParent: document.getElementById("sidebarToggle")?.parentElement?.id,
      toggleInWorkspaceHeader: document.querySelector(".workspaceHeader")?.contains(document.getElementById("sidebarToggle")),
      titlebarHeight: Math.round(document.getElementById("windowTitlebar")?.getBoundingClientRect().height || 0),
      toggleLeft: Math.round(document.getElementById("sidebarToggle")?.getBoundingClientRect().left || 0),
      iconHasDivider: Boolean(document.querySelector("#sidebarToggle .sidebarToggleIcon"))
    };
    const overflowClones = [];
    for (let index = 0; index < 14; index += 1) {
      const clone = document.querySelector("#tabs .tab")?.cloneNode(true);
      if (clone) {
        clone.removeAttribute("data-room-id");
        clone.style.flex = "0 0 160px";
        clone.style.minWidth = "160px";
        clone.querySelector(".tabLabel") && (clone.querySelector(".tabLabel").textContent = "溢出测试标签 " + (index + 1));
        elements.tabs.appendChild(clone);
        overflowClones.push(clone);
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    updateTabOverflow();
    const tabsOverflowUi = {
      overflowing: elements.tabs.scrollWidth > elements.tabs.clientWidth,
      scrollbarWidth: getComputedStyle(elements.tabs).scrollbarWidth,
      sidebarScrollbarWidth: getComputedStyle(document.getElementById("roomList")).scrollbarWidth,
      forwardVisible: !document.getElementById("tabsScrollForward").hidden,
      overviewVisible: !document.getElementById("tabOverviewButton").hidden,
      overviewItems: document.querySelectorAll("#tabOverviewMenu .tabOverviewItem").length,
      lowFrequencyActions: document.querySelectorAll("#headerMoreMenu .headerMenuAction").length,
      backupInMore: document.getElementById("headerMoreMenu").contains(document.getElementById("backupButton")),
      headerMoreEnabled: !document.getElementById("headerMoreButton").disabled,
      headerActionsVisible: (() => {
        const header = document.querySelector(".workspaceHeader").getBoundingClientRect();
        const actions = document.querySelector(".headerActions").getBoundingClientRect();
        const rail = document.getElementById("tabRail").getBoundingClientRect();
        return actions.left >= rail.right - 1 && actions.right <= header.right + 1 && rail.left >= header.left - 1;
      })()
    };
    overflowClones.forEach((clone) => clone.remove());
    updateTabOverflow();
    applySidebarState("full", { persist: false });
    localStorage.removeItem("zhibian.sidebar.state.v1");
    await showWorkbenchSettings();
    document.querySelector('[data-theme-choice="ink-light"]')?.click();
    const inkStyle = {
      sidebarBackground: getComputedStyle(document.querySelector(".sidebar")).backgroundColor,
      sidebarColor: getComputedStyle(document.querySelector(".sidebar")).color,
      brandRadius: getComputedStyle(document.querySelector(".brandMark")).borderRadius,
      fontFamily: getComputedStyle(document.documentElement).fontFamily
    };
    document.querySelector('[data-theme-choice="graphite-dark"]')?.click();
    const themeUi = {
      settingsButton: document.getElementById("workbenchSettingsButton")?.title,
      dialogOpen: document.getElementById("workbenchSettingsDialog")?.open,
      optionCount: document.querySelectorAll("[data-theme-choice]").length,
      lightCount: document.querySelectorAll('.themeOption[data-theme-mode="light"]').length,
      darkCount: document.querySelectorAll('.themeOption[data-theme-mode="dark"]').length,
      styleCount: document.querySelectorAll('.themeOption[data-theme-style]').length,
      inkStyle,
      selected: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.themeMode,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      persisted: localStorage.getItem("zhibian.appearance.theme.v1"),
      summary: document.getElementById("themeSummaryNav")?.textContent,
      selectedPressed: document.querySelector('[data-theme-choice="graphite-dark"]')?.getAttribute("aria-pressed"),
      surfaceBackground: getComputedStyle(document.querySelector(".themeModal")).backgroundColor
    };
    document.getElementById("workbenchSettingsDialog").close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    applyWorkbenchTheme("forest-light", { persist: false, broadcast: false });
    localStorage.removeItem("zhibian.appearance.theme.v1");
    const uninstallUi = {
      headerLabel: document.getElementById("uninstallButton")?.childNodes[0]?.textContent?.trim(),
      listActions: document.querySelectorAll("#roomList .roomListUninstall").length,
      contextMenuVisibleBefore: !document.getElementById("roomContextMenu")?.hidden,
      contextMenuVisibleAfter: (() => {
        document.querySelector("#roomList .roomItem")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
        return !document.getElementById("roomContextMenu")?.hidden;
      })(),
      contextMenuAction: document.querySelector("#roomContextMenu [data-room-context-action=uninstall]")?.textContent,
      detailsLabel: document.getElementById("detailsUninstallButton")?.textContent
    };
    let headerMenuDeadline = Date.now() + 3000;
    while (state.headerMenuBusy && Date.now() < headerMenuDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await closeHeaderMenus();
    headerMenuDeadline = Date.now() + 3000;
    while (state.headerMenuBusy && Date.now() < headerMenuDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await toggleHeaderMenu("tabs");
    const headerOverlayUi = {
      menuOpen: !document.getElementById("tabOverviewMenu").hidden,
      expanded: document.getElementById("tabOverviewButton").getAttribute("aria-expanded"),
      suspendedRoomId: state.headerOverlayRoomId
    };
    if (getComputedStyle(document.getElementById('welcome')).display !== 'none' || getComputedStyle(document.getElementById('roomStandby')).display === 'none') throw new Error('房间菜单后方不应露出主页');
    return {
      initialRooms: ${JSON.stringify(initialRooms)},
      room,
      homeUi,
      collectionOverflowUi,
      sidebarUi,
      themeUi,
      windowChromeUi,
      tabsOverflowUi,
      headerOverlayUi,
      detachedWindowUi: {
        headerButtonEnabled: !document.getElementById("detachButton").disabled,
        tabDraggable: document.querySelector('#tabs [data-room-id="' + room.id + '"]')?.draggable === true,
        tabWindowButton: document.querySelector('#tabs [data-room-id="' + room.id + '"] .tabWindow')?.title
      },
      uninstallUi
    };
  })()`);
  const headerSuspendDeadline = Date.now() + 3000;
  while (roomViews.activeRoomId !== null && Date.now() < headerSuspendDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (
    !workbenchResult.headerOverlayUi.menuOpen ||
    workbenchResult.headerOverlayUi.expanded !== "true" ||
    workbenchResult.headerOverlayUi.suspendedRoomId !== workbenchResult.room.id ||
    roomViews.activeRoomId !== null
  ) {
    throw new Error("房间顶部菜单避让检查失败：" + JSON.stringify({
      ui: workbenchResult.headerOverlayUi,
      activeRoomId: roomViews.activeRoomId
    }));
  }
  const restoredHeaderOverlayUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    await closeHeaderMenus();
    return {
      menuHidden: document.getElementById("tabOverviewMenu").hidden,
      expanded: document.getElementById("tabOverviewButton").getAttribute("aria-expanded"),
      suspendedRoomId: state.headerOverlayRoomId
    };
  })()`);
  if (
    !restoredHeaderOverlayUi.menuHidden ||
    restoredHeaderOverlayUi.expanded !== "false" ||
    restoredHeaderOverlayUi.suspendedRoomId !== null ||
    roomViews.activeRoomId !== workbenchResult.room.id
  ) {
    throw new Error("房间顶部菜单恢复检查失败：" + JSON.stringify({
      ui: restoredHeaderOverlayUi,
      activeRoomId: roomViews.activeRoomId
    }));
  }
  if (
    !workbenchResult.homeUi.homeTabActive ||
    workbenchResult.homeUi.cardCount !== 1 ||
    workbenchResult.homeUi.cardRoomId !== workbenchResult.room.id ||
    workbenchResult.homeUi.cardName !== workbenchResult.room.name ||
    workbenchResult.homeUi.roomCount !== "1" ||
    !workbenchResult.detachedWindowUi.headerButtonEnabled ||
    !workbenchResult.detachedWindowUi.tabDraggable ||
    workbenchResult.detachedWindowUi.tabWindowButton !== "在独立窗口打开"
  ) {
    throw new Error(`独立窗口标签控件检查失败：${JSON.stringify(workbenchResult.detachedWindowUi)}`);
  }
  if (
    !workbenchResult.collectionOverflowUi.shellFitsViewport ||
    !workbenchResult.collectionOverflowUi.sidebarFitsViewport ||
    !workbenchResult.collectionOverflowUi.roomViewportFitsViewport ||
    Math.abs(workbenchResult.collectionOverflowUi.shellHeight - workbenchResult.collectionOverflowUi.availableHeight) > 1 ||
    !workbenchResult.collectionOverflowUi.sidebarScrollable ||
    workbenchResult.collectionOverflowUi.sidebarOverflowY !== "auto" ||
    !workbenchResult.collectionOverflowUi.footerVisible ||
    !workbenchResult.collectionOverflowUi.sidebarScrollMoved ||
    !workbenchResult.collectionOverflowUi.homeScrollable ||
    workbenchResult.collectionOverflowUi.homeOverflowY !== "auto" ||
    !workbenchResult.collectionOverflowUi.homeScrollMoved ||
    workbenchResult.collectionOverflowUi.gridOverflow !== "visible" ||
    workbenchResult.collectionOverflowUi.renderedHomeCards !== 19
  ) {
    throw new Error(`多房间窗口布局检查失败：${JSON.stringify(workbenchResult.collectionOverflowUi)}`);
  }
  if (
    workbenchResult.windowChromeUi.toggleParent !== "windowTitlebar" ||
    workbenchResult.windowChromeUi.toggleInWorkspaceHeader ||
    workbenchResult.windowChromeUi.titlebarHeight !== 38 ||
    workbenchResult.windowChromeUi.toggleLeft > 10 ||
    !workbenchResult.windowChromeUi.iconHasDivider
  ) {
    throw new Error(`顶部拖动栏检查失败：${JSON.stringify(workbenchResult.windowChromeUi)}`);
  }
  if (
    !workbenchResult.tabsOverflowUi.overflowing ||
    workbenchResult.tabsOverflowUi.scrollbarWidth !== "none" ||
    workbenchResult.tabsOverflowUi.sidebarScrollbarWidth !== "thin" ||
    !workbenchResult.tabsOverflowUi.forwardVisible ||
    !workbenchResult.tabsOverflowUi.overviewVisible ||
    workbenchResult.tabsOverflowUi.overviewItems < 2 ||
    workbenchResult.tabsOverflowUi.lowFrequencyActions !== 4 ||
    !workbenchResult.tabsOverflowUi.backupInMore ||
    !workbenchResult.tabsOverflowUi.headerMoreEnabled ||
    !workbenchResult.tabsOverflowUi.headerActionsVisible
  ) {
    throw new Error(`多标签溢出布局检查失败：${JSON.stringify(workbenchResult.tabsOverflowUi)}`);
  }
  if (
    workbenchResult.themeUi.settingsButton !== "设置" ||
    !workbenchResult.themeUi.dialogOpen ||
    workbenchResult.themeUi.optionCount !== 22 ||
    workbenchResult.themeUi.lightCount !== 12 ||
    workbenchResult.themeUi.darkCount !== 10 ||
    workbenchResult.themeUi.styleCount !== 6 ||
    workbenchResult.themeUi.inkStyle.sidebarBackground !== "rgb(243, 238, 226)" ||
    workbenchResult.themeUi.inkStyle.sidebarColor !== "rgb(41, 39, 34)" ||
    workbenchResult.themeUi.inkStyle.brandRadius !== "3px" ||
    !workbenchResult.themeUi.inkStyle.fontFamily.includes("SimSun") ||
    workbenchResult.themeUi.selected !== "graphite-dark" ||
    workbenchResult.themeUi.mode !== "dark" ||
    workbenchResult.themeUi.colorScheme !== "dark" ||
    workbenchResult.themeUi.persisted !== "graphite-dark" ||
    workbenchResult.themeUi.summary !== "石墨橙 · 夜间" ||
    workbenchResult.themeUi.selectedPressed !== "true" ||
    workbenchResult.themeUi.surfaceBackground !== "rgb(29, 31, 32)"
  ) {
    throw new Error(`工作台主题设置检查失败：${JSON.stringify(workbenchResult.themeUi)}`);
  }
  if (
    workbenchResult.sidebarUi.states.join(",") !== "full,compact,hidden" ||
    workbenchResult.sidebarUi.fullWidth < 240 ||
    workbenchResult.sidebarUi.compactWidth < 70 ||
    workbenchResult.sidebarUi.compactWidth > 74 ||
    workbenchResult.sidebarUi.hiddenWidth > 1 ||
    workbenchResult.sidebarUi.hiddenViewportWidth <= workbenchResult.sidebarUi.compactViewportWidth + 60 ||
    workbenchResult.sidebarUi.compactActionLabel !== "none" ||
    workbenchResult.sidebarUi.compactRoomText !== "none" ||
    !workbenchResult.sidebarUi.compactRoomIcon ||
    workbenchResult.sidebarUi.hiddenAria !== "true" ||
    workbenchResult.sidebarUi.restoreAction !== "展开栏目" ||
    workbenchResult.sidebarUi.persisted !== "hidden"
  ) {
    throw new Error(`栏目两级收起检查失败：${JSON.stringify(workbenchResult.sidebarUi)}`);
  }
  if (
    workbenchResult.uninstallUi.headerLabel !== "卸载房间" ||
    workbenchResult.uninstallUi.listActions !== 0 ||
    workbenchResult.uninstallUi.contextMenuVisibleBefore ||
    !workbenchResult.uninstallUi.contextMenuVisibleAfter ||
    workbenchResult.uninstallUi.contextMenuAction !== "卸载房间" ||
    workbenchResult.uninstallUi.detailsLabel !== "卸载房间"
  ) {
    throw new Error(`房间卸载入口检查失败：${JSON.stringify(workbenchResult.uninstallUi)}`);
  }
  const view = roomViews.views.get(workbenchResult.room.id);
  if (!view) throw new Error("冒烟测试没有创建房间视图");
  const modelProfiles = await mainWindow.webContents.executeJavaScript(`(async () => {
    const first = await window.workbench.saveProvider({
      label: "冒烟默认模型",
      name: "本地模型 A",
      baseUrl: "http://127.0.0.1:31001/v1",
      model: "smoke-a"
    });
    const second = await window.workbench.saveProvider({
      label: "冒烟房间模型",
      name: "本地模型 B",
      baseUrl: "http://127.0.0.1:31002/v1",
      model: "smoke-b",
      activate: false
    });
    const snapshot = await window.workbench.getState();
    state.provider = snapshot.provider;
    state.aiProfiles = snapshot.aiProfiles;
    state.editingProviderId = first.id;
    renderProvider();
    state.agentSession = await window.workbench.createRoomAgentSession({ profileId: first.id });
    state.agentSession = await window.workbench.setRoomAgentModel(state.agentSession.id, second.id);
    renderAgentHeader();
    return {
      first,
      second,
      activeId: snapshot.provider.id,
      profileCount: snapshot.aiProfiles.length,
      renderedCards: document.querySelectorAll("#providerProfileList .providerProfileCard").length,
      agentPicker: {
        options: document.getElementById("agentModelSelect").options.length,
        selected: document.getElementById("agentModelSelect").value,
        modelLabel: document.getElementById("agentModelLabel").textContent
      }
    };
  })()`);
  if (
    modelProfiles.activeId !== modelProfiles.first.id ||
    modelProfiles.profileCount !== 2 ||
    modelProfiles.renderedCards !== 2 ||
    modelProfiles.agentPicker.options !== 2 ||
    modelProfiles.agentPicker.selected !== modelProfiles.second.id ||
    modelProfiles.agentPicker.modelLabel !== "smoke-b"
  ) {
    throw new Error(`多模型配置界面检查失败：${JSON.stringify(modelProfiles)}`);
  }
  const roomResult = await view.webContents.executeJavaScript(`(async () => {
    await window.room.vector.create({ name: 'smoke-vectors', dimensions: 2, embedding: 'smoke:2' });
    await window.room.vector.upsert('smoke-vectors', [{ id: 'a', vector: [1,0], text: '房间 SDK 实测', metadata: { page: 1 } }], { embedding: 'smoke:2' });
    const matches = await window.room.vector.search('smoke-vectors', [1,0], { embedding: 'smoke:2' });
    if (matches[0]?.text !== '房间 SDK 实测' || matches[0].score < .99) throw new Error('向量 SDK 检索失败');
    await window.room.vector.drop('smoke-vectors');
    if (!window.room.ai.embed || !window.room.files.openBinary || !window.room.files.readBinary || !window.room.files.closeBinary) throw new Error('新 SDK 没有注入房间');
    const models = await window.room.ai.listModels();
    const before = await window.room.ai.getSelection();
    const selected = await window.room.ai.selectModel(${JSON.stringify(modelProfiles.second.id)});
    return {
    title: document.title,
    hasRoomApi: Boolean(window.room?.db?.query && window.room?.files?.exportText),
    hasModelApi: Boolean(window.room?.ai?.listModels && window.room?.ai?.selectModel && window.room?.ai?.onModelsChanged),
    models,
    before,
    selected
    };
  })()`);
  if (
    roomResult.title !== "物资台账" ||
    !roomResult.hasRoomApi ||
    !roomResult.hasModelApi ||
    roomResult.models.length !== 2 ||
    roomResult.before.profileId !== modelProfiles.first.id ||
    roomResult.selected.profileId !== modelProfiles.second.id ||
    roomResult.models.some((model) => "apiKey" in model || "baseUrl" in model)
  ) {
    throw new Error(`房间运行时检查失败：${JSON.stringify(roomResult)}`);
  }
  // Exercise the actual inventory button -> preload -> IPC chain. Stub only
  // the OS picker so smoke runs do not block waiting for a human to save.
  const originalSaveDialog = dialog.showSaveDialog;
  const fileDialogCalls = [];
  const csvPath = path.join(dataRoot, "inventory-dialog-smoke.csv");
  let dialogResult = { canceled: false, filePath: csvPath };
  dialog.showSaveDialog = async (parent, options) => {
    fileDialogCalls.push({ parent, options });
    return dialogResult;
  };
  try {
    await roomViews.detach(workbenchResult.room.id, { force: true });
    const inventoryWindow = roomViews.detachedWindows.get(workbenchResult.room.id).window;
    await view.webContents.executeJavaScript(`(async () => {
      document.getElementById("exportButton").click();
      const deadline = Date.now() + 3000;
      while (!document.getElementById("status").textContent.includes("inventory-dialog-smoke.csv")) {
        if (Date.now() > deadline) throw new Error("物资台账 CSV 导出超时");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })()`);
    if (fileDialogCalls.length !== 1 || fileDialogCalls[0].parent !== inventoryWindow) {
      throw new Error("独立物资台账的 CSV 保存对话框仍绑定了错误窗口");
    }
    if (!(await fsp.readFile(csvPath, "utf8")).startsWith("\ufeffname,quantity,note")) {
      throw new Error("物资台账 CSV 导出内容不正确");
    }
    dialogResult = { canceled: true };
    const canceled = await view.webContents.executeJavaScript(`window.room.files.exportText("canceled.csv", "test")`);
    if (canceled !== null || fileDialogCalls.at(-1).parent !== inventoryWindow) throw new Error("独立房间取消导出检查失败");
    await roomViews.dock(workbenchResult.room.id);
    await view.webContents.executeJavaScript(`window.room.files.exportText("docked.csv", "test")`);
    if (fileDialogCalls.at(-1).parent !== mainWindow) throw new Error("合并回工作台后导出对话框未跟随窗口");
    roomResult.fileDialogs = { detachedCsv: true, canceled: true, docked: true, pickerStubbed: true };
  } finally {
    dialog.showSaveDialog = originalSaveDialog;
    if (roomViews.detachedWindows.has(workbenchResult.room.id)) await roomViews.dock(workbenchResult.room.id);
  }
  const exampleTables = {
    "meeting-actions": "meeting_actions",
    "ai-model-benchmark": "benchmark_runs"
  };
  const exampleRuntimes = [];
  for (const example of getExamplePackages().slice(1)) {
    const installed = await mainWindow.webContents.executeJavaScript(`(async () => {
      const room = await window.workbench.installExample(${JSON.stringify(example.id)});
      await openRoom(room.id);
      return room;
    })()`);
    const exampleView = roomViews.views.get(installed.id);
    const originalComplete = aiService.complete;
    let browserSmokeServer = null;
    let browserSmokeUrl = "";
    let browserSmokeCleaned = false;
    const cleanupBrowserSmoke = async () => {
      if (!browserSmokeServer || browserSmokeCleaned) return;
      browserSmokeCleaned = true;
      await networkService.setRoomNetworkEnabled(false);
      roomBrowser.handleNetworkPolicyChanged();
      await new Promise((resolve) => browserSmokeServer.close(resolve));
    };
    if (example.id === "browser") {
      browserSmokeServer = http.createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end("<!doctype html><html><head><title>千万间浏览器本机验收页</title></head><body><h1>浏览器运行正常</h1></body></html>");
      });
      await new Promise((resolve, reject) => {
        browserSmokeServer.once("error", reject);
        browserSmokeServer.listen(0, "127.0.0.1", resolve);
      });
      browserSmokeUrl = `http://127.0.0.1:${browserSmokeServer.address().port}/browser-smoke`;
      await networkService.setRoomNetworkEnabled(true);
      roomBrowser.handleNetworkPolicyChanged();
    }
    if (example.id === "ai-debate") {
      aiService.complete = async ({ prompt, profileId }) => {
        const profile = aiService.ensureConfigured(profileId);
        const text = prompt.includes("中立、严格的辩论裁判")
          ? "【正方评分】五项合计82分\n【反方评分】五项合计79分\n【关键交锋】双方围绕效率与风险展开交锋。\n【综合评价】双方均有有效论据。\n【获胜方】正方，论证更完整。"
          : prompt.includes("正方辩手")
            ? "正方认为合理使用 AI 能提高学习反馈效率，同时教师监督可以控制风险。"
            : "反方认为过度依赖 AI 可能削弱独立思考，学校必须先建立明确的使用边界。";
        return { text, model: profile.model, profileId, usage: { input: 1, output: 1 } };
      };
    }
    if (example.id === "ai-model-benchmark") {
      aiService.complete = async ({ images, profileId }) => {
        const profile = aiService.ensureConfigured(profileId);
        if (!Array.isArray(images) || images.length !== 1 || images[0].mimeType !== "image/png" || !images[0].data.startsWith("iVBOR")) {
          throw new Error("评测房间图片没有通过 AI Gateway");
        }
        return { text: "{\"vision\":true}", model: profile.model, profileId, usage: { input: 8, output: 3, totalTokens: 11 } };
      };
    }
    let runtime;
    try {
      runtime = await exampleView.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 8000;
      while (${JSON.stringify(example.id)} === "offline-3d-collector" && !document.querySelector("canvas") && document.getElementById("fatal")?.hidden !== false && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      while (${JSON.stringify(example.id)} === "ai-debate" && document.documentElement.dataset.roomReady !== "true" && !document.documentElement.dataset.roomError && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      while (${JSON.stringify(example.id)} === "ai-model-benchmark" && document.documentElement.dataset.roomReady !== "true" && !document.documentElement.dataset.roomError && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      while (${JSON.stringify(example.id)} === "browser" && document.documentElement.dataset.roomReady !== "true" && !document.documentElement.dataset.roomError && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      let aiDebate = null;
      let aiBenchmark = null;
      let browser = null;
      if (${JSON.stringify(example.id)} === "ai-debate") {
        document.getElementById("topicInput").value = "在基础教育中，AI 助手利大于弊";
        document.getElementById("topicInput").dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("maxTurns").value = "2";
        document.getElementById("positiveModel").value = ${JSON.stringify(modelProfiles.first.id)};
        document.getElementById("negativeModel").value = ${JSON.stringify(modelProfiles.second.id)};
        document.getElementById("judgeModel").value = ${JSON.stringify(modelProfiles.first.id)};
        document.getElementById("startButton").click();
        const finishDeadline = Date.now() + 5000;
        while (!["finished", "error", "paused"].includes(document.getElementById("debateBadge").classList[1]) && Date.now() < finishDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        aiDebate = {
          ready: document.documentElement.dataset.roomReady,
          error: document.documentElement.dataset.roomError || "",
          status: document.getElementById("debateBadge").classList[1],
          modelOptions: document.getElementById("positiveModel").options.length,
          messageRoles: [...document.querySelectorAll("#messages .message")].map((item) => item.classList[1]),
          secretInputs: document.querySelectorAll('input[type="password"], input[name*="api" i], input[name*="url" i]').length,
          historyItems: document.querySelectorAll("#historyList .historyItem").length,
          selectedModels: [
            document.getElementById("positiveModel").value,
            document.getElementById("negativeModel").value,
            document.getElementById("judgeModel").value
          ]
        };
      }
      if (${JSON.stringify(example.id)} === "ai-model-benchmark") {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        const base64 = canvas.toDataURL("image/png").split(",")[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const visionResponse = await window.room.ai.generate("视觉接口冒烟", {
          profileId: document.getElementById("benchmarkModel").value,
          images: [{ mimeType: "image/png", data: bytes }],
          maxTokens: 64,
          temperature: 0,
          structuredOutput: true
        });
        document.getElementById("manageCustomCases").click();
        const customDialogOpen = document.getElementById("customCaseDialog").open;
        document.getElementById("customTitle").value = "自定义冒烟题";
        document.getElementById("customType").value = "chat";
        document.getElementById("customLevel").value = "quick";
        document.getElementById("customMaxTokens").value = "64";
        document.getElementById("customPrompt").value = "请只输出 JSON 对象，字段 status 必须等于 ok，不要解释。";
        document.getElementById("customResponseFormat").value = "json";
        document.getElementById("customAssertions").value = JSON.stringify([{ path: "status", operator: "equals", expected: "ok", weight: 100 }]);
        document.getElementById("customCaseForm").requestSubmit();
        const customDeadline = Date.now() + 3000;
        while (!document.querySelector("#customCaseList .customListItem") && Date.now() < customDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const customRows = await window.room.db.query("SELECT format, title, enabled FROM benchmark_custom_cases");
        const customRuleScore = scoreCustomResponse('{"status":"ok"}', "json", [{ path: "status", operator: "equals", expected: "ok", weight: 100 }]);
        const customSet = benchmarkSetKey(selectedCases());
        document.getElementById("closeCustomCases").click();
        renderDetail({ title: "详情冒烟", summary: ["100 分"], cases: [{ id: "smoke", title: "冒烟问题", prompt: "原始问题", output: "原始回答", score: 100, status: "done", type: "chat" }] });
        const detailDialogOpen = document.getElementById("resultDetailDialog").open;
        const detailText = document.getElementById("resultDetailCases").textContent;
        document.getElementById("closeResultDetail").click();
        aiBenchmark = {
          ready: document.documentElement.dataset.roomReady,
          error: document.documentElement.dataset.roomError || "",
          modelOptions: document.getElementById("benchmarkModel").options.length,
          categories: document.getElementById("benchmarkCategory").options.length,
          levels: document.getElementById("benchmarkLevel").options.length,
          hasLeaderboard: Boolean(document.getElementById("leaderboardBody")),
          visionGateway: visionResponse.text === '{"vision":true}' && visionResponse.usage?.totalTokens === 11,
          customDialogOpen,
          customCaseCount: customRows.length,
          customFormat: customRows[0]?.format,
          customEnabled: customRows[0]?.enabled,
          customRuleScore,
          customSet,
          detailDialogOpen,
          detailHasQuestion: detailText.includes("原始问题"),
          detailHasAnswer: detailText.includes("原始回答"),
          secretInputs: document.querySelectorAll('input[type="password"], input[name*="api" i], input[name*="url" i]').length
        };
      }
      if (${JSON.stringify(example.id)} === "browser") {
        let browserState = await window.room.browser.getState();
        await window.room.browser.navigate(browserState.activeTabId, ${JSON.stringify(browserSmokeUrl)});
        browserState = await window.room.browser.getState();
        const activeBrowserTab = browserState.tabs.find((tab) => tab.id === browserState.activeTabId);
        const surface = document.getElementById("browserSurface").getBoundingClientRect();
        browser = {
          ready: document.documentElement.dataset.roomReady,
          error: document.documentElement.dataset.roomError || "",
          tabCount: browserState.tabs.length,
          maximumTabs: browserState.maximumTabs,
          networkAllowed: browserState.networkAllowed,
          navigatePermission: browserState.permissions.navigate,
          downloadPermission: browserState.permissions.download,
          pageUrl: activeBrowserTab?.url,
          pageTitle: activeBrowserTab?.title,
          pageLoading: activeBrowserTab?.loading,
          hasApi: Boolean(window.room.browser.createTab && window.room.browser.navigate && window.room.browser.setViewport && window.room.browser.onStateChanged && window.room.browser.onPermissionRequest),
          surfaceWidth: Math.round(surface.width),
          surfaceHeight: Math.round(surface.height),
          hasAddress: Boolean(document.getElementById("addressInput")),
          hasLibrary: Boolean(document.getElementById("libraryPanel"))
        };
      }
      return {
        title: document.title,
        hasDatabase: Boolean(window.room?.db?.query),
        hasLargeText: Boolean(window.room?.largeText?.open && window.room?.largeText?.startSearch),
        hasWebglCanvas: Boolean(document.querySelector("canvas")),
        hasPhysics: typeof window.RAPIER?.World === "function",
        fatal: document.getElementById("fatal")?.hidden === false ? document.getElementById("fatal").textContent : "",
        aiDebate,
        aiBenchmark,
        browser
      };
      })()`);
    } finally {
      aiService.complete = originalComplete;
      if (browserSmokeServer && !runtime) await cleanupBrowserSmoke();
    }
    if (example.id === "browser") {
      try {
        const browserRecord = roomBrowser.rooms.get(installed.id);
        const browserTab = browserRecord?.tabs.get(browserRecord.activeTabId);
        const guestWebContentsId = browserTab?.view?.webContents?.id;
        const detached = await roomViews.detach(installed.id, { force: true });
        const detachedRecord = roomViews.detachedWindows.get(installed.id);
        const reparentedToWindow = browserTab?.parent === detachedRecord?.window;
        const parentStateWhileDetached = !browserTab?.parent
          ? "none"
          : browserTab.parent === mainWindow
            ? "main"
            : browserTab.parent === detachedRecord?.window
              ? "detached"
              : browserTab.parent?.constructor?.name || "other";
        const expectedParentWhileDetached = roomBrowser.visibleParent(installed.id) === detachedRecord?.window;
        const guestTitleWhileDetached = browserTab?.view?.webContents?.getTitle();
        await roomViews.dock(installed.id, { reason: "browser-smoke" });
        runtime.browser.nativeView = {
          detached: detached.detached,
          reparentedToWindow,
          parentStateWhileDetached,
          expectedParentWhileDetached,
          preservedWebContents: browserTab?.view?.webContents?.id === guestWebContentsId,
          guestTitleWhileDetached,
          dockedToWorkbench: browserTab?.parent === mainWindow,
          parentStateAfterDock: !browserTab?.parent
            ? "none"
            : browserTab.parent === mainWindow
              ? "main"
              : browserTab.parent?.constructor?.name || "other",
          expectedParentAfterDock: roomBrowser.visibleParent(installed.id) === mainWindow
        };
      } finally {
        await cleanupBrowserSmoke();
      }
    }
    const table = exampleTables[example.id];
    const schema = table
      ? await database.query(installed.id, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
      : [];
    const initialized = table
      ? schema.length === 1 && (example.id !== "ai-model-benchmark" || (
          runtime.aiBenchmark?.ready === "true" &&
          runtime.aiBenchmark.modelOptions === 2 &&
          runtime.aiBenchmark.categories === 3 &&
          runtime.aiBenchmark.levels === 3 &&
          runtime.aiBenchmark.hasLeaderboard &&
          runtime.aiBenchmark.visionGateway &&
          runtime.aiBenchmark.customDialogOpen &&
          runtime.aiBenchmark.customCaseCount === 1 &&
          runtime.aiBenchmark.customFormat === "zhibian-benchmark-case@1" &&
          runtime.aiBenchmark.customEnabled === 1 &&
          runtime.aiBenchmark.customRuleScore === 100 &&
          runtime.aiBenchmark.customSet.startsWith("custom-") &&
          runtime.aiBenchmark.detailDialogOpen &&
          runtime.aiBenchmark.detailHasQuestion &&
          runtime.aiBenchmark.detailHasAnswer &&
          runtime.aiBenchmark.secretInputs === 0
        ))
      : example.id === "offline-3d-collector"
        ? runtime.hasWebglCanvas && runtime.hasPhysics && !runtime.fatal
        : example.id === "ai-debate"
          ? runtime.aiDebate?.ready === "true" &&
            runtime.aiDebate.status === "finished" &&
            runtime.aiDebate.modelOptions === 2 &&
            runtime.aiDebate.secretInputs === 0 &&
            runtime.aiDebate.historyItems === 1 &&
            runtime.aiDebate.messageRoles.join(",") === "system,positive,negative,judge" &&
            runtime.aiDebate.selectedModels.join(",") === [modelProfiles.first.id, modelProfiles.second.id, modelProfiles.first.id].join(",")
        : example.id === "browser"
          ? runtime.browser?.ready === "true" &&
            !runtime.browser.error &&
            runtime.browser.tabCount === 1 &&
            runtime.browser.maximumTabs >= 12 &&
            runtime.browser.navigatePermission &&
            runtime.browser.downloadPermission &&
            runtime.browser.pageUrl === browserSmokeUrl &&
            runtime.browser.pageTitle === "千万间浏览器本机验收页" &&
            runtime.browser.pageLoading === false &&
            runtime.browser.hasApi &&
            runtime.browser.surfaceWidth >= 100 &&
            runtime.browser.surfaceHeight >= 100 &&
            runtime.browser.hasAddress &&
            runtime.browser.hasLibrary &&
            runtime.browser.nativeView?.detached &&
            runtime.browser.nativeView.reparentedToWindow &&
            runtime.browser.nativeView.preservedWebContents &&
            runtime.browser.nativeView.guestTitleWhileDetached === "千万间浏览器本机验收页" &&
            runtime.browser.nativeView.dockedToWorkbench
        : runtime.hasLargeText;
    const senderId = exampleView.webContents.id;
    let closedCleanly = null;
    if (example.id === "offline-3d-collector") {
      roomViews.close(installed.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      closedCleanly = !roomViews.views.has(installed.id) && roomViews.getRoomIdForSender(senderId) === null;
    }
    const result = { id: example.id, ...runtime, initialized, closedCleanly };
    exampleRuntimes.push(result);
    if (runtime.title !== example.name || !runtime.hasDatabase || !initialized || (example.id === "offline-3d-collector" && !closedCleanly)) {
      throw new Error(`示例房间运行检查失败：${JSON.stringify(result)}`);
    }
  }
  const composedRoom = await createComposedRoom({
    spec: {
      specVersion: "room-spec@1",
      kind: "composed",
      name: "组合房间运行验收",
      description: "验证动态页面结构、数据交互、图表和计算器",
      theme: "blue",
      data: [{
        id: "orders",
        label: "订单",
        fields: [
          { key: "customer", label: "客户", type: "text", required: true },
          { key: "region", label: "区域", type: "select", required: true, options: ["华东", "华南"] },
          { key: "amount", label: "金额", type: "number", required: true },
          { key: "signed_on", label: "签约日", type: "date", required: true }
        ],
        seed: [{ customer: "种子客户", region: "华东", amount: 12.3, signed_on: "2026-08-30" }]
      }],
      actions: [{ id: "remove", type: "delete", label: "删除", source: "orders", tone: "danger" }],
      pages: [
        {
          id: "dashboard",
          title: "数据仪表盘",
          layout: "grid",
          columns: 2,
          components: [
            { id: "order_stats", type: "stats", title: "核心指标", source: "orders", metrics: [{ label: "订单数", aggregate: "count" }, { label: "金额合计", aggregate: "sum", field: "amount" }] },
            { id: "order_chart", type: "chart", title: "区域分布", source: "orders", chart: "bar", groupBy: "region", aggregate: "sum", valueField: "amount" },
            { id: "order_form", type: "form", title: "新增订单", source: "orders", fields: ["customer", "region", "amount", "signed_on"], submitLabel: "保存订单" },
            { id: "order_table", type: "table", title: "订单明细", source: "orders", fields: ["customer", "region", "amount", "signed_on"], search: true, actions: ["remove"], span: 2 }
          ]
        },
        {
          id: "calculator",
          title: "报价计算",
          layout: "stack",
          columns: 1,
          components: [{
            id: "quote_calculator",
            type: "calculator",
            title: "报价计算器",
            inputs: [{ key: "price", label: "单价", defaultValue: 10 }, { key: "quantity", label: "数量", defaultValue: 5 }],
            outputs: [{ label: "总价", expression: { op: "multiply", args: [{ input: "price" }, { input: "quantity" }] }, precision: 2, prefix: "¥" }]
          }]
        }
      ]
    },
    roomStore
  });
  await roomViews.open(composedRoom.id);
  const composedView = roomViews.views.get(composedRoom.id);
  const composedResult = await composedView.webContents.executeJavaScript(`(async () => {
    const readyDeadline = Date.now() + 5000;
    while (document.documentElement.dataset.roomReady !== "true" && !document.documentElement.dataset.roomError && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (document.documentElement.dataset.roomReady !== "true") throw new Error(document.documentElement.dataset.roomError || "组合房间初始化超时");
    const form = document.querySelector("[data-room-form]");
    form.elements.customer.value = "新增客户";
    form.elements.region.value = "华南";
    form.elements.amount.value = "25";
    form.elements.signed_on.value = "2026-08-31";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const rowDeadline = Date.now() + 3000;
    while (document.querySelectorAll("#order_table tbody tr").length < 2 && Date.now() < rowDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    document.querySelector('[data-page-target="calculator"]').click();
    const price = document.querySelector('[data-calc-input="price"]');
    price.value = "20";
    price.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      title: document.title,
      ready: document.documentElement.dataset.roomReady,
      pageCount: document.querySelectorAll("[data-page]").length,
      componentTypes: [...document.querySelectorAll("[data-component]")].map((element) => element.dataset.component),
      rows: document.querySelectorAll("#order_table tbody tr").length,
      total: document.querySelector("#order_stats .metric:nth-child(2) strong")?.textContent,
      calculator: document.querySelector('[data-calc-output="0"]')?.textContent,
      chart: typeof window.Chart,
      calculatorVisible: !document.querySelector('[data-page="calculator"]').hidden
    };
  })()`);
  if (
    composedResult.title !== "组合房间运行验收" ||
    composedResult.ready !== "true" ||
    composedResult.pageCount !== 2 ||
    !composedResult.componentTypes.includes("chart") ||
    !composedResult.componentTypes.includes("calculator") ||
    composedResult.rows !== 2 ||
    composedResult.total !== "37.30" ||
    composedResult.calculator !== "¥100.00" ||
    composedResult.chart !== "function" ||
    !composedResult.calculatorVisible
  ) {
    throw new Error(`组合房间运行检查失败：${JSON.stringify(composedResult)}`);
  }
  const customBuild = await createCustomRoom({
    spec: {
      formatVersion: "room-app@1",
      kind: "custom",
      name: "自由房间运行验收",
      description: "验证受控自由代码、内置 Three.js、交互和安全关闭",
      theme: "dark",
      hostModules: ["graphics.three@1", "physics.rapier@1"],
      capabilities: { database: false, files: [], ai: false, network: ["https://api.example.com"] },
      files: {
        html: `<main><h1>自由房间运行验收</h1><div><button id="restart" type="button">重新开始</button><button id="network" type="button">受控联网</button></div><div id="stage"></div><output id="status">尚未交互</output></main>`,
        css: `body{margin:0;background:#08130f;color:#fff}main{min-height:100dvh;display:grid;grid-template-rows:auto auto 1fr auto;gap:8px}#stage{min-height:50vh}canvas{display:block;width:100%;height:100%}@media(max-width:600px){main{padding:8px}}`,
        javascript: `const stage=document.getElementById("stage");const status=document.getElementById("status");const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(45,1,.1,50);camera.position.z=4;const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(320,240);stage.appendChild(renderer.domElement);const world=new RAPIER.World({x:0,y:-9.81,z:0});globalThis.__zhibianRapierReady=typeof world.step==="function";const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,1,0));world.createCollider(RAPIER.ColliderDesc.ball(.5),body);const ball=new THREE.Mesh(new THREE.SphereGeometry(.5),new THREE.MeshBasicMaterial({color:0x33dd88}));scene.add(ball);document.getElementById("restart").addEventListener("click",()=>{body.setTranslation({x:0,y:1,z:0},true);status.textContent="已重新开始"});document.getElementById("network").addEventListener("click",async()=>{try{const response=await window.room.network.request({url:"https://api.example.com/smoke",timeoutMs:5000});status.textContent=JSON.parse(response.text).message}catch(error){status.textContent=error.message}});function frame(){world.step();const position=body.translation();ball.position.set(position.x,position.y,position.z);renderer.render(scene,camera);requestAnimationFrame(frame)}frame();globalThis.addEventListener("beforeunload",()=>world.free(),{once:true});`
      }
    },
    roomStore
  });
  const customBootstrapPath = path.join(roomStore.getProgramRoot(customBuild.room.id), "app", "bootstrap.mjs");
  const modernCustomBootstrap = await fsp.readFile(customBootstrapPath, "utf8");
  const legacyCustomBootstrap = modernCustomBootstrap.replace(
    /\s*\/\* zhibian-runtime:rapier-ready@1 \*\/\s*if \(typeof globalThis\.RAPIER\?\.init !== "function"\) throw new Error\("内置 Rapier 物理模块未正确加载"\);\s*await globalThis\.RAPIER\.init\(\);/,
    ""
  );
  if (legacyCustomBootstrap === modernCustomBootstrap) throw new Error("无法构造旧版 Rapier bootstrap 验收场景");
  await fsp.writeFile(customBootstrapPath, legacyCustomBootstrap, "utf8");
  await roomViews.open(customBuild.room.id);
  const customView = roomViews.views.get(customBuild.room.id);
  const customResult = await customView.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 5000;
    while (document.documentElement.dataset.roomReady !== "true" && !document.documentElement.dataset.roomError && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    document.getElementById("restart").click();
    return {
      title: document.title,
      ready: document.documentElement.dataset.roomReady,
      error: document.documentElement.dataset.roomError || "",
      three: typeof window.THREE,
      rapierReady: window.__zhibianRapierReady === true,
      legacyBootstrapUpgraded: true,
      canvas: document.querySelectorAll("canvas").length,
      status: document.getElementById("status").textContent
    };
  })()`);
  const customWebContentsId = customView.webContents.id;
  await customView.webContents.executeJavaScript(`window.__zhibianNetworkEvents=[];window.__removeZhibianNetworkListener=window.room.network.onStatusChanged((status)=>window.__zhibianNetworkEvents.push(status));true;`);
  const disabledNetworkStatus = await customView.webContents.executeJavaScript(`window.room.network.getStatus()`);
  const disabledNetworkRequest = await customView.webContents.executeJavaScript(`window.room.network.request({url:"https://api.example.com/smoke"}).then(()=>"unexpected").catch((error)=>error.message)`);
  networkService.fetchImpl = async (url, options) => new Response(JSON.stringify({
    message: "受控联网成功",
    url: url.toString(),
    method: options.method
  }), { status: 200, headers: { "content-type": "application/json" } });
  const networkUiResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    await showNetworkDialog();
    const aiIndependent = document.querySelector("#networkDialog .modalIntro").textContent.includes("不受房间联网开关影响");
    document.getElementById("roomNetworkEnabled").checked = true;
    document.getElementById("networkForm").requestSubmit();
    const deadline = Date.now() + 3000;
    while (document.getElementById("networkDialog").open && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      dialogClosed: !document.getElementById("networkDialog").open,
      enabled: state.networkPolicy?.roomNetworkEnabled === true,
      summary: document.getElementById("networkSummaryInline").textContent,
      dotOnline: document.getElementById("networkDot").classList.contains("online"),
      aiIndependent
    };
  })()`);
  const enabledNetworkStatus = await customView.webContents.executeJavaScript(`window.room.network.getStatus()`);
  await customView.webContents.executeJavaScript(`document.getElementById("network").click()`);
  const networkDeadline = Date.now() + 3000;
  let controlledNetworkText = "";
  while (Date.now() < networkDeadline) {
    controlledNetworkText = await customView.webContents.executeJavaScript(`document.getElementById("status").textContent`);
    if (controlledNetworkText === "受控联网成功") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const unauthorizedNetworkRequest = await customView.webContents.executeJavaScript(`window.room.network.request({url:"https://other.example/private"}).then(()=>"unexpected").catch((error)=>error.message)`);
  await mainWindow.webContents.executeJavaScript(`(async()=>{state.networkPolicy=await window.workbench.setRoomNetworkEnabled(false);renderNetworkPolicy();})()`);
  const disabledAgainRequest = await customView.webContents.executeJavaScript(`window.room.network.request({url:"https://api.example.com/smoke"}).then(()=>"unexpected").catch((error)=>error.message)`);
  const networkEvents = await customView.webContents.executeJavaScript(`window.__zhibianNetworkEvents`);
  const networkResult = {
    ui: networkUiResult,
    disabledNetworkStatus,
    disabledNetworkRequest,
    enabledNetworkStatus,
    controlledNetworkText,
    unauthorizedNetworkRequest,
    disabledAgainRequest,
    events: networkEvents
  };
  if (
    disabledNetworkStatus.workbenchAllowed ||
    disabledNetworkStatus.available ||
    !disabledNetworkStatus.roomAllowed ||
    !disabledNetworkRequest.includes("主工作台尚未允许") ||
    !networkUiResult.dialogClosed ||
    !networkUiResult.enabled ||
    !networkUiResult.dotOnline ||
    !networkUiResult.aiIndependent ||
    networkUiResult.summary !== "已授权房间可联网" ||
    !enabledNetworkStatus.available ||
    enabledNetworkStatus.origins[0] !== "https://api.example.com" ||
    controlledNetworkText !== "受控联网成功" ||
    !unauthorizedNetworkRequest.includes("没有访问 https://other.example 的权限") ||
    !disabledAgainRequest.includes("主工作台尚未允许") ||
    !networkEvents.some((event) => event.workbenchAllowed === true) ||
    !networkEvents.some((event) => event.workbenchAllowed === false)
  ) {
    throw new Error(`房间受控联网检查失败：${JSON.stringify(networkResult)}`);
  }
  await customView.webContents.executeJavaScript(`document.getElementById("restart").click()`);
  await customView.webContents.executeJavaScript(`window.__zhibianDetachSmoke = { score: 17, status: document.getElementById("status").textContent }`);
  const backgroundRoomId = roomStore.listRooms().find(room => room.id !== customBuild.room.id)?.id;
  const detachResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    ${backgroundRoomId ? `await openRoom(${JSON.stringify(backgroundRoomId)});` : ""}
    await openRoom(${JSON.stringify(customBuild.room.id)});
    return detachRoom(${JSON.stringify(customBuild.room.id)});
  })()`);
  const detachedRecord = roomViews.detachedWindows.get(customBuild.room.id);
  await new Promise(resolve => setTimeout(resolve, 100));
  customResult.detachedFocused = detachedRecord?.window.isFocused() === true;
  if (process.platform === "win32" && !customResult.detachedFocused) throw new Error("主窗口切换备用标签后抢回了独立房间的焦点");
  customResult.detached = detachResult.mode === "detached" && Boolean(detachedRecord);
  customResult.detachedState = await detachedRecord.view.webContents.executeJavaScript(`window.__zhibianDetachSmoke`);
  detachedRecord.window.close();
  const dockDeadline = Date.now() + 3000;
  while (roomViews.detachedWindows.has(customBuild.room.id) && Date.now() < dockDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const dockedView = roomViews.views.get(customBuild.room.id);
  customResult.dockedOnWindowClose = !roomViews.detachedWindows.has(customBuild.room.id) && roomViews.activeRoomId === customBuild.room.id;
  customResult.webContentsPreserved = dockedView?.webContents?.id === customWebContentsId;
  customResult.dockedState = await dockedView.webContents.executeJavaScript(`window.__zhibianDetachSmoke`);
  roomViews.close(customBuild.room.id);
  customResult.closed = !roomViews.views.has(customBuild.room.id);
  customResult.iconUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    state.rooms = (await window.workbench.getState()).rooms;
    if (!state.tabs.includes(${JSON.stringify(customBuild.room.id)})) state.tabs.push(${JSON.stringify(customBuild.room.id)});
    renderRooms();
    renderTabs();
    const deadline = Date.now() + 3000;
    let images = [];
    while (Date.now() < deadline) {
      images = [
        document.querySelector('[data-room-id="${customBuild.room.id}"] .installedRoomIcon img'),
        [...document.querySelectorAll('#roomList .roomItem')].find((item) => item.title === "自由房间运行验收")?.querySelector('.roomIcon img'),
        document.querySelector('#tabs [data-room-id="${customBuild.room.id}"] .tabRoomIcon img')
      ];
      if (images.every((image) => image?.complete && image.naturalWidth > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      manifestIcon: state.rooms.find((room) => room.id === ${JSON.stringify(customBuild.room.id)})?.icon,
      count: images.filter(Boolean).length,
      loaded: images.every((image) => image?.complete && image.naturalWidth > 0),
      sources: images.map((image) => image?.getAttribute('src') || '')
    };
  })()`);
  if (
    customResult.title !== "自由房间运行验收" ||
    customResult.ready !== "true" ||
    customResult.error ||
    customResult.three !== "object" ||
    !customResult.rapierReady ||
    !customResult.legacyBootstrapUpgraded ||
    customResult.canvas !== 1 ||
    customResult.status !== "已重新开始" ||
    !customResult.detached ||
    customResult.detachedState?.score !== 17 ||
    !customResult.dockedOnWindowClose ||
    !customResult.webContentsPreserved ||
    customResult.dockedState?.status !== "已重新开始" ||
    !customResult.closed ||
    customResult.iconUi?.manifestIcon !== "assets/icon.svg" ||
    customResult.iconUi?.count !== 3 ||
    !customResult.iconUi?.loaded ||
    customResult.iconUi.sources.some((source) => !source.startsWith(`room://${customBuild.room.id}/assets/icon.svg`))
  ) {
    throw new Error(`自由房间运行检查失败：${JSON.stringify(customResult)}`);
  }
  const moduleRoom = await createGeneratedRoom({
    definition: {
      name: "离线模块验收",
      description: "验证所有官方模块在断网环境可加载",
      fields: [
        { key: "day", label: "日期", type: "date", required: true },
        { key: "amount", label: "金额", type: "number", required: true },
        { key: "notes", label: "说明", type: "textarea", required: false }
      ],
      hostModules: ROOM_MODULE_CATALOG.map((module) => module.id)
    },
    roomStore
  });
  await roomViews.open(moduleRoom.id);
  const moduleView = roomViews.views.get(moduleRoom.id);
  const moduleResult = await moduleView.webContents.executeJavaScript(`(async () => {
    const readyDeadline = Date.now() + 8000;
    while (document.documentElement.dataset.roomReady !== "true" && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (document.documentElement.dataset.roomReady !== "true") throw new Error("生成房间初始化超时");
    document.querySelector('[name="day"]').value = "2026-08-30";
    document.querySelector('[name="amount"]').value = "12.30";
    document.querySelector('[name="notes"]').value = "**安全备注** <span onclick=alert(1)>内容</span>";
    document.getElementById("recordForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const deadline = Date.now() + 3000;
    while (!document.querySelector(".record") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const pdfjs = await import("/_modules/document.pdf.view@1/pdf.min.mjs");
    const cmapResponse = await fetch("/_modules/document.pdf.view@1/cmaps/78-EUC-H.bcmap");
    const fontResponse = await fetch("/_modules/font.cjk@1/NotoSansCJKsc-Regular.otf");
    const fontBytes = await fontResponse.arrayBuffer();

    const xlsxBook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(
      xlsxBook,
      window.XLSX.utils.aoa_to_sheet([["名称", "金额"], ["智变", 12.3]]),
      "数据"
    );
    const xlsxBytes = window.XLSX.write(xlsxBook, { bookType: "xlsx", type: "array" });

    const richBook = new window.ExcelJS.Workbook();
    const richSheet = richBook.addWorksheet("报表");
    richSheet.addRow(["名称", "金额"]);
    richSheet.addRow(["智变", 12.3]);
    richSheet.getRow(1).font = { bold: true };
    const richXlsxBytes = await richBook.xlsx.writeBuffer();

    const pdfDocument = await window.PDFLib.PDFDocument.create();
    pdfDocument.registerFontkit(window.fontkit);
    const chineseFont = await pdfDocument.embedFont(fontBytes, { subset: true });
    const pdfPage = pdfDocument.addPage([320, 200]);
    pdfPage.drawText("千万间 Roomillion", { x: 30, y: 120, size: 18, font: chineseFont });
    const composedPdfBytes = await pdfDocument.save();

    const report = new window.jspdf.jsPDF();
    report.autoTable({ head: [["Name", "Amount"]], body: [["Zhibian", "12.3"]] });
    const reportPdfBytes = report.output("arraybuffer");

    const wordDocument = new window.docx.Document({
      sections: [{ children: [new window.docx.Paragraph("千万间 Roomillion")] }]
    });
    const wordBlob = await window.docx.Packer.toBlob(wordDocument);
    const wordHtml = await window.mammoth.convertToHtml({ arrayBuffer: await wordBlob.arrayBuffer() });

    const pptx = new window.PptxGenJS();
    pptx.addSlide().addText("千万间 Roomillion", { x: 1, y: 1, w: 5, h: 1 });
    const pptxBytes = await pptx.write({ outputType: "arraybuffer" });
    const qrDataUrl = await window.QRCode.toDataURL("千万间 Roomillion");
    const zipBytes = await new window.JSZip().file("hello.txt", "智变").generateAsync({ type: "uint8array" });

    const advancedHost = document.createElement("section");
    advancedHost.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:480px";
    document.body.appendChild(advancedHost);
    const mount = (width = 240, height = 140) => {
      const node = document.createElement("div");
      node.style.cssText = "width:" + width + "px;height:" + height + "px";
      advancedHost.appendChild(node);
      return node;
    };

    const grid = new window.Tabulator(mount(), {
      data: [{ id: 1, name: "智变" }],
      columns: [{ title: "名称", field: "name" }]
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const gridRows = grid.getDataCount();

    const sortableList = mount();
    for (const id of ["a", "b"]) { const item = document.createElement("div"); item.dataset.id = id; item.textContent = id; sortableList.appendChild(item); }
    const sortable = window.Sortable.create(sortableList);
    const sortableItems = sortable.toArray().join("");

    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    const mermaidResult = await window.mermaid.render("zhibianSmokeDiagram", "flowchart LR\\nA-->B");

    const chartHost = mount();
    const advancedChart = window.echarts.init(chartHost);
    advancedChart.setOption({ xAxis: { type: "category", data: ["A"] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [3] }] });
    const chartWidth = advancedChart.getWidth();

    const editorHost = mount();
    const editor = new window.Quill(editorHost, { theme: "snow" });
    editor.setText("智变富文本");

    const mapHost = mount();
    const map = window.L.map(mapHost, { attributionControl: false, zoomControl: false }).setView([30, 120], 5);
    window.L.circleMarker([30, 120]).addTo(map);
    const mapCenter = map.getCenter();

    const cropImage = document.createElement("img");
    cropImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    advancedHost.appendChild(cropImage);
    const cropper = new window.Cropper(cropImage);

    const canvasHost = mount();
    const stage = new window.Konva.Stage({ container: canvasHost, width: 120, height: 80 });
    const layer = new window.Konva.Layer();
    layer.add(new window.Konva.Rect({ x: 2, y: 2, width: 20, height: 10, fill: "red" }));
    stage.add(layer); layer.draw();

    const d3Host = mount();
    window.d3.select(d3Host).append("svg").append("circle").attr("r", 4);
    const graph = window.cytoscape({ headless: true, elements: [{ data: { id: "n1" } }, { data: { id: "n2" } }, { data: { source: "n1", target: "n2" } }] });

    const advanced = {
      gridRows,
      sortableItems,
      mermaidSvg: typeof mermaidResult.svg === "string" && mermaidResult.svg.includes("<svg"),
      chartWidth,
      editorText: editor.getText().trim(),
      mapCenter: [mapCenter.lat, mapCenter.lng],
      math: window.math.add(2, 3),
      mean: window.ss.mean([1, 2, 3]),
      cropper: cropper instanceof window.Cropper,
      canvasShapes: stage.find("Rect").length,
      d3Circles: d3Host.querySelectorAll("circle").length,
      graphNodes: graph.nodes().length,
      styles: ["tabulator.min.css", "quill.snow.css", "leaflet.css"].every((name) => [...document.styleSheets].some((sheet) => sheet.href?.includes(name)))
    };
    grid.destroy(); sortable.destroy(); advancedChart.dispose(); map.remove(); stage.destroy(); graph.destroy(); advancedHost.remove();
    return {
      hostModules: (await window.room.getInfo()).hostModules,
      globals: {
        dayjs: typeof window.dayjs,
        Decimal: typeof window.Decimal,
        Papa: typeof window.Papa,
        Chart: typeof window.Chart,
        marked: typeof window.marked,
        DOMPurify: typeof window.DOMPurify,
        JSZip: typeof window.JSZip,
        fontkit: typeof window.fontkit,
        PDFLib: typeof window.PDFLib,
        jspdf: typeof window.jspdf,
        autoTable: typeof window.autoTable,
        XLSX: typeof window.XLSX,
        ExcelJS: typeof window.ExcelJS,
        docx: typeof window.docx,
        mammoth: typeof window.mammoth,
        docxPreview: typeof window.docxPreview,
        PptxGenJS: typeof window.PptxGenJS,
        htmlToImage: typeof window.htmlToImage,
        QRCode: typeof window.QRCode
        ,Tabulator: typeof window.Tabulator
        ,Sortable: typeof window.Sortable
        ,mermaid: typeof window.mermaid
        ,echarts: typeof window.echarts
        ,Quill: typeof window.Quill
        ,Leaflet: typeof window.L
        ,math: typeof window.math
        ,simpleStatistics: typeof window.ss
        ,Cropper: typeof window.Cropper
        ,Konva: typeof window.Konva
        ,d3: typeof window.d3
        ,cytoscape: typeof window.cytoscape
        ,THREE: typeof window.THREE?.WebGLRenderer
        ,RAPIER: typeof window.RAPIER?.World
        ,ZhibianInput: typeof window.ZhibianInput?.create
        ,ZhibianAudio: typeof window.ZhibianAudio?.create
        ,ZhibianGameAssets: typeof window.ZhibianGameAssets?.player
      },
      office: {
        pdfjs: typeof pdfjs.getDocument,
        cmap: cmapResponse.ok,
        fontBytes: fontBytes.byteLength,
        xlsxBytes: xlsxBytes.byteLength,
        richXlsxBytes: richXlsxBytes.byteLength,
        composedPdfBytes: composedPdfBytes.byteLength,
        reportPdfBytes: reportPdfBytes.byteLength,
        wordBytes: wordBlob.size,
        wordHtml: wordHtml.value,
        wordPreview: typeof window.docxPreview.renderAsync,
        pptxBytes: pptxBytes.byteLength,
        qr: qrDataUrl.startsWith("data:image/png;base64,"),
        zipBytes: zipBytes.byteLength,
        htmlImage: typeof window.htmlToImage.toPng,
        roomBinaryPick: typeof window.room.files.pickBinary,
        roomBinaryExport: typeof window.room.files.exportBinary
      },
      advanced,
      searchVisible: !document.getElementById("searchLabel").hidden,
      insightsVisible: !document.getElementById("insightsCard").hidden,
      total: document.querySelector(".total strong")?.textContent,
      sanitizedHtml: document.querySelector("dd.richText")?.innerHTML ?? ""
    };
  })()`);
  if (
    moduleResult.hostModules.length !== ROOM_MODULE_CATALOG.length ||
    Object.values(moduleResult.globals).some((type) => type === "undefined") ||
    moduleResult.office.pdfjs !== "function" ||
    !moduleResult.office.cmap ||
    moduleResult.office.fontBytes < 16_000_000 ||
    moduleResult.office.xlsxBytes < 1_000 ||
    moduleResult.office.richXlsxBytes < 1_000 ||
    moduleResult.office.composedPdfBytes < 1_000 ||
    moduleResult.office.reportPdfBytes < 1_000 ||
    moduleResult.office.wordBytes < 1_000 ||
    !moduleResult.office.wordHtml.includes("千万间 Roomillion") ||
    moduleResult.office.wordPreview !== "function" ||
    moduleResult.office.pptxBytes < 1_000 ||
    !moduleResult.office.qr ||
    moduleResult.office.zipBytes < 100 ||
    moduleResult.office.htmlImage !== "function" ||
    moduleResult.office.roomBinaryPick !== "function" ||
    moduleResult.office.roomBinaryExport !== "function" ||
    moduleResult.advanced.gridRows !== 1 ||
    moduleResult.advanced.sortableItems !== "ab" ||
    !moduleResult.advanced.mermaidSvg ||
    moduleResult.advanced.chartWidth < 100 ||
    moduleResult.advanced.editorText !== "智变富文本" ||
    Math.abs(moduleResult.advanced.mapCenter[0] - 30) > 0.01 ||
    Math.abs(moduleResult.advanced.mapCenter[1] - 120) > 0.01 ||
    moduleResult.advanced.math !== 5 ||
    moduleResult.advanced.mean !== 2 ||
    !moduleResult.advanced.cropper ||
    moduleResult.advanced.canvasShapes !== 1 ||
    moduleResult.advanced.d3Circles !== 1 ||
    moduleResult.advanced.graphNodes !== 2 ||
    !moduleResult.advanced.styles ||
    !moduleResult.searchVisible ||
    !moduleResult.insightsVisible ||
    moduleResult.total !== "12.3" ||
    !moduleResult.sanitizedHtml.includes("<strong>安全备注</strong>") ||
    moduleResult.sanitizedHtml.includes("onclick")
  ) {
    throw new Error(`官方离线模块运行检查失败：${JSON.stringify(moduleResult)}`);
  }
  await mainWindow.webContents.executeJavaScript(`openRoom(${JSON.stringify(workbenchResult.room.id)})`);
  const exportUiResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    await showExportDialog();
    const result = {
      dialogOpen: document.getElementById("exportDialog").open,
      modeCount: document.querySelectorAll('#exportForm input[name="mode"]').length,
      defaultMode: document.querySelector('#exportForm input[name="mode"]:checked')?.value,
      protectInitiallyOff: !document.querySelector('#exportForm input[name="protect"]').checked,
      passwordInitiallyHidden: document.getElementById("exportPasswordFields").hidden,
      appOnlyCopy: document.querySelector('#exportForm input[value="app-only"]')?.closest("label")?.textContent
    };
    const withData = document.querySelector('#exportForm input[value="app-and-data"]');
    withData.checked = true;
    withData.dispatchEvent(new Event("change", { bubbles: true }));
    const dataWithoutPasswordHidden = document.getElementById("exportPasswordFields").hidden;
    const protect = document.querySelector('#exportForm input[name="protect"]');
    protect.checked = true;
    protect.dispatchEvent(new Event("change", { bubbles: true }));
    Object.assign(result, {
      dataMode: document.querySelector('#exportForm input[name="mode"]:checked')?.value,
      dataWithoutPasswordHidden,
      passwordVisible: !document.getElementById("exportPasswordFields").hidden,
      passwordRequired: document.querySelector('#exportPasswordFields input[name="password"]').required,
      dataCopy: withData.closest("label")?.textContent,
      protectionCopy: protect.closest("label")?.textContent,
      submitCopy: document.getElementById("submitExportButton").textContent
    });
    document.getElementById("exportDialog").close();
    return result;
  })()`);
  if (
    !exportUiResult.dialogOpen ||
    exportUiResult.modeCount !== 2 ||
    exportUiResult.defaultMode !== "app-only" ||
    !exportUiResult.protectInitiallyOff ||
    !exportUiResult.passwordInitiallyHidden ||
    !exportUiResult.appOnlyCopy.includes("只导出应用") ||
    exportUiResult.dataMode !== "app-and-data" ||
    !exportUiResult.dataWithoutPasswordHidden ||
    !exportUiResult.passwordVisible ||
    !exportUiResult.passwordRequired ||
    !exportUiResult.dataCopy.includes("应用和数据一起导出") ||
    !exportUiResult.dataCopy.includes(".room") ||
    !exportUiResult.protectionCopy.includes("设置导出密码") ||
    !exportUiResult.submitCopy.includes(".room")
  ) {
    throw new Error(`双模式房间导出界面检查失败：${JSON.stringify(exportUiResult)}`);
  }
  const backupPath = path.join(dataRoot, "smoke-backup.zdata");
  await database.storageSet(workbenchResult.room.id, "smoke-backup", { value: "before" });
  const backupCreated = await dataBackups.createBackup(workbenchResult.room.id, "smoke-password", backupPath);
  await database.storageSet(workbenchResult.room.id, "smoke-backup", { value: "after" });
  const restoreInspection = await dataBackups.inspectBackup(backupPath, workbenchResult.room.id);
  let wrongPasswordRejected = false;
  try {
    await dataBackups.restoreBackup(restoreInspection.token, "wrong-password");
  } catch (error) {
    wrongPasswordRejected = /密码错误|已损坏/.test(error.message);
  }
  const valueAfterWrongPassword = await database.storageGet(workbenchResult.room.id, "smoke-backup");
  const restoredBackup = await dataBackups.restoreBackup(restoreInspection.token, "smoke-password");
  const valueAfterRestore = await database.storageGet(workbenchResult.room.id, "smoke-backup");
  if (
    !wrongPasswordRejected ||
    valueAfterWrongPassword?.value !== "after" ||
    valueAfterRestore?.value !== "before" ||
    !restoredBackup.backupCreated
  ) {
    throw new Error(`数据备份恢复检查失败：${JSON.stringify({ wrongPasswordRejected, valueAfterWrongPassword, valueAfterRestore, restoredBackup })}`);
  }
  const plainTransferPath = path.join(dataRoot, "smoke-room-with-data.room");
  const plainTransferCreated = await dataBackups.createRoomTransfer(workbenchResult.room.id, {
    includeData: true,
    password: ""
  }, plainTransferPath);
  const plainTransferInspection = await dataBackups.inspectRoomTransfer(plainTransferPath, { source: "external" });
  const plainTransferCanceled = await roomStore.cancelImport(plainTransferInspection.token)
    && await dataBackups.cancelRoomBundle(plainTransferInspection.token);

  const protectedTransferPath = path.join(dataRoot, "smoke-room-app-protected.room");
  const protectedTransferCreated = await dataBackups.createRoomTransfer(workbenchResult.room.id, {
    includeData: false,
    password: "smoke-password"
  }, protectedTransferPath);
  const lockedTransferInspection = await dataBackups.inspectRoomTransfer(protectedTransferPath, { source: "external" });
  let transferWrongPasswordRejected = false;
  try {
    await dataBackups.unlockRoomTransfer(lockedTransferInspection.token, "wrong-password");
  } catch (error) {
    transferWrongPasswordRejected = /密码错误|已损坏/.test(error.message);
  }
  const unlockUiResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    presentLockedImport(${JSON.stringify(lockedTransferInspection)});
    const result = {
      lockedDialogOpen: document.getElementById("unlockImportDialog").open,
      summary: document.getElementById("unlockImportSummary").textContent
    };
    document.querySelector('#unlockImportForm input[name="password"]').value = "smoke-password";
    await unlockRoomImport(new Event("submit"));
    Object.assign(result, {
      lockedDialogClosed: !document.getElementById("unlockImportDialog").open,
      inspectionDialogOpen: document.getElementById("importDialog").open,
      protectedDetail: [...document.querySelectorAll('#importPackageDetails dt')]
        .some((item) => item.textContent === "密码保护" && item.nextElementSibling?.textContent.includes("已启用"))
    });
    await cancelPendingImport();
    return result;
  })()`);
  const roomTransferEvidence = {
    extension: path.extname(plainTransferCreated.path),
    plainMode: plainTransferCreated.mode,
    plainProtected: plainTransferCreated.protected,
    plainDataEncrypted: plainTransferInspection.transfer?.data?.encrypted,
    plainCanceled: plainTransferCanceled,
    protectedMode: protectedTransferCreated.mode,
    protectedProtected: protectedTransferCreated.protected,
    locked: lockedTransferInspection.locked,
    wrongPasswordRejected: transferWrongPasswordRejected,
    unlockUi: unlockUiResult,
    pendingImports: roomStore.pendingImports.size,
    pendingTransfers: dataBackups.pendingRoomBundles.size,
    pendingLocked: dataBackups.pendingEncryptedTransfers.size
  };
  if (
    roomTransferEvidence.extension !== ".room" ||
    roomTransferEvidence.plainMode !== "app-and-data" ||
    roomTransferEvidence.plainProtected ||
    roomTransferEvidence.plainDataEncrypted ||
    !roomTransferEvidence.plainCanceled ||
    roomTransferEvidence.protectedMode !== "app-only" ||
    !roomTransferEvidence.protectedProtected ||
    !roomTransferEvidence.locked ||
    !roomTransferEvidence.wrongPasswordRejected ||
    !unlockUiResult.lockedDialogOpen ||
    !unlockUiResult.lockedDialogClosed ||
    !unlockUiResult.inspectionDialogOpen ||
    !unlockUiResult.protectedDetail ||
    roomTransferEvidence.pendingImports !== 0 ||
    roomTransferEvidence.pendingTransfers !== 0 ||
    roomTransferEvidence.pendingLocked !== 0
  ) {
    throw new Error(`统一房间传输检查失败：${JSON.stringify(roomTransferEvidence)}`);
  }
  const historyResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    await showDetailsDialog();
    const result = {
      dialogOpen: document.getElementById("detailsDialog").open,
      settingsButton: document.getElementById("detailsButton").textContent,
      eyebrow: document.querySelector("#detailsDialog .eyebrow").textContent,
      permissionHeading: document.querySelector("#detailsPermissionSummary").previousElementSibling.querySelector("h3").textContent,
      requestedKeys: [...document.querySelectorAll("#detailsPermissions input[data-permission-key]")].map((input) => input.dataset.permissionKey),
      grantStates: [...document.querySelectorAll("#detailsPermissions .permissionGrantState")].map((item) => item.textContent),
      overviewValues: [...document.querySelectorAll("#detailsPermissionSummary .permissionOverviewItem strong")].map((item) => Number(item.textContent)),
      checkpoints: document.querySelectorAll("#detailsHistory .historyItem").length,
      gitVersion: document.getElementById("historyGitVersion").textContent
    };
    document.getElementById("detailsDialog").close();
    return result;
  })()`);
  if (
    !historyResult.dialogOpen ||
    historyResult.settingsButton !== "房间设置" ||
    historyResult.eyebrow !== "房间设置" ||
    historyResult.permissionHeading !== "房间申请的权限" ||
    !["database.private", "files.pick", "files.export", "ai.general"].every((key) => historyResult.requestedKeys.includes(key)) ||
    !historyResult.grantStates.includes("必需并已授权") ||
    historyResult.overviewValues[0] !== historyResult.requestedKeys.length ||
    historyResult.checkpoints < 1 ||
    historyResult.gitVersion !== gitService.version
  ) {
    throw new Error(`房间设置与版本历史界面检查失败：${JSON.stringify(historyResult)}`);
  }
  const diagnosticsResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    await showDiagnosticsDialog();
    const result = {
      dialogOpen: document.getElementById("diagnosticsDialog").open,
      includedFields: document.querySelectorAll("#diagnosticsIncluded li").length,
      excludedFields: document.querySelectorAll("#diagnosticsExcluded li").length,
      summary: document.getElementById("diagnosticsSummary").textContent
    };
    document.getElementById("diagnosticsDialog").close();
    return result;
  })()`);
  if (
    !diagnosticsResult.dialogOpen ||
    diagnosticsResult.includedFields < 3 ||
    diagnosticsResult.excludedFields < 3 ||
    !diagnosticsResult.summary.includes("房间摘要")
  ) {
    throw new Error(`诊断预览界面检查失败：${JSON.stringify(diagnosticsResult)}`);
  }
  await roomStore.setRoomPermissions(workbenchResult.room.id, ["database.private"]);
  const revokedResult = await view.webContents.executeJavaScript(`Promise.all([
    window.room.files.exportText("denied.txt", "denied").then(() => "unexpected").catch((error) => error.message),
    window.room.ai.generate("denied").then(() => "unexpected").catch((error) => error.message),
    window.room.db.query("SELECT 1 AS value").then((rows) => rows[0].value)
  ])`);
  if (
    !revokedResult[0].includes("没有导出文件权限") ||
    !revokedResult[1].includes("没有 AI 权限") ||
    revokedResult[2] !== 1
  ) {
    throw new Error(`权限撤销运行时检查失败：${JSON.stringify(revokedResult)}`);
  }
  if (offlineAuditMode && offlineNetworkAttempts !== 0) {
    throw new Error(`离线审计发现 ${offlineNetworkAttempts} 次出站网络请求`);
  }
  const offlineAudit = { enabled: offlineAuditMode, networkAttempts: offlineNetworkAttempts };
  const evidence = {
    workbench: workbenchResult,
    providerUi: providerUiResult,
    agentUi: agentUiResult,
    examples: examplesResult,
    exampleRuntimes,
    composedRoom: composedResult,
    customRoom: customResult,
    network: networkResult,
    roomModules: moduleResult,
    room: roomResult,
    inspection: inspectionResult,
    embeddedDependencyInspection: embeddedInspectionResult,
    exportUi: exportUiResult,
    roomTransfer: roomTransferEvidence,
    backup: { created: backupCreated, wrongPasswordRejected, valueAfterRestore },
    history: historyResult,
    diagnostics: diagnosticsResult,
    revoked: revokedResult
  };
  await writeSmokeReport({ result: "PASS", offlineAudit, evidence });
  console.log(`WORKBENCH_SMOKE_OK ${JSON.stringify({ ...evidence, offlineAudit })}`);
  terminateSmoke(0);
}

async function bootstrap() {
  if (offlineAuditMode) {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, callback) => {
        offlineNetworkAttempts += 1;
        callback({ cancel: true });
      }
    );
  }
  storageLocation = new RoomStorageLocation({
    profileRoot: app.getPath("userData"),
    executablePath: app.getPath("exe"),
    packaged: app.isPackaged,
    portableFolder: app.isPackaged && fs.existsSync(path.join(process.resourcesPath, "portable-folder.marker")),
    portableExecutableDir: app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR || null : null,
    pickDirectory: async (defaultPath) => {
      const result = await dialog.showOpenDialog({
        title: "首次使用：选择房间安装目录（将在其中创建 Roomillion-data）",
        defaultPath,
        properties: ["openDirectory", "createDirectory"]
      });
      return result.canceled ? null : result.filePaths?.[0] || null;
    }
  });
  const dataRoot = smokeMode
    ? path.join(app.getPath("temp"), "roomillion-smoke")
    : await storageLocation.resolveStartup();
  if (!dataRoot) { app.quit(); return; }
  if (storageLocation.warning) dialog.showMessageBoxSync({ type: "warning", title: "房间位置", message: storageLocation.warning });
  if (smokeMode) await fsp.rm(dataRoot, { recursive: true, force: true });
  roomStore = await new RoomStore(dataRoot).init();
  database = await new RoomDatabaseService(roomStore).init();
  dataBackups = await new DataBackupService(roomStore, database).init();
  largeText = new LargeTextService();
  gitService = await new GitService(roomStore, getBundledGit()).init();
  await gitService.initializeExistingRooms();
  diagnostics = await new DiagnosticService(dataRoot).init();
  aiService = await new AiService(dataRoot, { secureStorage: safeStorage }).init();
  credentialService = await new RoomCredentialService(dataRoot, { secureStorage: safeStorage }).init();
  networkService = await new NetworkService(dataRoot, { credentialService }).init();
  const roomProtocolHandler = createRoomProtocolHandler();
  if (!protocol.isProtocolHandled("room")) protocol.handle("room", roomProtocolHandler);
  createMainWindow();
  agentWindows = new AgentWindowManager(mainWindow, {
    preloadPath: path.join(__dirname, "..", "preload", "workbench-preload.cjs"),
    rendererPath: path.join(__dirname, "..", "renderer", "index.html"),
    onStateChange: (payload) => {
      broadcastWorkbench("workbench:agentWindowState", payload);
      diagnostics.record("agent.window-state", payload).catch((error) => console.error("记录 Agent 窗口状态失败", error));
    }
  });
  roomViews = await new RoomViewManager(mainWindow, roomStore, roomProtocolHandler, {
    onWindowStateChange: (payload) => {
      broadcastWorkbench("workbench:roomWindowState", payload);
      diagnostics.record("room.window-state", payload).catch((error) => console.error("记录房间窗口状态失败", error));
    }
  }).init();
  roomBrowser = new RoomBrowserService({ mainWindow, roomStore, roomViews, networkService });
  roomViews.setBrowserService(roomBrowser);
  roomAgent = await new RoomAgentService({
    roomStore,
    aiService,
    gitService,
    onEvent: (payload) => {
      broadcastWorkbench("workbench:roomAgentEvent", payload);
    },
    onRoomBuilt: (room) => {
      roomViews.close(room.id);
      broadcastWorkbench("workbench:roomsChanged", roomStore.listRooms());
    },
    recordEvent: (type, data) => diagnostics.record(type, data)
  }).init();

  const environment = {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    git: gitService.version
  };
  unregisterIpc = registerIpcHandlers({
    mainWindow,
    roomStore,
    database,
    dataBackups,
    gitService,
    diagnostics,
    aiService,
    roomAgent,
    largeText,
    networkService,
    credentialService,
    roomViews,
    roomBrowser,
    agentWindows,
    examplePackages: getExamplePackages(),
    environment,
    storageLocation,
    takePendingRoomImports: () => {
      externalRoomConsumerReady = true;
      return pendingExternalRoomPaths.splice(0);
    }
  });

  mainWindow.webContents.once("did-finish-load", () => {
    if (smokeMode) runSmokeCheck(dataRoot).catch(async (error) => {
      console.error("WORKBENCH_SMOKE_FAILED", error);
      app.exitCode = 1;
      terminateSmoke(1);
    });
  });
  await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (runtimeCheckInput) {
  require("./room-runtime-worker.cjs").start(runtimeCheckInput, true);
} else if (!ownsPrimaryInstance) {
  app.quit();
} else app.whenReady().then(bootstrap).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  unregisterIpc?.();
  roomViews?.dispose().catch((error) => console.error("关闭房间窗口失败", error));
  roomBrowser?.dispose();
  agentWindows?.dispose();
  roomAgent?.dispose().catch((error) => console.error("关闭房间 Agent 失败", error));
  largeText?.dispose().catch((error) => console.error("关闭超长文本服务失败", error));
  database?.closeAll().catch((error) => console.error("关闭数据库失败", error));
});

app.on("activate", () => {
  if (!runtimeCheckInput && BrowserWindow.getAllWindows().length === 0) bootstrap().catch(console.error);
});
