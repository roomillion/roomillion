"use strict";

const IS_AGENT_WINDOW = new URLSearchParams(window.location.search).get("surface") === "agent";

const state = {
  rooms: [],
  tabs: [],
  detachedRoomIds: new Set(),
  activeRoomId: null,
  activeSurface: "home",
  agentTabOpen: false,
  agentDetached: false,
  isAgentWindow: IS_AGENT_WINDOW,
  provider: null,
  aiProfiles: [],
  aiUtilityProfiles: {},
  editingAiUtilityKind: null,
  aiUtilityReturnTarget: null,
  navigatingAiUtility: false,
  editingProviderId: null,
  credentialSourceProfileId: null,
  providerEditorOpen: false,
  providerModelContextKey: "",
  pendingProviderModelIds: new Set(),
  remoteProviderModels: new Map(),
  providerQuery: "",
  providerModelQuery: "",
  aiProviders: [],
  aiCapabilities: null,
  networkPolicy: null,
  credentials: [],
  environment: null,
  dataLocation: null,
  roomModules: [],
  examples: [],
  pendingImport: null,
  pendingLockedImport: null,
  pendingRestore: null,
  detailsRoomId: null,
  detailsHistory: null,
  agentSessions: [],
  agentSession: null,
  agentActivity: "",
  pendingAgentImages: [],
  agentCommandIndex: 0,
  agentAttachmentCache: new Map(),
  toastTimer: null,
  dragDepth: 0,
  contextRoomId: null,
  exportRoomId: null,
  headerOverlayRoomId: null,
  headerMenuBusy: false,
  sidebarState: "full",
  themeId: "forest-light"
};

const elements = {
  appShell: document.getElementById("appShell"),
  sidebar: document.getElementById("mainSidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebarToggleIcon: document.getElementById("sidebarToggleIcon"),
  workbenchSettingsButton: document.getElementById("workbenchSettingsButton"),
  workbenchSettingsDialog: document.getElementById("workbenchSettingsDialog"),
  settingsHubDialog: document.getElementById("settingsHubDialog"),
  settingsDefaultRoomModelSelect: document.getElementById("settingsDefaultRoomModelSelect"),
  settingsDefaultRoomModelStatus: document.getElementById("settingsDefaultRoomModelStatus"),
  themeSummary: document.getElementById("themeSummaryNav"),
  themeStatus: document.getElementById("themeStatus"),
  resetThemeButton: document.getElementById("resetThemeButton"),
  roomList: document.getElementById("roomList"),
  roomCount: document.getElementById("roomCount"),
  roomContextMenu: document.getElementById("roomContextMenu"),
  appVersionLabel: document.getElementById("appVersionLabel"),
  tabs: document.getElementById("tabs"),
  tabsScrollBack: document.getElementById("tabsScrollBack"),
  tabsScrollForward: document.getElementById("tabsScrollForward"),
  tabOverviewButton: document.getElementById("tabOverviewButton"),
  tabOverviewCount: document.getElementById("tabOverviewCount"),
  tabOverviewMenu: document.getElementById("tabOverviewMenu"),
  headerMoreWrap: document.getElementById("headerMoreWrap"),
  headerMoreButton: document.getElementById("headerMoreButton"),
  headerMoreMenu: document.getElementById("headerMoreMenu"),
  viewport: document.getElementById("roomViewport"),
  welcome: document.getElementById("welcome"),
  installedRoomsGrid: document.getElementById("installedRoomsGrid"),
  homeRoomCount: document.getElementById("homeRoomCount"),
  detachButton: document.getElementById("detachButton"),
  modifyButton: document.getElementById("modifyButton"),
  detailsButton: document.getElementById("detailsButton"),
  backupButton: document.getElementById("backupButton"),
  restoreButton: document.getElementById("restoreButton"),
  exportButton: document.getElementById("exportButton"),
  uninstallButton: document.getElementById("uninstallButton"),
  detailsUninstallButton: document.getElementById("detailsUninstallButton"),
  examplesDialog: document.getElementById("examplesDialog"),
  examplesGrid: document.getElementById("examplesGrid"),
  examplesStatus: document.getElementById("examplesStatus"),
  unlockImportDialog: document.getElementById("unlockImportDialog"),
  unlockImportForm: document.getElementById("unlockImportForm"),
  unlockImportSummary: document.getElementById("unlockImportSummary"),
  unlockImportStatus: document.getElementById("unlockImportStatus"),
  submitUnlockImportButton: document.getElementById("submitUnlockImportButton"),
  importDialog: document.getElementById("importDialog"),
  importForm: document.getElementById("importForm"),
  importRoomIcon: document.getElementById("importRoomIcon"),
  importRoomName: document.getElementById("importRoomName"),
  importRoomIdentity: document.getElementById("importRoomIdentity"),
  importPublisher: document.getElementById("importPublisher"),
  importRiskBadge: document.getElementById("importRiskBadge"),
  importVersionNotice: document.getElementById("importVersionNotice"),
  importDataNotice: document.getElementById("importDataNotice"),
  importRisks: document.getElementById("importRisks"),
  importPermissions: document.getElementById("importPermissions"),
  importPackageDetails: document.getElementById("importPackageDetails"),
  importStatus: document.getElementById("importStatus"),
  confirmImportButton: document.getElementById("confirmImportButton"),
  exportDialog: document.getElementById("exportDialog"),
  exportRoomTitle: document.getElementById("exportRoomTitle"),
  exportForm: document.getElementById("exportForm"),
  exportPasswordFields: document.getElementById("exportPasswordFields"),
  exportSharingHint: document.getElementById("exportSharingHint"),
  exportStatus: document.getElementById("exportStatus"),
  submitExportButton: document.getElementById("submitExportButton"),
  detailsDialog: document.getElementById("detailsDialog"),
  detailsForm: document.getElementById("detailsForm"),
  detailsRoomName: document.getElementById("detailsRoomName"),
  detailsIdentity: document.getElementById("detailsIdentity"),
  detailsPermissionSummary: document.getElementById("detailsPermissionSummary"),
  detailsPermissions: document.getElementById("detailsPermissions"),
  detailsAiModelSection: document.getElementById("detailsAiModelSection"),
  detailsAiModelSelect: document.getElementById("detailsAiModelSelect"),
  detailsSaveAiModelButton: document.getElementById("detailsSaveAiModelButton"),
  detailsTestAiModelButton: document.getElementById("detailsTestAiModelButton"),
  detailsAiModelHint: document.getElementById("detailsAiModelHint"),
  detailsHistory: document.getElementById("detailsHistory"),
  historyGitVersion: document.getElementById("historyGitVersion"),
  checkpointLabel: document.getElementById("checkpointLabel"),
  createCheckpointButton: document.getElementById("createCheckpointButton"),
  detailsStatus: document.getElementById("detailsStatus"),
  savePermissionsButton: document.getElementById("savePermissionsButton"),
  backupDialog: document.getElementById("backupDialog"),
  backupForm: document.getElementById("backupForm"),
  backupStatus: document.getElementById("backupStatus"),
  submitBackupButton: document.getElementById("submitBackupButton"),
  restoreDialog: document.getElementById("restoreDialog"),
  restoreForm: document.getElementById("restoreForm"),
  restoreSummary: document.getElementById("restoreSummary"),
  restoreStatus: document.getElementById("restoreStatus"),
  submitRestoreButton: document.getElementById("submitRestoreButton"),
  providerDialog: document.getElementById("providerDialog"),
  aiUtilityDialog: document.getElementById("aiUtilityDialog"),
  aiUtilityBackButton: document.getElementById("aiUtilityBackButton"),
  aiUtilityForm: document.getElementById("aiUtilityForm"),
  aiUtilityTitle: document.getElementById("aiUtilityTitle"),
  aiUtilityIntro: document.getElementById("aiUtilityIntro"),
  aiUtilityProtocol: document.getElementById("aiUtilityProtocol"),
  aiUtilityLabel: document.getElementById("aiUtilityLabel"),
  aiUtilityBaseUrl: document.getElementById("aiUtilityBaseUrl"),
  aiUtilityModel: document.getElementById("aiUtilityModel"),
  aiUtilityDimensionsField: document.getElementById("aiUtilityDimensionsField"),
  aiUtilityDimensions: document.getElementById("aiUtilityDimensions"),
  aiUtilityApiKey: document.getElementById("aiUtilityApiKey"),
  aiUtilityRememberKey: document.getElementById("aiUtilityRememberKey"),
  aiUtilityStatus: document.getElementById("aiUtilityStatus"),
  deleteAiUtilityButton: document.getElementById("deleteAiUtilityButton"),
  clearAiUtilityKeyButton: document.getElementById("clearAiUtilityKeyButton"),
  saveAiUtilityButton: document.getElementById("saveAiUtilityButton"),
  testAiUtilityButton: document.getElementById("testAiUtilityButton"),
  providerForm: document.getElementById("providerForm"),
  providerEditorPanel: document.getElementById("providerEditorPanel"),
  providerEditorFields: document.getElementById("providerEditorFields"),
  providerProfileLabelField: document.getElementById("providerProfileLabelField"),
  providerProfileList: document.getElementById("providerProfileList"),
  providerDefaultRoomModelSelect: document.getElementById("providerDefaultRoomModelSelect"),
  providerProfileLabel: document.getElementById("providerProfileLabel"),
  providerEditorTitle: document.getElementById("providerEditorTitle"),
  newProviderButton: document.getElementById("newProviderButton"),
  cancelProviderEditorButton: document.getElementById("cancelProviderEditorButton"),
  providerStatus: document.getElementById("providerStatus"),
  providerSearch: document.getElementById("providerSearch"),
  providerCatalogSummary: document.getElementById("providerCatalogSummary"),
  providerSelect: document.getElementById("providerSelect"),
  providerPickerField: document.getElementById("providerPickerField"),
  providerPickerButton: document.getElementById("providerPickerButton"),
  providerPickerValue: document.getElementById("providerPickerValue"),
  providerChoiceList: document.getElementById("providerChoiceList"),
  providerMetaName: document.getElementById("providerMetaName"),
  providerDescription: document.getElementById("providerDescription"),
  providerEndpoint: document.getElementById("providerEndpoint"),
  providerBadge: document.getElementById("providerBadge"),
  modelSelectField: document.getElementById("modelSelectField"),
  modelSelect: document.getElementById("modelSelect"),
  modelSummary: document.getElementById("modelSummary"),
  providerModelPickerField: document.getElementById("providerModelPickerField"),
  providerModelCount: document.getElementById("providerModelCount"),
  providerModelSearch: document.getElementById("providerModelSearch"),
  providerModelList: document.getElementById("providerModelList"),
  selectAllProviderModels: document.getElementById("selectAllProviderModels"),
  customCatalogModelFields: document.getElementById("customCatalogModelFields"),
  providerFetchRow: document.getElementById("providerFetchRow"),
  fetchProviderModelsButton: document.getElementById("fetchProviderModelsButton"),
  fetchProviderModelsStatus: document.getElementById("fetchProviderModelsStatus"),
  customCatalogModelIds: document.getElementById("customCatalogModelIds"),
  customModelContextWindow: document.getElementById("customModelContextWindow"),
  customModelSupportsImages: document.getElementById("customModelSupportsImages"),
  customModelSupportsAudio: document.getElementById("customModelSupportsAudio"),
  clearProviderModels: document.getElementById("clearProviderModels"),
  credentialReuseNotice: document.getElementById("credentialReuseNotice"),
  credentialReuseText: document.getElementById("credentialReuseText"),
  customProviderFields: document.getElementById("customProviderFields"),
  customProviderName: document.getElementById("customProviderName"),
  customBaseUrl: document.getElementById("customBaseUrl"),
  customModel: document.getElementById("customModel"),
  providerApiKey: document.getElementById("providerApiKey"),
  apiKeyHint: document.getElementById("apiKeyHint"),
  saveProviderButton: document.getElementById("saveProviderButton"),
  testProviderButton: document.getElementById("testProviderButton"),
  clearKeyButton: document.getElementById("clearKeyButton"),
  providerDot: document.getElementById("providerDot"),
  providerSummary: document.getElementById("providerSummaryInline"),
  secureStorageSummary: document.getElementById("secureStorageSummary"),
  networkDialog: document.getElementById("networkDialog"),
  networkForm: document.getElementById("networkForm"),
  roomNetworkEnabled: document.getElementById("roomNetworkEnabled"),
  networkPolicySummary: document.getElementById("networkPolicySummary"),
  networkDot: document.getElementById("networkDot"),
  networkSummary: document.getElementById("networkSummaryInline"),
  networkStatus: document.getElementById("networkStatus"),
  saveNetworkButton: document.getElementById("saveNetworkButton"),
  credentialAlias: document.getElementById("credentialAlias"),
  credentialLabel: document.getElementById("credentialLabel"),
  credentialOrigin: document.getElementById("credentialOrigin"),
  credentialHeaderName: document.getElementById("credentialHeaderName"),
  credentialPrefix: document.getElementById("credentialPrefix"),
  credentialValue: document.getElementById("credentialValue"),
  credentialRemember: document.getElementById("credentialRemember"),
  saveCredentialButton: document.getElementById("saveCredentialButton"),
  credentialList: document.getElementById("credentialList"),
  generateDialog: document.getElementById("generateDialog"),
  generateForm: document.getElementById("generateForm"),
  generatePrompt: document.getElementById("generatePrompt"),
  agentCommandMenu: document.getElementById("agentCommandMenu"),
  generateStatus: document.getElementById("generateStatus"),
  submitGenerateButton: document.getElementById("submitGenerateButton"),
  newAgentSessionButton: document.getElementById("newAgentSessionButton"),
  agentNewTaskButton: document.getElementById("agentNewTaskButton"),
  agentSessionList: document.getElementById("agentSessionList"),
  agentSessionTitle: document.getElementById("agentSessionTitle"),
  agentProviderLabel: document.getElementById("agentProviderLabel"),
  agentModelLabel: document.getElementById("agentModelLabel"),
  agentModelSelect: document.getElementById("agentModelSelect"),
  agentRunStatus: document.getElementById("agentRunStatus"),
  stopAgentButton: document.getElementById("stopAgentButton"),
  agentConversation: document.getElementById("agentConversation"),
  agentEmptyState: document.getElementById("agentEmptyState"),
  agentTimeline: document.getElementById("agentTimeline"),
  agentActivity: document.getElementById("agentActivity"),
  agentAttachButton: document.getElementById("agentAttachButton"),
  agentImageInput: document.getElementById("agentImageInput"),
  agentAttachmentTray: document.getElementById("agentAttachmentTray"),
  agentVisionStatus: document.getElementById("agentVisionStatus"),
  agentProviderSettingsButton: document.getElementById("agentProviderSettingsButton"),
  agentWindowButton: document.getElementById("agentWindowButton"),
  exportAgentSessionButton: document.getElementById("exportAgentSessionButton"),
  closeAgentWorkspaceButton: document.getElementById("closeAgentWorkspaceButton"),
  deleteAgentSessionButton: document.getElementById("deleteAgentSessionButton"),
  agentImagePreviewDialog: document.getElementById("agentImagePreviewDialog"),
  agentImagePreview: document.getElementById("agentImagePreview"),
  agentImagePreviewTitle: document.getElementById("agentImagePreviewTitle"),
  modifyDialog: document.getElementById("modifyDialog"),
  modifyForm: document.getElementById("modifyForm"),
  modifyStatus: document.getElementById("modifyStatus"),
  submitModifyButton: document.getElementById("submitModifyButton"),
  diagnosticsDialog: document.getElementById("diagnosticsDialog"),
  diagnosticsForm: document.getElementById("diagnosticsForm"),
  diagnosticsSummary: document.getElementById("diagnosticsSummary"),
  diagnosticsIncluded: document.getElementById("diagnosticsIncluded"),
  diagnosticsExcluded: document.getElementById("diagnosticsExcluded"),
  diagnosticsStatus: document.getElementById("diagnosticsStatus"),
  confirmDiagnosticsButton: document.getElementById("confirmDiagnosticsButton"),
  toast: document.getElementById("toast")
};

const RISK_LABELS = { low: "低风险", medium: "需注意", high: "高风险" };
const SOURCE_LABELS = {
  builtin: "工作台内置",
  "local-generated": "本机生成",
  "legacy-local": "本机已有",
  external: "外部文件"
};
const TRUST_LABELS = {
  builtin: "内置可信",
  local: "本机来源",
  unknown: "未知来源",
  "unverified-signature": "签名未验证"
};
const AGENT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const AGENT_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif)$/i;
const MAX_AGENT_IMAGES = Infinity;
const MAX_AGENT_IMAGE_BYTES = Infinity;
const SIDEBAR_STORAGE_KEY = "zhibian.sidebar.state.v1";
const SIDEBAR_STATES = ["full", "compact", "hidden"];
const THEME_STORAGE_KEY = "zhibian.appearance.theme.v1";
const THEME_CHANNEL_NAME = "roomillion-appearance";
const DEFAULT_WORKBENCH_THEME = "forest-light";
const WORKBENCH_THEMES = Object.freeze([
  Object.freeze({ id: "forest-light", name: "林间青", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "ocean-light", name: "海湾蓝", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "paper-light", name: "暖纸米", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "lilac-light", name: "晨雾紫", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "rose-light", name: "蔷薇粉", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "jade-light", name: "青瓷绿", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "amber-light", name: "暖阳金", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "cloud-light", name: "月白灰", mode: "light", modeLabel: "日间" }),
  Object.freeze({ id: "ink-light", name: "宣纸丹青", mode: "light", modeLabel: "风格" }),
  Object.freeze({ id: "celadon-light", name: "宋瓷雅白", mode: "light", modeLabel: "风格" }),
  Object.freeze({ id: "studio-light", name: "无界白", mode: "light", modeLabel: "风格" }),
  Object.freeze({ id: "editorial-light", name: "编辑部", mode: "light", modeLabel: "风格" }),
  Object.freeze({ id: "forest-dark", name: "深林夜", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "midnight-dark", name: "午夜蓝", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "violet-dark", name: "紫晶夜", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "graphite-dark", name: "石墨橙", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "wine-dark", name: "酒红夜", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "abyss-dark", name: "深海青", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "brass-dark", name: "鎏金夜", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "sakura-dark", name: "樱夜粉", mode: "dark", modeLabel: "夜间" }),
  Object.freeze({ id: "studio-dark", name: "极简夜晚", mode: "dark", modeLabel: "风格" }),
  Object.freeze({ id: "prism-dark", name: "霓虹玻璃", mode: "dark", modeLabel: "风格" })
]);
const WORKBENCH_THEME_MAP = new Map(WORKBENCH_THEMES.map((theme) => [theme.id, theme]));
let themeChannel = null;
try {
  if (typeof BroadcastChannel === "function") themeChannel = new BroadcastChannel(THEME_CHANNEL_NAME);
} catch {}
const SIDEBAR_PRESENTATION = {
  full: { action: "收起为图标栏", announcement: "栏目已完整展开" },
  compact: { action: "完全收起栏目", announcement: "栏目已收成图标栏" },
  hidden: { action: "展开栏目", announcement: "栏目已完全收起，房间内容最大化" }
};

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "terminal-dark") {
      try { localStorage.setItem(THEME_STORAGE_KEY, "studio-dark"); } catch {}
      return "studio-dark";
    }
    return WORKBENCH_THEME_MAP.has(stored) ? stored : DEFAULT_WORKBENCH_THEME;
  } catch {
    return DEFAULT_WORKBENCH_THEME;
  }
}

function renderThemeSelection() {
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    const selected = button.dataset.themeChoice === state.themeId;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function applyWorkbenchTheme(themeId, { persist = true, broadcast = persist, announce = false } = {}) {
  const theme = WORKBENCH_THEME_MAP.get(themeId === "terminal-dark" ? "studio-dark" : themeId) || WORKBENCH_THEME_MAP.get(DEFAULT_WORKBENCH_THEME);
  state.themeId = theme.id;
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.themeMode = theme.mode;
  document.documentElement.style.colorScheme = theme.mode;
  elements.themeSummary.textContent = theme.name + " · " + theme.modeLabel;
  updateSettingsSummary();
  renderThemeSelection();
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme.id); } catch {}
  }
  if (broadcast) {
    try { themeChannel?.postMessage({ type: "theme", themeId: theme.id }); } catch {}
  }
  window.workbench?.setTheme?.(theme.id).catch((error) => console.warn("同步原生标题栏主题失败", error));
  if (announce) {
    setInlineStatus(elements.themeStatus, "已切换为“" + theme.name + "”" + theme.modeLabel + "主题，并自动保存。", false);
  }
  return theme;
}

async function showWorkbenchSettings() {
  await hideRoomForModal();
  renderThemeSelection();
  const theme = WORKBENCH_THEME_MAP.get(state.themeId);
  setInlineStatus(elements.themeStatus, "当前使用“" + theme.name + "”" + theme.modeLabel + "主题。点击其他主题即可实时切换。", false);
  elements.workbenchSettingsDialog.showModal();
}

async function showSettingsHub(section = "appearance") {
  await hideRoomForModal();
  switchSettingsSection(section);
  elements.settingsHubDialog.showModal();
}

function switchSettingsSection(section) {
  for (const item of elements.settingsHubDialog.querySelectorAll(".settingsHubNavItem")) {
    item.classList.toggle("active", item.dataset.settingsSection === section);
  }
  for (const panel of elements.settingsHubDialog.querySelectorAll(".settingsHubPanel")) {
    panel.classList.toggle("active", panel.dataset.settingsPanel === section);
  }
}

function closeSettingsHub() {
  if (elements.settingsHubDialog.open) elements.settingsHubDialog.close();
}

function updateSettingsSummary() {
  const el = document.getElementById("settingsSummary");
  if (!el) return;
  const ready = state.aiProfiles.filter(WorkbenchPresentation.canUseProfile).length;
  const ai = ready ? `AI ${ready}/${state.aiProfiles.length} 个模型就绪` : "AI 需要配置";
  const defaultModel = state.provider ? `${state.provider.name} · ${state.provider.model}` : "尚未设置";
  const nav = document.getElementById("providerSummaryNav");
  if (nav) nav.textContent = state.provider && WorkbenchPresentation.canUseProfile(state.provider)
    ? `房间默认：${state.provider.model}`
    : `${ai}${state.provider ? " · 默认模型需修复" : ""}`;
  renderDefaultRoomModelControls();
  renderAiUtilityProfiles();
  if (elements.settingsDefaultRoomModelStatus) {
    const usable = WorkbenchPresentation.canUseProfile(state.provider);
    setInlineStatus(
      elements.settingsDefaultRoomModelStatus,
      state.provider
        ? usable
          ? `当前房间默认模型：${defaultModel}。更改后立即应用于跟随默认设置的房间。`
          : `当前房间默认模型 ${defaultModel} 缺少可用凭据，请修复或选择其他模型。`
        : "尚未设置房间默认 AI 模型。请先打开 AI 能力中心并启用模型。",
      Boolean(state.provider && !usable)
    );
  }
  const net = state.networkPolicy?.roomNetworkEnabled === true ? "联网开" : "联网关";
  el.textContent = `${ai} · ${net}`;
}

const AI_UTILITY_META = Object.freeze({
  embedding: Object.freeze({
    title: "Embedding 模型",
    help: "把文字变成可比较的向量，用于语义搜索、知识库和查找相似内容。",
    intro: "把文本转换为向量，供语义搜索、知识库、聚类和相似度计算使用。",
    protocol: "调用 OpenAI 兼容的 POST /embeddings；房间使用 room.ai.embed()，无需接触 API Key。",
    label: "Embedding 模型",
    baseUrl: "",
    model: ""
  }),
  rerank: Object.freeze({
    title: "Rerank 模型",
    help: "把初步找到的候选内容重新排序，让最相关的结果排在前面。",
    intro: "根据查询重新排列候选文本，适合在向量检索之后提高最终结果相关性。",
    protocol: "调用常见的 POST /rerank 协议，兼容 Cohere、Jina 与同结构网关；房间使用 room.ai.rerank()。",
    label: "Rerank 模型",
    baseUrl: "",
    model: ""
  }),
  intuition: Object.freeze({
    title: "直觉模型 · Jev",
    help: "快速给出是非、选项或评分的概率判断，适合分类和流程分支。",
    intro: "Jev 是 TypeSafe AI 的 System One 模型：快速返回有类型的选择、评分或是非概率，不生成自由文本。",
    protocol: "调用 POST /systemone；房间使用 room.ai.intuition() 提交 state 和 noul、score、choice 问题。",
    label: "TypeSafe AI · Jev",
    baseUrl: "https://api.typesafe.ai/v1",
    model: "jev-latest"
  })
});

function renderAiUtilityProfiles() {
  for (const card of document.querySelectorAll("[data-ai-utility-kind]")) {
    const kind = card.dataset.aiUtilityKind;
    const help = AI_UTILITY_META[kind]?.help || "";
    card.dataset.aiUtilityHelp = help;
    card.setAttribute("aria-description", help);
    const profile = state.aiUtilityProfiles?.[kind] || null;
    const status = card.querySelector("[data-ai-utility-status]");
    card.classList.toggle("configured", Boolean(profile));
    card.classList.toggle("ready", Boolean(profile?.ready));
    if (status) status.textContent = profile
      ? `${profile.model} · ${profile.ready ? "可用" : profile.hasStoredKey ? "密钥无法读取" : "需要密钥"}`
      : "未配置 · 点击设置";
  }
}

async function showAiUtilityDialog(kind) {
  const meta = AI_UTILITY_META[kind];
  if (!meta) return;
  state.aiUtilityReturnTarget = elements.providerDialog.open ? "provider" : "settings";
  state.navigatingAiUtility = true;
  try {
    closeSettingsHub();
    if (elements.providerDialog.open) elements.providerDialog.close();
    await hideRoomForModal();
  } finally { state.navigatingAiUtility = false; }
  state.editingAiUtilityKind = kind;
  elements.aiUtilityBackButton.textContent = state.aiUtilityReturnTarget === "provider" ? "← 返回 AI 能力中心" : "← 返回设置";
  const profile = state.aiUtilityProfiles?.[kind] || null;
  elements.aiUtilityTitle.textContent = meta.title;
  elements.aiUtilityIntro.textContent = meta.intro;
  elements.aiUtilityProtocol.textContent = meta.protocol;
  elements.aiUtilityLabel.value = profile?.label || meta.label;
  elements.aiUtilityBaseUrl.value = profile?.baseUrl || meta.baseUrl;
  elements.aiUtilityModel.value = profile?.model || meta.model;
  elements.aiUtilityDimensionsField.hidden = kind !== "embedding";
  elements.aiUtilityDimensions.value = profile?.dimensions || "";
  elements.aiUtilityApiKey.value = "";
  elements.aiUtilityRememberKey.checked = Boolean(profile?.hasStoredKey);
  elements.deleteAiUtilityButton.disabled = !profile;
  elements.clearAiUtilityKeyButton.disabled = !profile?.hasSessionKey && !profile?.hasStoredKey;
  setInlineStatus(
    elements.aiUtilityStatus,
    profile ? `${profile.model} 已配置${profile.ready ? "并可供房间调用" : "，但当前缺少可用密钥"}。` : "填写连接信息后保存；“保存并测试”会真实调用一次模型 API。",
    Boolean(profile && !profile.ready)
  );
  elements.aiUtilityDialog.showModal();
}

async function returnFromAiUtilityDialog() {
  const target = state.aiUtilityReturnTarget;
  state.navigatingAiUtility = true;
  elements.aiUtilityDialog.close();
  try {
    if (target === "provider") await showProviderDialog();
    else await showSettingsHub("ai");
  } finally {
    state.navigatingAiUtility = false;
  }
}

function aiUtilityPayload() {
  return {
    label: elements.aiUtilityLabel.value.trim(),
    baseUrl: elements.aiUtilityBaseUrl.value.trim(),
    model: elements.aiUtilityModel.value.trim(),
    ...(state.editingAiUtilityKind === "embedding" && elements.aiUtilityDimensions.value ? { dimensions: Number(elements.aiUtilityDimensions.value) } : {}),
    ...(elements.aiUtilityApiKey.value ? { apiKey: elements.aiUtilityApiKey.value } : {}),
    rememberKey: elements.aiUtilityRememberKey.checked
  };
}

async function saveAiUtilityProfile({ test = false } = {}) {
  const kind = state.editingAiUtilityKind;
  if (!AI_UTILITY_META[kind]) return;
  elements.saveAiUtilityButton.disabled = true;
  elements.testAiUtilityButton.disabled = true;
  try {
    state.aiUtilityProfiles = await window.workbench.saveAiCapabilityProfile(kind, aiUtilityPayload());
    elements.aiUtilityApiKey.value = "";
    if (test) {
      setInlineStatus(elements.aiUtilityStatus, "正在真实调用模型 API……", false);
      const result = await window.workbench.testAiCapabilityProfile(kind);
      state.aiUtilityProfiles = result.profiles;
      setInlineStatus(elements.aiUtilityStatus, `连接通过：${result.model} · ${result.latencyMs} ms`, false);
    } else setInlineStatus(elements.aiUtilityStatus, "配置已保存，房间现在可以通过工作台网关调用。", false);
    renderAiUtilityProfiles();
    updateSettingsSummary();
  } catch (error) {
    setInlineStatus(elements.aiUtilityStatus, formatError(error), true);
  } finally {
    elements.saveAiUtilityButton.disabled = false;
    elements.testAiUtilityButton.disabled = false;
  }
}

function renderDefaultRoomModelSelect(select) {
  if (!select) return;
  const previousValue = select.value;
  select.replaceChildren();
  if (!state.aiProfiles.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "尚未启用 AI 模型";
    select.appendChild(empty);
    select.disabled = true;
    return;
  }
  for (const profile of state.aiProfiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.model}${WorkbenchPresentation.canUseProfile(profile) ? "" : "（凭据不可用）"}`;
    option.disabled = !WorkbenchPresentation.canUseProfile(profile) && profile.id !== state.provider?.id;
    select.appendChild(option);
  }
  select.value = state.provider?.id || previousValue || state.aiProfiles[0].id;
  select.disabled = !state.aiProfiles.some(WorkbenchPresentation.canUseProfile);
}

function renderDefaultRoomModelControls() {
  renderDefaultRoomModelSelect(elements.settingsDefaultRoomModelSelect);
  renderDefaultRoomModelSelect(elements.providerDefaultRoomModelSelect);
}

function readStoredSidebarState() {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return SIDEBAR_STATES.includes(stored) ? stored : "full";
  } catch {
    return "full";
  }
}

function applySidebarState(nextState, { persist = true, announce = false } = {}) {
  const normalized = SIDEBAR_STATES.includes(nextState) ? nextState : "full";
  const presentation = SIDEBAR_PRESENTATION[normalized];
  state.sidebarState = normalized;
  elements.appShell.dataset.sidebarState = normalized;
  elements.sidebarToggle.dataset.sidebarState = normalized;
  elements.sidebarToggle.title = presentation.action;
  elements.sidebarToggle.setAttribute("aria-label", presentation.action);
  elements.sidebarToggle.setAttribute("aria-expanded", String(normalized !== "hidden"));
  elements.sidebar.setAttribute("aria-hidden", String(normalized === "hidden"));
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, normalized);
    } catch {}
  }
  hideRoomContextMenu();
  if (announce) showToast(presentation.announcement);
  if (state.activeRoomId) {
    window.setTimeout(() => syncViewport().catch(() => {}), 230);
  }
}

function cycleSidebarState() {
  const currentIndex = SIDEBAR_STATES.indexOf(state.sidebarState);
  applySidebarState(SIDEBAR_STATES[(currentIndex + 1) % SIDEBAR_STATES.length], { announce: true });
}

function roomById(roomId) {
  return state.rooms.find((room) => room.id === roomId) ?? null;
}

function isAiModifiable(room) {
  return Boolean(room) && (room.source === "local-generated" || room.allowAiModification === true);
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function formatError(error) {
  const message = error?.message || String(error);
  return message.replace(/^Error invoking remote method '[^']+': /, "");
}

function setInlineStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function activeAgentModelDefinition() {
  const selectedProfileId = state.agentSession?.profileId || state.agentSession?.provider?.profileId;
  const profile = state.aiProfiles.find((item) => item.id === selectedProfileId) || state.provider;
  const provider = state.aiProviders.find((item) => item.id === profile?.providerId);
  return provider?.models?.find((item) => item.id === profile?.model) || null;
}

function agentSupportsImages() {
  return activeAgentModelDefinition()?.input?.includes("image") === true;
}

function looksLikeAgentImage(file) {
  return Boolean(file && (AGENT_IMAGE_TYPES.has(file.type) || AGENT_IMAGE_EXTENSIONS.test(file.name || "")));
}

function resizeAgentComposer() {
  elements.generatePrompt.style.height = "auto";
  elements.generatePrompt.style.height = `${Math.min(180, Math.max(54, elements.generatePrompt.scrollHeight))}px`;
}

function matchingAgentCommands() {
  const value = elements.generatePrompt.value.trimStart();
  if (!value.startsWith("/") || /\s/.test(value)) return [];
  const commands = state.agentSession?.commands || [];
  return commands.filter((item) => item.name.startsWith(value.toLowerCase()));
}

function chooseAgentCommand(command) {
  elements.generatePrompt.value = command.name === "/model" ? "/model " : command.usage;
  state.agentCommandIndex = 0;
  renderAgentCommandMenu();
  resizeAgentComposer();
  renderAgentHeader();
  elements.generatePrompt.focus();
  elements.generatePrompt.setSelectionRange(elements.generatePrompt.value.length, elements.generatePrompt.value.length);
}

function renderAgentCommandMenu() {
  const commands = matchingAgentCommands();
  elements.agentCommandMenu.replaceChildren();
  elements.agentCommandMenu.hidden = commands.length === 0;
  if (!commands.length) { state.agentCommandIndex = 0; return; }
  state.agentCommandIndex = Math.min(state.agentCommandIndex, commands.length - 1);
  commands.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agentCommandOption${index === state.agentCommandIndex ? " selected" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === state.agentCommandIndex ? "true" : "false");
    const usage = document.createElement("code");
    usage.textContent = command.usage;
    const description = document.createElement("span");
    description.textContent = command.description;
    button.append(usage, description);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => chooseAgentCommand(command));
    elements.agentCommandMenu.appendChild(button);
  });
}

function clearPendingAgentImages() {
  for (const item of state.pendingAgentImages) URL.revokeObjectURL(item.url);
  state.pendingAgentImages = [];
  elements.agentImageInput.value = "";
  renderPendingAgentImages();
}

function renderPendingAgentImages() {
  elements.agentAttachmentTray.replaceChildren();
  elements.agentAttachmentTray.hidden = state.pendingAgentImages.length === 0;
  for (const item of state.pendingAgentImages) {
    const card = document.createElement("div");
    card.className = "agentPendingImage";
    const image = document.createElement("img");
    image.src = item.url;
    image.alt = item.file.name || "待发送图片";
    const label = document.createElement("small");
    label.textContent = item.file.name || "粘贴的图片";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "移除图片";
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(item.url);
      state.pendingAgentImages = state.pendingAgentImages.filter((candidate) => candidate.id !== item.id);
      renderPendingAgentImages();
      renderAgentHeader();
    });
    card.append(image, label, remove);
    elements.agentAttachmentTray.appendChild(card);
  }
}

function addAgentImages(files) {
  const candidates = [...files].filter(looksLikeAgentImage);
  elements.agentImageInput.value = "";
  if (!candidates.length) {
    showToast("只支持 PNG、JPEG、WebP 或 GIF 图片");
    return;
  }
  if (!agentSupportsImages()) {
    showToast("当前模型仅支持文本，请在 AI 能力中心切换到支持图片的模型");
    return;
  }
  const slots = MAX_AGENT_IMAGES - state.pendingAgentImages.length;
  if (slots <= 0) {
    showToast(`每条消息最多添加 ${MAX_AGENT_IMAGES} 张图片`);
    return;
  }
  let added = 0;
  for (const file of candidates.slice(0, slots)) {
    if (file.size <= 0 || file.size > MAX_AGENT_IMAGE_BYTES) {
      showToast(`“${file.name || "图片"}”超过 8 MB，未添加`);
      continue;
    }
    state.pendingAgentImages.push({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file)
    });
    added += 1;
  }
  if (candidates.length > slots) showToast(`每条消息最多添加 ${MAX_AGENT_IMAGES} 张图片`);
  if (added) {
    renderPendingAgentImages();
    renderAgentHeader();
    elements.generatePrompt.focus();
  }
}

function showAgentImagePreview(dataUrl, name) {
  elements.agentImagePreview.src = dataUrl;
  elements.agentImagePreview.alt = name || "参考图片";
  elements.agentImagePreviewTitle.textContent = name || "参考图片";
  if (!elements.agentImagePreviewDialog.open) elements.agentImagePreviewDialog.showModal();
}

function loadStoredAgentImage(image, card, attachment) {
  const sessionId = state.agentSession?.id;
  if (!sessionId) return;
  const cacheKey = `${sessionId}:${attachment.id}`;
  let request = state.agentAttachmentCache.get(cacheKey);
  if (!request) {
    request = window.workbench.getRoomAgentAttachment(sessionId, attachment.id);
    state.agentAttachmentCache.set(cacheKey, request);
  }
  request.then((result) => {
    if (!image.isConnected) return;
    image.src = result.dataUrl;
    card.classList.remove("loading");
    card.addEventListener("click", () => showAgentImagePreview(result.dataUrl, attachment.name));
  }).catch(() => {
    if (!card.isConnected) return;
    card.classList.remove("loading");
    card.classList.add("failed");
  });
}

function roomIconUrl(room) {
  if (!room?.icon || !room?.id) return "";
  return `room://${room.id}/${room.icon.split("/").map(encodeURIComponent).join("/")}`;
}

function renderRoomIcon(element, room, { dataUrl = "", fallback = "" } = {}) {
  const fallbackText = fallback || room?.name?.slice(0, 1) || "房";
  element.replaceChildren();
  element.textContent = fallbackText;
  const source = dataUrl || roomIconUrl(room);
  if (!source) return;
  const image = document.createElement("img");
  image.alt = "";
  image.decoding = "async";
  image.addEventListener("load", () => {
    if (element.isConnected) element.replaceChildren(image);
  }, { once: true });
  image.src = source;
}

function renderRooms() {
  elements.roomCount.textContent = String(state.rooms.length);
  elements.homeRoomCount.textContent = String(state.rooms.length);
  elements.roomList.replaceChildren();
  renderHomeRooms();
  if (!state.rooms.length) {
    const empty = document.createElement("div");
    empty.className = "emptyRooms";
    empty.textContent = "还没有房间";
    elements.roomList.appendChild(empty);
    return;
  }
  for (const room of state.rooms) {
    const row = document.createElement("div");
    row.className = "roomItemRow";
    const button = document.createElement("button");
    button.className = `roomItem${state.activeRoomId === room.id ? " active" : ""}`;
    button.title = room.name;
    const icon = document.createElement("span");
    icon.className = "roomIcon";
    renderRoomIcon(icon, room);
    const text = document.createElement("span");
    text.className = "roomItemText";
    const name = document.createElement("strong");
    name.textContent = room.name;
    const version = document.createElement("small");
    version.textContent = `v${room.version} · ${TRUST_LABELS[room.trust] ?? "未知来源"}${state.detachedRoomIds.has(room.id) ? " · 独立窗口" : ""}`;
    text.append(name, version);
    button.append(icon, text);
    button.addEventListener("click", () => openRoom(room.id));
    button.addEventListener("contextmenu", (event) => showRoomContextMenu(event, room.id, row));
    row.append(button);
    elements.roomList.appendChild(row);
  }
}

function roomCapabilityLabels(room) {
  const labels = [];
  if (room.permissions?.database === "private") labels.push("私有数据");
  if (room.permissions?.ai) labels.push("AI");
  if (room.permissions?.files?.length) labels.push("文件");
  if (room.permissions?.network?.length) labels.push("受控联网");
  if (room.permissions?.browser?.includes("navigate")) labels.push("网页浏览");
  if (room.hostModules?.length) labels.push(`${room.hostModules.length} 个模块`);
  return labels.length ? labels : ["离线房间"];
}

function renderHomeRooms() {
  elements.installedRoomsGrid.replaceChildren();
  if (!state.rooms.length) {
    const empty = document.createElement("div");
    empty.className = "installedRoomsEmpty";
    empty.textContent = "还没有安装房间。可以使用上方 AI 创建、示例房间或导入一个 .room。";
    elements.installedRoomsGrid.appendChild(empty);
    return;
  }
  for (const room of state.rooms) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `installedRoomCard${state.activeSurface === "room" && state.activeRoomId === room.id ? " active" : ""}`;
    card.dataset.roomId = room.id;
    card.title = `打开“${room.name}”`;
    const icon = document.createElement("span");
    icon.className = "installedRoomIcon";
    renderRoomIcon(icon, room);
    const content = document.createElement("span");
    content.className = "installedRoomContent";
    const name = document.createElement("strong");
    name.textContent = room.name;
    const meta = document.createElement("small");
    meta.textContent = `v${room.version} · ${TRUST_LABELS[room.trust] ?? "未知来源"}${state.detachedRoomIds.has(room.id) ? " · 独立窗口" : ""}`;
    content.append(name, meta);
    const chips = document.createElement("span");
    chips.className = "installedRoomChips";
    for (const label of roomCapabilityLabels(room)) {
      const chip = document.createElement("span");
      chip.textContent = label;
      chips.appendChild(chip);
    }
    card.append(icon, content, chips);
    card.addEventListener("click", () => openRoom(room.id));
    card.addEventListener("contextmenu", (event) => showRoomContextMenu(event, room.id, card));
    elements.installedRoomsGrid.appendChild(card);
  }
}

function hideRoomContextMenu() {
  state.contextRoomId = null;
  elements.roomContextMenu.hidden = true;
}

function showRoomContextMenu(event, roomId, anchor) {
  event.preventDefault();
  event.stopPropagation();
  state.contextRoomId = roomId;
  elements.roomContextMenu.hidden = false;
  elements.roomContextMenu.style.left = "0px";
  elements.roomContextMenu.style.top = "0px";
  const menuRect = elements.roomContextMenu.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const requestedLeft = event.clientX || anchorRect.left + 24;
  const requestedTop = event.clientY || anchorRect.top + Math.min(anchorRect.height, 30);
  const left = Math.max(8, Math.min(requestedLeft, window.innerWidth - menuRect.width - 8));
  const top = Math.max(8, Math.min(requestedTop, window.innerHeight - menuRect.height - 8));
  elements.roomContextMenu.style.left = `${left}px`;
  elements.roomContextMenu.style.top = `${top}px`;
  elements.roomContextMenu.querySelector("button")?.focus({ preventScroll: true });
}

function hideTabOverviewMenu() {
  elements.tabOverviewMenu.hidden = true;
  elements.tabOverviewButton.setAttribute("aria-expanded", "false");
}

function hideHeaderMoreMenu() {
  elements.headerMoreMenu.hidden = true;
  elements.headerMoreButton.setAttribute("aria-expanded", "false");
}

async function suspendRoomForHeaderMenu() {
  if (state.isAgentWindow || state.headerOverlayRoomId) return;
  if (state.activeSurface !== "room" || !state.activeRoomId) return;
  const roomId = state.activeRoomId;
  state.headerOverlayRoomId = roomId;
  try {
    await window.workbench.hideRoom();
  } catch (error) {
    if (state.headerOverlayRoomId === roomId) state.headerOverlayRoomId = null;
    throw error;
  }
}

async function restoreRoomAfterHeaderMenu() {
  if (!elements.tabOverviewMenu.hidden || !elements.headerMoreMenu.hidden) return;
  const roomId = state.headerOverlayRoomId;
  state.headerOverlayRoomId = null;
  if (!roomId || state.activeSurface !== "room" || state.activeRoomId !== roomId) return;
  await syncViewport();
  await window.workbench.openRoom(roomId);
}

async function closeHeaderMenus({ restoreRoom = true } = {}) {
  hideTabOverviewMenu();
  hideHeaderMoreMenu();
  if (restoreRoom) await restoreRoomAfterHeaderMenu();
  else state.headerOverlayRoomId = null;
}

async function toggleHeaderMenu(menuName) {
  if (state.headerMenuBusy) return;
  const menu = menuName === "tabs" ? elements.tabOverviewMenu : elements.headerMoreMenu;
  const button = menuName === "tabs" ? elements.tabOverviewButton : elements.headerMoreButton;
  if (button.disabled) return;
  state.headerMenuBusy = true;
  try {
    if (!menu.hidden) {
      await closeHeaderMenus();
      return;
    }
    if (menuName === "tabs") hideHeaderMoreMenu();
    else hideTabOverviewMenu();
    await suspendRoomForHeaderMenu();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (menuName === "tabs") menu.querySelector("button")?.focus({ preventScroll: true });
  } catch (error) {
    await closeHeaderMenus().catch(() => {});
    showToast(formatError(error));
  } finally {
    state.headerMenuBusy = false;
  }
}

function renderTabOverview() {
  elements.tabOverviewMenu.replaceChildren();
  const entries = [];
  if (!state.isAgentWindow) {
    entries.push({ key: "home", label: "主页", detail: "工作台主页", icon: "首", active: state.activeSurface === "home", open: () => openHome() });
    if (state.agentTabOpen || state.agentDetached) {
      entries.push({
        key: "agent",
        label: "AI 创建房间",
        detail: state.agentDetached ? "正在独立窗口运行" : "房间开发 Agent",
        icon: "AI",
        active: state.activeSurface === "agent" || state.agentDetached,
        detached: state.agentDetached,
        open: () => showGenerateDialog()
      });
    }
  }
  for (const roomId of state.tabs) {
    const room = roomById(roomId);
    if (!room) continue;
    entries.push({
      key: roomId,
      label: room.name,
      detail: `v${room.version}`,
      icon: room.name.slice(0, 1),
      room,
      active: state.activeSurface === "room" && state.activeRoomId === roomId,
      detached: state.detachedRoomIds.has(roomId),
      open: () => openRoom(roomId)
    });
  }
  elements.tabOverviewCount.textContent = String(entries.length);
  elements.tabOverviewButton.title = `查看全部标签（${entries.length}）`;
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tabOverviewItem${entry.active ? " active" : ""}`;
    button.dataset.tabKey = entry.key;
    button.setAttribute("role", "menuitem");
    const icon = document.createElement("span");
    icon.className = "tabOverviewItemIcon";
    if (entry.room) renderRoomIcon(icon, entry.room, { fallback: entry.icon });
    else icon.textContent = entry.icon;
    const text = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = entry.label;
    const detail = document.createElement("small");
    detail.textContent = entry.detail;
    text.append(label, detail);
    const status = document.createElement("span");
    status.className = "tabOverviewItemState";
    status.textContent = entry.detached ? "独立窗口" : entry.active ? "当前" : "";
    button.append(icon, text, status);
    button.addEventListener("click", async () => {
      const suspendedRoomId = state.headerOverlayRoomId;
      await closeHeaderMenus({ restoreRoom: false });
      try {
        await entry.open();
      } catch (error) {
        if (suspendedRoomId && state.activeSurface === "room" && state.activeRoomId === suspendedRoomId) {
          state.headerOverlayRoomId = suspendedRoomId;
          await restoreRoomAfterHeaderMenu().catch(() => {});
        }
        showToast(formatError(error));
      }
    });
    elements.tabOverviewMenu.appendChild(button);
  }
}

function updateTabOverflow() {
  if (state.isAgentWindow) return;
  const manyTabs = elements.tabOverviewMenu.childElementCount > 5;
  let overflow = elements.tabs.scrollWidth > elements.tabs.clientWidth + 2;
  elements.tabOverviewButton.hidden = !overflow && !manyTabs;
  overflow = elements.tabs.scrollWidth > elements.tabs.clientWidth + 2;
  elements.tabsScrollBack.hidden = !overflow;
  elements.tabsScrollForward.hidden = !overflow;
  elements.tabsScrollBack.disabled = !overflow || elements.tabs.scrollLeft <= 1;
  elements.tabsScrollForward.disabled = !overflow || elements.tabs.scrollLeft + elements.tabs.clientWidth >= elements.tabs.scrollWidth - 1;
  if (!overflow && !manyTabs && !elements.tabOverviewMenu.hidden) {
    closeHeaderMenus().catch((error) => showToast(formatError(error)));
  }
}

function renderTabs() {
  const previousScrollLeft = elements.tabs.scrollLeft;
  elements.tabs.replaceChildren();
  if (!state.isAgentWindow) {
    const homeTab = document.createElement("div");
    homeTab.className = `tab workspaceTab${state.activeSurface === "home" ? " active" : ""}`;
    homeTab.dataset.surface = "home";
    homeTab.setAttribute("role", "button");
    homeTab.tabIndex = 0;
    const homeIcon = document.createElement("span");
    homeIcon.className = "tabHomeIcon";
    homeIcon.textContent = "首";
    const homeLabel = document.createElement("span");
    homeLabel.className = "tabLabel";
    homeLabel.textContent = "主页";
    homeTab.append(homeIcon, homeLabel);
    homeTab.addEventListener("click", () => openHome().catch((error) => showToast(formatError(error))));
    elements.tabs.appendChild(homeTab);

    if (state.agentTabOpen || state.agentDetached) {
      const agentTab = document.createElement("div");
      agentTab.className = `tab workspaceTab${state.activeSurface === "agent" && !state.agentDetached ? " active" : ""}${state.agentDetached ? " detached" : ""}`;
      agentTab.dataset.surface = "agent";
      agentTab.setAttribute("role", "button");
      agentTab.tabIndex = 0;
      agentTab.draggable = true;
      agentTab.title = state.agentDetached ? "AI 创建正在独立窗口运行" : "拖出工作台可在独立窗口运行";
      const agentIcon = document.createElement("span");
      agentIcon.className = "tabAgentIcon";
      agentIcon.textContent = "AI";
      const agentLabel = document.createElement("span");
      agentLabel.className = "tabLabel";
      agentLabel.textContent = "AI 创建房间";
      const agentWindowButton = document.createElement("button");
      agentWindowButton.type = "button";
      agentWindowButton.className = "tabWindow";
      agentWindowButton.textContent = state.agentDetached ? "↙" : "↗";
      agentWindowButton.title = state.agentDetached ? "收回工作台" : "在独立窗口打开";
      agentWindowButton.draggable = false;
      agentWindowButton.addEventListener("click", (event) => {
        event.stopPropagation();
        (state.agentDetached ? dockAgentWorkspace() : detachAgentWorkspace()).catch((error) => showToast(formatError(error)));
      });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tabClose";
      close.textContent = "×";
      close.title = "关闭标签";
      close.draggable = false;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeAgentWorkspace().catch((error) => showToast(formatError(error)));
      });
      agentTab.append(agentIcon, agentLabel, agentWindowButton, close);
      agentTab.addEventListener("click", () => showGenerateDialog().catch((error) => showToast(formatError(error))));
      agentTab.addEventListener("dragstart", (event) => {
        agentTab.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-zhibian-agent-tab", "agent");
        event.dataTransfer.setData("text/plain", "AI 创建房间");
      });
      agentTab.addEventListener("dragend", () => {
        agentTab.classList.remove("dragging");
        if (!state.agentDetached) detachAgentWorkspace({ fromDrag: true }).catch((error) => showToast(formatError(error)));
      });
      elements.tabs.appendChild(agentTab);
    }
  }
  for (const roomId of state.tabs) {
    const room = roomById(roomId);
    if (!room) continue;
    const detached = state.detachedRoomIds.has(roomId);
    const tab = document.createElement("div");
    tab.className = `tab${state.activeSurface === "room" && state.activeRoomId === roomId ? " active" : ""}${detached ? " detached" : ""}`;
    tab.dataset.roomId = roomId;
    tab.setAttribute("role", "button");
    tab.tabIndex = 0;
    tab.draggable = true;
    tab.title = detached ? "这个房间正在独立窗口运行" : "拖出工作台可在独立窗口运行";
    const roomIcon = document.createElement("span");
    roomIcon.className = "tabRoomIcon";
    renderRoomIcon(roomIcon, room);
    const label = document.createElement("span");
    label.className = "tabLabel";
    label.textContent = room.name;
    const windowButton = document.createElement("button");
    windowButton.type = "button";
    windowButton.className = "tabWindow";
    windowButton.textContent = detached ? "↙" : "↗";
    windowButton.title = detached ? "收回工作台" : "在独立窗口打开";
    windowButton.draggable = false;
    windowButton.addEventListener("click", (event) => {
      event.stopPropagation();
      (detached ? dockRoom(roomId) : detachRoom(roomId)).catch((error) => showToast(formatError(error)));
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tabClose";
    close.textContent = "×";
    close.title = "关闭标签";
    close.draggable = false;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(roomId);
    });
    tab.append(roomIcon, label, windowButton, close);
    tab.addEventListener("click", () => openRoom(roomId));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openRoom(roomId);
    });
    tab.addEventListener("dragstart", (event) => {
      tab.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-zhibian-room-tab", roomId);
      event.dataTransfer.setData("text/plain", room.name);
    });
    tab.addEventListener("dragend", () => {
      tab.classList.remove("dragging");
      if (!detached) detachRoom(roomId, { fromDrag: true }).catch((error) => showToast(formatError(error)));
    });
    elements.tabs.appendChild(tab);
  }
  const hasActiveRoom = state.activeSurface === "room" && Boolean(state.activeRoomId);
  const hasActiveAgent = state.activeSurface === "agent" && !state.agentDetached;
  elements.detachButton.disabled = !hasActiveRoom && !hasActiveAgent;
  elements.detachButton.title = hasActiveAgent ? "把 AI 创建移到独立窗口" : "把当前房间移到独立窗口";
  elements.modifyButton.disabled = !hasActiveRoom || !isAiModifiable(roomById(state.activeRoomId));
  elements.detailsButton.disabled = !hasActiveRoom;
  elements.backupButton.disabled = !hasActiveRoom;
  elements.restoreButton.disabled = !hasActiveRoom;
  elements.exportButton.disabled = !hasActiveRoom;
  elements.uninstallButton.disabled = !hasActiveRoom;
  elements.headerMoreButton.disabled = !hasActiveRoom;
  if (!hasActiveRoom) {
    hideHeaderMoreMenu();
    state.headerOverlayRoomId = null;
  }
  elements.welcome.hidden = state.activeSurface !== "home";
  document.getElementById("roomStandby").hidden = state.activeSurface !== "room";
  document.getElementById("roomStandbyName").textContent = roomById(state.activeRoomId)?.name || "房间";
  renderTabOverview();
  requestAnimationFrame(() => {
    elements.tabs.scrollLeft = previousScrollLeft;
    elements.tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateTabOverflow();
  });
}

function editingProviderProfile() {
  return state.editingProviderId
    ? state.aiProfiles.find((profile) => profile.id === state.editingProviderId) || null
    : null;
}

function credentialSourceProfile() {
  return state.credentialSourceProfileId
    ? state.aiProfiles.find((profile) => profile.id === state.credentialSourceProfileId) || null
    : null;
}

function applyAiState(result) {
  state.provider = result?.activeProfile || null;
  state.aiProfiles = Array.isArray(result?.profiles) ? result.profiles : [];
  state.aiUtilityProfiles = result?.utilityProfiles && typeof result.utilityProfiles === "object" ? result.utilityProfiles : state.aiUtilityProfiles;
  if (state.editingProviderId && !state.aiProfiles.some((profile) => profile.id === state.editingProviderId)) {
    state.editingProviderId = state.provider?.id || null;
  }
  if (state.credentialSourceProfileId && !state.aiProfiles.some((profile) => profile.id === state.credentialSourceProfileId)) {
    state.credentialSourceProfileId = null;
  }
}

function providerConnectionKey(profile) {
  const providerId = profile?.providerId || "";
  return providerId === "custom-openai-compatible"
    ? providerId + "|" + (profile?.baseUrl || "")
    : providerId;
}

function resetProviderModelSelection() {
  state.providerModelContextKey = "";
  state.pendingProviderModelIds = new Set();
  state.providerModelQuery = "";
  elements.providerModelSearch.value = "";
  elements.customCatalogModelIds.value = "";
  elements.customModelContextWindow.value = 128000;
  elements.customModelSupportsImages.checked = false;
  elements.customModelSupportsAudio.checked = false;
  setFetchProviderModelsStatus("", false);
}

function setFetchProviderModelsStatus(message, isError) {
  elements.fetchProviderModelsStatus.textContent = message;
  elements.fetchProviderModelsStatus.classList.toggle("errorText", Boolean(isError && message));
}

async function fetchProviderModelsAction() {
  const provider = selectedProvider();
  if (!provider || provider.supportsModelFetch !== true) return;
  elements.fetchProviderModelsButton.disabled = true;
  setFetchProviderModelsStatus("正在从服务商获取模型列表……", false);
  try {
    const apiKey = elements.providerApiKey.value.trim();
    const result = await window.workbench.fetchProviderModels({
      providerId: provider.id,
      ...(apiKey ? { apiKey } : {})
    });
    state.remoteProviderModels.set(provider.id, new Set(result.models.map((model) => model.id)));
    const freshCount = result.models.filter((model) =>
      !provider.models.some((entry) => entry.id === model.id)
    ).length;
    setFetchProviderModelsStatus(`获取到 ${result.models.length} 个模型${freshCount ? `，其中 ${freshCount} 个不在本地目录` : "；均已在本地目录中"}`, false);
    renderProviderModelList(provider);
  } catch (error) {
    setFetchProviderModelsStatus(formatError(error), true);
  } finally {
    elements.fetchProviderModelsButton.disabled = provider.supportsModelFetch !== true;
  }
}

function renderProviderProfiles() {
  elements.providerProfileList.replaceChildren();
  const groups = new Map();
  for (const profile of state.aiProfiles) {
    const key = providerConnectionKey(profile);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(profile);
  }
  for (const profiles of groups.values()) {
    const sourceProfile = profiles.find((profile) => profile.hasSessionKey) || profiles[0];
    const connection = document.createElement("article");
    connection.className = "providerConnectionCard";
    connection.dataset.connectionKey = providerConnectionKey(sourceProfile);
    const header = document.createElement("div");
    header.className = "providerConnectionHeader";
    const identity = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = sourceProfile.name;
    const summary = document.createElement("small");
    summary.textContent = `${profiles.length} 个已配置模型 · ${profiles.filter(WorkbenchPresentation.canUseProfile).length} 个凭据就绪（不代表已验证连通）`;
    identity.append(title, summary);
    const connectionActions = document.createElement("div");
    const connected = document.createElement("span");
    connected.className = "providerDefaultBadge";
    const tested = profiles.filter(profile => profile.connectionTest).sort((a, b) => b.connectionTest.checkedAt.localeCompare(a.connectionTest.checkedAt))[0];
    connected.textContent = tested ? (tested.connectionTest.ok ? "部分模型已验证" : "最近验证失败") : profiles.some(profile => profile.hasSessionKey) ? "已配置 · 未验证" : "需要配置密钥";
    connected.title = tested ? `${tested.model} · ${new Date(tested.connectionTest.checkedAt).toLocaleString()} · 验证仅适用于该模型和本次会话，不代表其他模型均可用` : "此处表示本机配置状态，不代表 API 连通性或模型调用已验证；可在编辑连接中测试";
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "providerCardButton providerAddModelButton";
    manage.dataset.addProviderModel = sourceProfile.id;
    manage.textContent = "管理 / 添加模型";
    manage.addEventListener("click", () => startProviderModel(sourceProfile));
    connectionActions.append(connected, manage);
    header.append(identity, connectionActions);
    const models = document.createElement("div");
    models.className = "providerConnectionModels";
    for (const profile of profiles) {
      const card = document.createElement("article");
      card.className = "providerProfileCard" + (profile.isActive ? " active" : "") + (profile.id === state.editingProviderId ? " editing" : "");
      card.dataset.profileId = profile.id;
      const modelIdentity = document.createElement("div");
      const modelTitle = document.createElement("strong");
      modelTitle.textContent = profile.label;
      const details = document.createElement("small");
      details.textContent = `${profile.model}${profile.modelSource === "custom" ? "（目录外）" : ""} · ${WorkbenchPresentation.credentialStatus(profile)}`;
      modelIdentity.append(modelTitle, details);
      const actions = document.createElement("div");
      if (profile.isActive) {
        const badge = document.createElement("span");
        badge.className = "providerDefaultBadge";
        badge.textContent = "房间默认";
        actions.appendChild(badge);
      } else {
        const activate = document.createElement("button");
        activate.type = "button";
        activate.className = "providerCardButton";
        activate.textContent = "设为房间默认";
        activate.disabled = !WorkbenchPresentation.canUseProfile(profile);
        activate.addEventListener("click", () => setActiveProvider(profile.id));
        actions.appendChild(activate);
      }
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "providerCardButton";
      edit.textContent = WorkbenchPresentation.canUseProfile(profile) ? "编辑 / 测试" : "配置密钥";
      edit.addEventListener("click", () => startEditingProvider(profile));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "providerCardButton dangerText";
      remove.textContent = "删除";
      remove.addEventListener("click", () => deleteProvider(profile));
      actions.append(edit, remove);
      card.append(modelIdentity, actions);
      models.appendChild(card);
    }
    connection.append(header, models);
    elements.providerProfileList.appendChild(connection);
  }
  if (!state.aiProfiles.length) {
    const empty = document.createElement("div");
    empty.className = "providerProfilesEmpty";
    empty.textContent = "还没有连接任何 AI 提供商。点击“添加提供商”，填写一次凭据并选择要启用的模型。";
    elements.providerProfileList.appendChild(empty);
  }
}

function renderProviderChoices(preferredProviderId) {
  const query = state.providerQuery.trim().toLowerCase();
  const matchedProviders = state.aiProviders.filter((provider) => {
    if (!query) return true;
    return [
      provider.displayName,
      provider.name,
      provider.id,
      provider.description,
      provider.categoryLabel
    ].filter(Boolean).join(" ").toLowerCase().includes(query);
  });
  const groups = new Map();
  for (const provider of matchedProviders) {
    const label = provider.categoryLabel || "其他";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(provider);
  }
  elements.providerSelect.replaceChildren();
  elements.providerChoiceList.replaceChildren();
  for (const [label, providers] of groups) {
    const group = document.createElement("optgroup");
    group.label = label;
    const choiceGroup = document.createElement("section");
    choiceGroup.className = "providerChoiceGroup";
    const choiceHeading = document.createElement("strong");
    choiceHeading.className = "providerChoiceGroupLabel";
    choiceHeading.textContent = label;
    choiceGroup.appendChild(choiceHeading);
    for (const provider of providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      const modelCount = provider.id === "custom-openai-compatible" ? "手动填写模型" : `${provider.models.length} 个模型`;
      const stateLabel = provider.configurable === false ? " · 需额外配置" : "";
      option.textContent = `${provider.featured ? "推荐 · " : ""}${provider.displayName} · ${modelCount}${stateLabel}`;
      group.appendChild(option);
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "providerChoice";
      choice.dataset.providerChoice = provider.id;
      choice.classList.toggle("unavailable", provider.configurable === false);
      const identity = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = provider.displayName;
      const description = document.createElement("small");
      description.textContent = provider.configurationHint || provider.description || provider.id;
      identity.append(name, description);
      const meta = document.createElement("span");
      meta.className = "providerChoiceMeta";
      meta.textContent = provider.configurable === false ? "暂不可直接配置" : modelCount;
      choice.append(identity, meta);
      choice.addEventListener("click", () => selectProviderChoice(provider.id));
      choiceGroup.appendChild(choice);
    }
    elements.providerSelect.appendChild(group);
    elements.providerChoiceList.appendChild(choiceGroup);
  }
  if (!matchedProviders.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.disabled = true;
    empty.textContent = "没有匹配的 Pi Provider";
    elements.providerSelect.appendChild(empty);
    const choiceEmpty = document.createElement("div");
    choiceEmpty.className = "providerChoiceEmpty";
    choiceEmpty.textContent = "没有匹配的 Pi Provider，请更换搜索词。";
    elements.providerChoiceList.appendChild(choiceEmpty);
  }
  const nextProviderId = matchedProviders.some((provider) => provider.id === preferredProviderId)
    ? preferredProviderId
    : matchedProviders.find((provider) => provider.configurable !== false)?.id
      || matchedProviders[0]?.id
      || "";
  elements.providerSelect.value = nextProviderId;
  const selected = state.aiProviders.find((provider) => provider.id === nextProviderId);
  elements.providerPickerValue.textContent = selected
    ? `${selected.featured ? "推荐 · " : ""}${selected.displayName} · ${selected.id === "custom-openai-compatible" ? "自定义模型" : `${selected.models.length} 个模型`}`
    : "请选择提供商";
  for (const choice of elements.providerChoiceList.querySelectorAll("[data-provider-choice]")) {
    const isSelected = choice.dataset.providerChoice === nextProviderId;
    choice.classList.toggle("selected", isSelected);
    choice.setAttribute("aria-pressed", String(isSelected));
  }
  const nativeCount = state.aiProviders.filter((provider) => provider.source === "pi-builtin").length;
  const readyCount = state.aiProviders.filter((provider) => provider.source === "pi-builtin" && provider.configurable !== false).length;
  elements.providerCatalogSummary.textContent = query
    ? `匹配 ${matchedProviders.length} 个 · Pi 原生共 ${nativeCount} 个`
    : `Pi 原生 ${nativeCount} 个 · 当前可用 Key 直接配置 ${readyCount} 个 · 另有 1 个自定义入口`;
}

function setProviderPickerOpen(open, { focusChoice = true } = {}) {
  const canOpen = open && !elements.providerPickerButton.disabled;
  elements.providerChoiceList.hidden = !canOpen;
  elements.providerPickerButton.setAttribute("aria-expanded", String(canOpen));
  elements.providerPickerField.classList.toggle("open", canOpen);
  if (canOpen && focusChoice) {
    const selected = elements.providerChoiceList.querySelector(".providerChoice.selected:not(:disabled)")
      || elements.providerChoiceList.querySelector(".providerChoice:not(:disabled)");
    selected?.focus({ preventScroll: true });
  }
}

function selectProviderChoice(providerId) {
  if (!state.aiProviders.some((provider) => provider.id === providerId)) return;
  elements.providerSelect.value = providerId;
  renderProviderChoices(providerId);
  setProviderPickerOpen(false);
  elements.providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
  elements.providerPickerButton.focus({ preventScroll: true });
}

function renderProvider() {
  const activeProfile = state.provider;
  const profile = editingProviderProfile();
  const credentialSource = credentialSourceProfile();
  elements.providerDot.classList.toggle("online", WorkbenchPresentation.canUseProfile(activeProfile));
  const keySummary = WorkbenchPresentation.credentialStatus(activeProfile);
  const connectionCount = new Set(state.aiProfiles.map((entry) => `${entry.providerId}|${entry.baseUrl}`)).size;
  elements.providerSummary.textContent = activeProfile
    ? `${activeProfile.model} · ${keySummary} · ${state.aiProfiles.length} 个模型 / ${connectionCount} 个连接`
    : "尚未配置";
  renderProviderProfiles();
  updateSettingsSummary();
  elements.providerEditorPanel.hidden = !state.providerEditorOpen;
  elements.providerDialog.classList.toggle("editingProvider", state.providerEditorOpen);
  elements.providerEditorFields.disabled = !state.providerEditorOpen;
  if (!state.providerEditorOpen) {
    if (elements.generateDialog.open) renderAgentHeader();
    return;
  }
  elements.providerEditorTitle.textContent = profile
    ? `编辑模型：${profile.label}`
    : credentialSource
      ? `管理 ${credentialSource.name} / 添加模型`
      : "添加 AI 提供商";
  elements.providerProfileLabel.value = profile?.label || "";
  const selectedProviderId = profile?.providerId || credentialSource?.providerId || elements.providerSelect.value || state.aiProviders.find((provider) => provider.featured)?.id || "custom-openai-compatible";
  renderProviderChoices(selectedProviderId);
  elements.providerSelect.disabled = Boolean(credentialSource && !profile);
  elements.providerPickerButton.disabled = elements.providerSelect.disabled;
  if (elements.providerPickerButton.disabled) setProviderPickerOpen(false);
  elements.clearKeyButton.hidden = !profile;
  elements.saveProviderButton.textContent = profile ? "保存修改" : "启用所选模型";
  elements.testProviderButton.textContent = profile ? "保存并测试" : "启用并测试首个";
  renderProviderFields(profile?.model);
  elements.providerApiKey.value = "";
  const secureStorageAvailable = profile?.secureStorageAvailable ?? credentialSource?.secureStorageAvailable ?? state.aiCapabilities?.secureStorageAvailable ?? false;
  elements.providerForm.elements.rememberKey.checked = Boolean(profile?.hasStoredKey || credentialSource?.hasStoredKey);
  elements.providerForm.elements.rememberKey.disabled = !secureStorageAvailable;
  elements.secureStorageSummary.textContent = secureStorageAvailable
    ? "由当前 Windows 用户的系统保护机制加密"
    : "当前环境不可用，将只保留在本次会话";
  if (elements.generateDialog.open) renderAgentHeader();
}

function selectedProvider() {
  return state.aiProviders.find((provider) => provider.id === elements.providerSelect.value) ?? null;
}

function formatTokenCount(value) {
  if (!Number.isFinite(value)) return "未知上下文";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M 上下文`;
  return `${Math.round(value / 1000)}K 上下文`;
}

function updateModelSummary() {
  const provider = selectedProvider();
  const model = provider?.models.find((entry) => entry.id === elements.modelSelect.value);
  if (!model) {
    elements.modelSummary.textContent = "";
    return;
  }
  const capabilities = [formatTokenCount(model.contextWindow)];
  if (model.reasoning) capabilities.push("支持推理");
  if (model.input.includes("image")) capabilities.push("支持图片");
  elements.modelSummary.textContent = `${model.name} · ${capabilities.join(" · ")} · 来自 Pi 模型目录`;
  elements.providerEndpoint.textContent = model.baseUrl || provider.baseUrl || "端点由 Pi Provider 在运行时确定";
}

function configuredModelIds(provider) {
  return new Set(state.aiProfiles
    .filter((profile) => profile.providerId === provider.id)
    .map((profile) => profile.model));
}

function manualCatalogModelIds() {
  return [...new Set(elements.customCatalogModelIds.value
    .split(/[\r\n,，]+/)
    .map((value) => value.trim())
    .filter(Boolean))];
}

function currentCustomModelContextWindow() {
  const value = Number(elements.customModelContextWindow.value);
  return Number.isSafeInteger(value) && value > 0 ? value : 128000;
}

function customCatalogModelCapabilities() {
  return {
    contextWindow: currentCustomModelContextWindow(),
    input: [
      "text",
      ...(elements.customModelSupportsImages.checked ? ["image"] : []),
      ...(elements.customModelSupportsAudio.checked ? ["audio"] : [])
    ]
  };
}

function catalogExtraModels(provider) {
  const catalogIds = new Set(provider.models.map((model) => model.id));
  const capabilities = customCatalogModelCapabilities();
  const extras = [];
  const push = (modelId, source) => {
    if (catalogIds.has(modelId) || extras.some((model) => model.id === modelId)) return;
    extras.push({
      id: modelId,
      name: modelId,
      reasoning: false,
      input: [...capabilities.input],
      contextWindow: capabilities.contextWindow,
      source
    });
  };
  for (const modelId of manualCatalogModelIds()) push(modelId, "manual");
  for (const modelId of state.remoteProviderModels.get(provider.id) || []) push(modelId, "remote");
  return extras;
}

function renderProviderModelList(provider) {
  elements.providerModelList.replaceChildren();
  const configured = configuredModelIds(provider);
  const providerUnavailable = provider.configurable === false;
  const contextKey = [
    provider.id,
    state.editingProviderId || "",
    state.credentialSourceProfileId || "new"
  ].join("|");
  if (state.providerModelContextKey !== contextKey) {
    state.providerModelContextKey = contextKey;
    state.pendingProviderModelIds = new Set();
    const suggested = provider.models.find((model) => model.id === provider.defaultModel && !configured.has(model.id))
      || provider.models.find((model) => !configured.has(model.id));
    if (suggested) state.pendingProviderModelIds.add(suggested.id);
  }
  const query = state.providerModelQuery.trim().toLowerCase();
  const extraModels = catalogExtraModels(provider);
  const allModels = [...provider.models, ...extraModels];
  const visibleModels = allModels.filter((model) =>
    !query || `${model.name} ${model.id}`.toLowerCase().includes(query)
  );
  for (const model of visibleModels) {
    const alreadyEnabled = configured.has(model.id);
    const option = document.createElement("label");
    option.className = "providerModelOption" + (alreadyEnabled ? " configured" : "");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = alreadyEnabled || state.pendingProviderModelIds.has(model.id);
    checkbox.disabled = alreadyEnabled || providerUnavailable;
    checkbox.dataset.providerModelId = model.id;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.pendingProviderModelIds.add(model.id);
      else state.pendingProviderModelIds.delete(model.id);
      renderProviderModelList(provider);
    });
    const identity = document.createElement("span");
    identity.className = "providerModelIdentity";
    const name = document.createElement("strong");
    name.textContent = model.name;
    const id = document.createElement("code");
    id.textContent = model.id;
    identity.append(name, id);
    const tags = document.createElement("span");
    tags.className = "providerModelTags";
    const tagValues = [
      formatTokenCount(model.contextWindow),
      ...(model.reasoning ? ["推理"] : []),
      ...(model.input.includes("image") ? ["图片"] : []),
      ...(model.source === "remote" ? ["服务商返回"] : []),
      ...(model.source === "manual" ? ["手动添加"] : []),
      ...(alreadyEnabled ? ["已启用"] : [])
    ];
    for (const value of tagValues) {
      const tag = document.createElement("small");
      tag.textContent = value;
      tags.appendChild(tag);
    }
    option.append(checkbox, identity, tags);
    elements.providerModelList.appendChild(option);
  }
  if (!visibleModels.length) {
    const empty = document.createElement("div");
    empty.className = "providerModelsEmpty";
    empty.textContent = provider.limitation || "没有匹配的模型";
    elements.providerModelList.appendChild(empty);
  }
  const availableCount = providerUnavailable ? 0 : allModels.filter((model) => !configured.has(model.id)).length;
  const selectedCount = [...state.pendingProviderModelIds].filter((modelId) => !configured.has(modelId)).length;
  elements.providerModelCount.textContent = providerUnavailable
    ? `Pi 目录含 ${provider.models.length} 个模型 · ${provider.limitation}`
    : `已启用 ${configured.size} · 本次选择 ${selectedCount} · 尚可添加 ${availableCount}`;
  elements.selectAllProviderModels.disabled = providerUnavailable || availableCount === 0;
  elements.clearProviderModels.disabled = providerUnavailable || selectedCount === 0;
}

function renderProviderFields(preferredModel) {
  const provider = selectedProvider();
  if (!provider) return;
  const isCustom = provider.id === "custom-openai-compatible";
  const providerUnavailable = provider.configurable === false;
  const profile = editingProviderProfile();
  const credentialSource = credentialSourceProfile();
  const profileMatches = profile?.providerId === provider.id;
  const sourceMatches = !profile && credentialSource?.providerId === provider.id;
  elements.providerMetaName.textContent = provider.displayName;
  elements.providerDescription.textContent = [
    provider.description,
    provider.configurationHint,
    provider.limitation
  ].filter(Boolean).join(" ");
  elements.providerEndpoint.textContent = provider.baseUrl || (provider.models.length ? "端点随所选模型自动选择" : "暂无可用端点");
  elements.providerBadge.textContent = provider.source === "pi-builtin"
    ? `Pi 原生 · ${provider.supportsApiKey ? "API Key" : "OAuth"}`
    : "高级";
  elements.customProviderFields.hidden = !isCustom;
  const editingCustomCatalogModel = Boolean(profileMatches && profile?.modelSource === "custom");
  elements.modelSelectField.hidden = isCustom || !profile || editingCustomCatalogModel;
  elements.providerModelPickerField.hidden = isCustom || Boolean(profile);
  elements.customCatalogModelFields.hidden = isCustom || providerUnavailable || Boolean(profile && !editingCustomCatalogModel);
  elements.providerFetchRow.hidden = isCustom || providerUnavailable || Boolean(profile);
  elements.fetchProviderModelsButton.disabled = providerUnavailable || provider.supportsModelFetch !== true;
  if (!elements.providerFetchRow.hidden && provider.supportsModelFetch !== true) {
    setFetchProviderModelsStatus("该提供商暂不支持自动获取；可手动添加模型 ID", false);
  }
  if (!elements.customCatalogModelFields.hidden) {
    // 仅在刚进入编辑（输入框为空，上下文重置后）时预填，避免中途重渲染覆盖用户修改
    if (editingCustomCatalogModel && elements.customCatalogModelIds.value === "") {
      elements.customCatalogModelIds.value = profile.model;
      const capabilities = profile.modelCapabilities || { contextWindow: 128000, input: ["text"] };
      elements.customModelContextWindow.value = capabilities.contextWindow;
      elements.customModelSupportsImages.checked = capabilities.input.includes("image");
      elements.customModelSupportsAudio.checked = capabilities.input.includes("audio");
    }
  }
  elements.modelSelect.disabled = isCustom || !profile || providerUnavailable;
  elements.customProviderName.disabled = !isCustom;
  elements.customBaseUrl.disabled = !isCustom;
  elements.customModel.disabled = !isCustom;
  elements.customProviderName.required = isCustom;
  elements.customBaseUrl.required = isCustom;
  elements.customModel.required = isCustom;
  if (isCustom) {
    elements.customProviderName.value = profileMatches ? profile.name : sourceMatches ? credentialSource.name : "OpenAI-compatible";
    elements.customBaseUrl.value = profileMatches ? profile.baseUrl : sourceMatches ? credentialSource.baseUrl : "";
    elements.customModel.value = profileMatches ? profile.model : "";
    elements.customProviderName.disabled = sourceMatches;
    elements.customBaseUrl.disabled = sourceMatches;
  } else {
    elements.modelSelect.replaceChildren();
    for (const model of provider.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name === model.id ? model.id : `${model.name} · ${model.id}`;
      elements.modelSelect.appendChild(option);
    }
    const requestedModel = profileMatches ? preferredModel : undefined;
    elements.modelSelect.value = provider.models.some((model) => model.id === requestedModel)
      ? requestedModel
      : provider.defaultModel || provider.models[0]?.id || "";
    updateModelSummary();
    if (!profile) renderProviderModelList(provider);
  }
  elements.credentialReuseNotice.hidden = !sourceMatches || !credentialSource.hasSessionKey;
  elements.credentialReuseText.textContent = sourceMatches
    ? `将复用“${credentialSource.label}”的 ${credentialSource.hasStoredKey ? "系统安全存储密钥" : "会话密钥"}；明文不会返回此页面。`
    : "";
  const hasCurrentKey = (profileMatches && Boolean(profile?.hasSessionKey)) ||
    (sourceMatches && Boolean(credentialSource?.hasSessionKey));
  elements.providerApiKey.disabled = providerUnavailable;
  elements.providerApiKey.required = !providerUnavailable && !hasCurrentKey && !isCustom;
  elements.providerApiKey.placeholder = sourceMatches && hasCurrentKey
    ? "无需填写；将沿用现有安全连接"
    : hasCurrentKey
      ? "已有密钥；留空表示继续使用"
      : isCustom
        ? "无鉴权的内网服务可以留空"
        : `粘贴 ${provider.apiKeyLabel || "所选提供商的 API Key"}`;
  elements.apiKeyHint.textContent = providerUnavailable
    ? provider.limitation
    : sourceMatches && hasCurrentKey
    ? "也可以输入一个新 Key，覆盖本次复用"
    : hasCurrentKey
    ? `${profile?.hasStoredKey ? "系统安全存储中已有密钥" : "当前会话已有密钥"}，留空表示继续使用`
    : `${provider.apiKeyLabel || "API Key"}；不会写入房间、Git 或普通配置文件`;
  elements.providerModelSearch.disabled = providerUnavailable;
  elements.saveProviderButton.disabled = providerUnavailable;
  elements.testProviderButton.disabled = providerUnavailable;
}

function providerFormPayload() {
  const provider = selectedProvider();
  if (!provider) throw new Error("请选择 AI 提供商");
  const editingProfile = editingProviderProfile();
  const isCustomProvider = provider.id === "custom-openai-compatible";
  const editingCatalogCustomModel = !isCustomProvider && editingProfile?.modelSource === "custom";
  const payload = {
    ...(state.editingProviderId ? { id: state.editingProviderId } : {}),
    label: elements.providerProfileLabel.value,
    providerId: provider.id,
    model: isCustomProvider
      ? elements.customModel.value
      : editingCatalogCustomModel
        ? elements.customCatalogModelIds.value.trim()
        : elements.modelSelect.value,
    apiKey: elements.providerApiKey.value,
    rememberKey: elements.providerForm.elements.rememberKey.checked,
    ...(editingProfile ? { activate: editingProfile.isActive } : {}),
    ...(editingCatalogCustomModel ? { modelSource: "custom", modelCapabilities: customCatalogModelCapabilities() } : {}),
    ...(state.credentialSourceProfileId ? {
      credentialSourceProfileId: state.credentialSourceProfileId,
      activate: false
    } : {})
  };
  if (isCustomProvider) {
    payload.name = elements.customProviderName.value;
    payload.baseUrl = elements.customBaseUrl.value;
  }
  return payload;
}

function customModelIds() {
  return [...new Set(elements.customModel.value
    .split(/[\r\n,，]+/)
    .map((value) => value.trim())
    .filter(Boolean))];
}

function selectedProviderModelIds(provider) {
  const editingProfile = editingProviderProfile();
  if (editingProfile) {
    if (editingProfile.providerId === "custom-openai-compatible") return [elements.customModel.value.trim()].filter(Boolean);
    if (editingProfile.modelSource === "custom") return [elements.customCatalogModelIds.value.trim()].filter(Boolean);
    return [elements.modelSelect.value].filter(Boolean);
  }
  if (provider.id === "custom-openai-compatible") return customModelIds();
  const configured = configuredModelIds(provider);
  const extraIds = new Set(catalogExtraModels(provider).map((model) => model.id));
  return [...state.pendingProviderModelIds].filter((modelId) =>
    (provider.models.some((model) => model.id === modelId) || extraIds.has(modelId)) && !configured.has(modelId)
  );
}

function applySavedProvider(saved) {
  const remainingProfiles = state.aiProfiles.filter((profile) => profile.id !== saved.id);
  state.aiProfiles = saved.isActive
    ? [...remainingProfiles.map((profile) => ({ ...profile, isActive: false })), saved]
    : [...remainingProfiles, saved];
  if (saved.isActive) state.provider = saved;
}

function renderPermissionOptions(root, items, selectedKeys, options = {}) {
  const selected = new Set(selectedKeys);
  const showGrantState = options.showGrantState === true;
  const roomNetworkEnabled = options.networkPolicy?.roomNetworkEnabled === true;
  root.replaceChildren();
  for (const item of items) {
    const label = document.createElement("label");
    label.className = "permissionOption";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.permissionKey = item.key;
    checkbox.checked = selected.has(item.key);
    const initiallyGranted = checkbox.checked;
    checkbox.disabled = item.required;
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = `${item.title}${item.required ? "（必需）" : ""}`;
    const key = document.createElement("code");
    key.className = "permissionKey";
    key.textContent = item.key;
    const description = document.createElement("small");
    description.textContent = item.description;
    const badges = document.createElement("span");
    badges.className = "permissionBadges";
    const risk = document.createElement("span");
    risk.className = `permissionRisk ${item.risk}`;
    risk.textContent = RISK_LABELS[item.risk] ?? item.risk;
    badges.appendChild(risk);
    if (showGrantState) {
      const grantState = document.createElement("span");
      grantState.className = "permissionGrantState";
      const refreshGrantState = (notify = true) => {
        const granted = checkbox.checked;
        label.classList.toggle("granted", granted);
        label.classList.toggle("denied", !granted);
        label.dataset.grantState = granted ? "granted" : "denied";
        grantState.className = "permissionGrantState";
        if (item.required) {
          grantState.textContent = "必需并已授权";
          grantState.classList.add("required");
        } else if (granted !== initiallyGranted) {
          grantState.textContent = granted ? "保存后授权" : "保存后撤销";
          grantState.classList.add("pending");
        } else if (!granted) {
          grantState.textContent = "未授权";
          grantState.classList.add("denied");
        } else if (item.domain === "network" && !roomNetworkEnabled) {
          grantState.textContent = "已授权 · 总开关关闭";
          grantState.classList.add("blocked");
        } else {
          grantState.textContent = "已授权";
          grantState.classList.add("granted");
        }
        if (notify) options.onSelectionChanged?.();
      };
      checkbox.addEventListener("change", () => refreshGrantState(true));
      refreshGrantState(false);
      badges.prepend(grantState);
    }
    text.append(title, key, description);
    label.append(checkbox, text, badges);
    root.appendChild(label);
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "emptyRooms";
    empty.textContent = "这个房间没有申请额外能力";
    root.appendChild(empty);
  }
}

function renderDetailsPermissionSummary(items) {
  const granted = new Set(selectedPermissionKeys(elements.detailsPermissions));
  const requestedCount = items.length;
  const grantedCount = items.filter((item) => granted.has(item.key)).length;
  const deniedCount = requestedCount - grantedCount;
  elements.detailsPermissionSummary.replaceChildren();
  for (const [label, value, tone] of [
    ["申请权限", requestedCount, "requested"],
    ["当前勾选", grantedCount, "granted"],
    ["未授权", deniedCount, deniedCount ? "denied" : "clear"]
  ]) {
    const card = document.createElement("div");
    card.className = `permissionOverviewItem ${tone}`;
    const number = document.createElement("strong");
    number.textContent = String(value);
    const caption = document.createElement("small");
    caption.textContent = label;
    card.append(number, caption);
    elements.detailsPermissionSummary.appendChild(card);
  }
  if (items.some((item) => item.domain === "network")) {
    const note = document.createElement("p");
    note.className = "permissionPolicyNote";
    note.textContent = state.networkPolicy?.roomNetworkEnabled
      ? "主工作台当前允许已授权房间联网。"
      : "主工作台当前关闭房间联网；即使勾选网络权限也不会发出请求。";
    elements.detailsPermissionSummary.appendChild(note);
  }
}

function renderNetworkPolicy() {
  const enabled = state.networkPolicy?.roomNetworkEnabled === true;
  elements.roomNetworkEnabled.checked = enabled;
  elements.networkDot.classList.toggle("online", enabled);
  elements.networkSummary.textContent = enabled ? "房间与开发 Agent 可联网" : "联网已关闭";
  updateSettingsSummary();
  elements.networkPolicySummary.classList.toggle("enabled", enabled);
  const title = elements.networkPolicySummary.querySelector("strong");
  const detail = elements.networkPolicySummary.querySelector("small");
  title.textContent = enabled ? "联网已开启" : "联网已关闭";
  detail.textContent = enabled
    ? "房间可按授权联网；AI 创建房间可访问互联网、内网和 JavaScript 网页"
    : "房间网络与 AI 创建房间的网页研究均不可用";
}

function renderCredentials() {
  elements.credentialList.replaceChildren();
  for (const credential of state.credentials) {
    const card = document.createElement("div"); card.className = "credentialItem";
    const text = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = credential.label || credential.alias;
    const details = document.createElement("small"); details.textContent = `${credential.alias} · ${credential.origin} · ${credential.headerName} · ${credential.available ? "可用" : "需重新输入"}`;
    text.append(title, details);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger"; remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try { await window.workbench.deleteCredential(credential.alias); state.credentials = await window.workbench.listCredentials(); renderCredentials(); }
      catch (error) { setInlineStatus(elements.networkStatus, formatError(error), true); remove.disabled = false; }
    });
    card.append(text, remove); elements.credentialList.appendChild(card);
  }
  if (!state.credentials.length) {
    const empty = document.createElement("div"); empty.className = "emptyRooms"; empty.textContent = "尚未配置命名凭据"; elements.credentialList.appendChild(empty);
  }
}

async function saveNamedCredential() {
  elements.saveCredentialButton.disabled = true;
  try {
    await window.workbench.saveCredential({ alias: elements.credentialAlias.value.trim(), label: elements.credentialLabel.value.trim(), origin: elements.credentialOrigin.value.trim(), headerName: elements.credentialHeaderName.value.trim(), prefix: elements.credentialPrefix.value, value: elements.credentialValue.value, remember: elements.credentialRemember.checked });
    elements.credentialValue.value = "";
    state.credentials = await window.workbench.listCredentials();
    renderCredentials();
    setInlineStatus(elements.networkStatus, "凭据已保存；房间仍需同时获得凭据别名和精确服务源权限。", false);
  } catch (error) { setInlineStatus(elements.networkStatus, formatError(error), true); }
  finally { elements.saveCredentialButton.disabled = false; }
}

async function showNetworkDialog() {
  await hideRoomForModal();
  renderNetworkPolicy();
  state.credentials = await window.workbench.listCredentials();
  elements.credentialRemember.disabled = state.aiCapabilities?.secureStorageAvailable !== true;
  elements.credentialRemember.checked = state.aiCapabilities?.secureStorageAvailable === true;
  renderCredentials();
  setInlineStatus(elements.networkStatus, "AI 模型 API 始终按 AI 能力中心配置连接，不受此开关影响。", false);
  elements.networkDialog.showModal();
}

async function saveNetworkPolicy(event) {
  event.preventDefault();
  elements.saveNetworkButton.disabled = true;
  try {
    state.networkPolicy = await window.workbench.setRoomNetworkEnabled(elements.roomNetworkEnabled.checked);
    renderNetworkPolicy();
    elements.networkDialog.close();
    showToast(state.networkPolicy.roomNetworkEnabled ? "已允许房间与开发 Agent 联网" : "已关闭房间网络与网页研究");
  } catch (error) {
    setInlineStatus(elements.networkStatus, formatError(error), true);
  } finally {
    elements.saveNetworkButton.disabled = false;
  }
}

function selectedPermissionKeys(root) {
  return [...root.querySelectorAll("input[data-permission-key]:checked")].map((input) => input.dataset.permissionKey);
}

async function openHome() {
  if (state.isAgentWindow) return;
  await window.workbench.hideRoom();
  if (elements.generateDialog.open) elements.generateDialog.close();
  state.activeRoomId = null;
  state.activeSurface = "home";
  renderRooms();
  renderTabs();
}

async function syncViewport() {
  if (state.activeSurface !== "room" || !state.activeRoomId) return;
  const rect = elements.viewport.getBoundingClientRect();
  await window.workbench.setViewport({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

async function openRoom(roomId) {
  try {
    if (state.isAgentWindow) {
      await window.workbench.requestOpenRoom(roomId);
      return;
    }
    if (!state.tabs.includes(roomId)) state.tabs.push(roomId);
    if (state.detachedRoomIds.has(roomId)) {
      await window.workbench.openRoom(roomId);
      renderRooms();
      renderTabs();
      return;
    }
    if (elements.generateDialog.open) elements.generateDialog.close();
    const rect = elements.viewport.getBoundingClientRect();
    await window.workbench.setViewport({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    const result = await window.workbench.openRoom(roomId);
    if (result.windowMode === "detached") {
      state.detachedRoomIds.add(roomId);
      renderRooms();
      renderTabs();
      return;
    }
    state.activeRoomId = roomId;
    state.activeSurface = "room";
    state.detachedRoomIds.delete(roomId);
    renderRooms();
    renderTabs();
  } catch (error) {
    showToast(formatError(error));
  }
}

async function detachRoom(roomId, { fromDrag = false } = {}) {
  const wasActive = state.activeRoomId === roomId;
  const previousIndex = state.tabs.indexOf(roomId);
  const result = await window.workbench.detachRoom(roomId, { force: !fromDrag, fromDrag });
  if (result.mode !== "detached") return result;
  state.detachedRoomIds.add(roomId);
  if (wasActive) {
    state.activeRoomId = null;
    const attachedTabs = state.tabs.filter((id) => id !== roomId && !state.detachedRoomIds.has(id));
    const next = attachedTabs[Math.min(Math.max(previousIndex, 0), Math.max(0, attachedTabs.length - 1))];
    if (next) await openRoom(next);
    else await openHome();
  }
  renderRooms();
  renderTabs();
  showToast(`“${roomById(roomId)?.name || "房间"}”已移到独立窗口`);
  // Opening the replacement tab can focus its native view. Activate the detached window last.
  await window.workbench.focusRoomWindow(roomId);
  return result;
}

async function dockRoom(roomId) {
  const result = await window.workbench.dockRoom(roomId);
  if (result.mode !== "attached") return result;
  state.detachedRoomIds.delete(roomId);
  state.activeRoomId = roomId;
  state.activeSurface = "room";
  renderRooms();
  renderTabs();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await syncViewport();
  showToast(`“${roomById(roomId)?.name || "房间"}”已收回工作台`);
  return result;
}

function applyRoomWindowState(payload) {
  if (state.isAgentWindow) return;
  if (!payload?.roomId) return;
  if (payload.mode === "detached") {
    state.detachedRoomIds.add(payload.roomId);
    if (state.activeRoomId === payload.roomId) state.activeRoomId = null;
  } else if (payload.mode === "attached") {
    state.detachedRoomIds.delete(payload.roomId);
    state.activeRoomId = payload.roomId;
    state.activeSurface = "room";
  } else if (payload.mode === "closed") {
    state.detachedRoomIds.delete(payload.roomId);
    if (state.activeRoomId === payload.roomId) state.activeRoomId = null;
  }
  renderRooms();
  renderTabs();
  if (payload.mode === "attached") requestAnimationFrame(() => syncViewport().catch(() => {}));
}

async function closeTab(roomId) {
  await window.workbench.closeRoom(roomId);
  const index = state.tabs.indexOf(roomId);
  state.tabs = state.tabs.filter((id) => id !== roomId);
  if (state.activeRoomId === roomId) {
    state.activeRoomId = null;
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    if (next) await openRoom(next);
    else await openHome();
  }
  renderRooms();
  renderTabs();
}

function renderExamples() {
  elements.examplesGrid.replaceChildren();
  for (const [index, example] of state.examples.entries()) {
    const card = document.createElement("article");
    card.className = "exampleCard";
    const icon = document.createElement("div");
    icon.className = `exampleIcon tone-${index % 5}`;
    icon.textContent = example.icon;
    const content = document.createElement("div");
    content.className = "exampleContent";
    const titleRow = document.createElement("div");
    titleRow.className = "exampleTitleRow";
    const title = document.createElement("h3");
    title.textContent = example.name;
    const install = document.createElement("button");
    install.type = "button";
    install.className = "exampleInstall";
    install.textContent = example.installedVersion ? (example.updateAvailable ? "查看更新" : "查看 / 重新安装") : "安装并打开";
    install.addEventListener("click", () => installExample(example.id, install));
    titleRow.append(title, install);
    const description = document.createElement("p");
    description.className = "exampleDescription";
    description.textContent = `${example.description}\n内置 v${example.version || "—"}${example.installedVersion ? ` · 已安装 v${example.installedVersion}` : " · 尚未安装"}${example.modified ? " · 本机版本可能已修改，请先导出备份再决定是否替换程序" : ""}`;
    const capabilities = document.createElement("div");
    capabilities.className = "exampleCapabilities";
    for (const capability of example.capabilities) {
      const tag = document.createElement("span");
      tag.textContent = capability;
      capabilities.appendChild(tag);
    }
    content.append(titleRow, description, capabilities);
    card.append(icon, content);
    elements.examplesGrid.appendChild(card);
  }
}

async function showExamplesDialog() {
  try {
    await hideRoomForModal();
    await refreshExamples();
    renderExamples();
    setInlineStatus(elements.examplesStatus, `${state.examples.length} 个示例已内置，可完全离线安装。`, false);
    elements.examplesDialog.showModal();
  } catch (error) {
    showToast(formatError(error));
    await restoreActiveRoomAfterDialog();
  }
}

async function installExample(exampleId, button = null) {
  if (button) button.disabled = true;
  try {
    const example = state.examples.find(item => item.id === exampleId);
    if (example && roomById(example.roomId)) {
      const inspection = await window.workbench.inspectExample(exampleId);
      // Keep the catalog behind the inspection so its close handler cannot raise the room over it.
      renderImportInspection(inspection);
      return;
    }
    const room = await window.workbench.installExample(exampleId);
    if (elements.examplesDialog.open) elements.examplesDialog.close();
    showToast(`已安装“${room.name}”`);
    await openRoom(room.id);
  } catch (error) {
    if (elements.examplesDialog.open) setInlineStatus(elements.examplesStatus, formatError(error), true);
    else showToast(formatError(error));
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshExamples() {
  state.examples = await window.workbench.listExamples();
  const updates = state.examples.filter(item => item.updateAvailable);
  const notice = document.getElementById("exampleUpdateNotice");
  notice.hidden = !updates.length;
  notice.textContent = `${updates.length} 个内置房间可更新 · 查看版本与数据保留说明`;
}

function renderImportInspection(inspection) {
  state.pendingImport = inspection;
  renderRoomIcon(elements.importRoomIcon, inspection.room, { dataUrl: inspection.room.iconDataUrl });
  elements.importRoomName.textContent = inspection.room.name;
  elements.importRoomIdentity.textContent = `${inspection.room.id} · v${inspection.room.version} · Room SDK ${inspection.room.runtime.roomSdk}`;
  const publisher = inspection.room.publisher;
  elements.importPublisher.textContent = publisher
    ? `发布者声明：${publisher.name}（${publisher.id}）· ${TRUST_LABELS[inspection.trust] ?? inspection.trust}`
    : `未声明发布者 · ${TRUST_LABELS[inspection.trust] ?? inspection.trust}`;
  elements.importRiskBadge.className = `riskBadge ${inspection.riskLevel}`;
  elements.importRiskBadge.textContent = RISK_LABELS[inspection.riskLevel];

  const notices = WorkbenchPresentation.importNotices(inspection);
  elements.importVersionNotice.hidden = false;
  elements.importVersionNotice.textContent = notices.program;
  elements.importDataNotice.hidden = inspection.transfer?.kind !== "app-and-data";
  elements.importDataNotice.textContent = inspection.transfer?.kind === "app-and-data"
    ? inspection.transfer.protected
      ? `此 .room 包含 ${formatBytes(inspection.transfer.data.bytes)} 业务数据，已通过密码解锁。${notices.data}`
      : `此 .room 包含 ${formatBytes(inspection.transfer.data.bytes)} 业务数据，未设置密码。${notices.data}`
    : "";

  elements.importRisks.replaceChildren();
  for (const risk of inspection.risks) {
    const item = document.createElement("div");
    item.className = `riskItem ${risk.level}`;
    item.textContent = risk.message;
    elements.importRisks.appendChild(item);
  }
  renderPermissionOptions(elements.importPermissions, inspection.permissions, inspection.defaultSelectedKeys);

  const details = [
    ["来源", SOURCE_LABELS[inspection.source] ?? inspection.source],
    ["签名", inspection.signature.status === "missing" ? "无签名" : "存在但尚未验证"],
    ["压缩包", formatBytes(inspection.package.bytes)],
    ...(inspection.transfer ? [
      ["分享内容", inspection.transfer.kind === "app-and-data" ? "应用和数据" : "仅应用"],
      ["密码保护", inspection.transfer.protected ? `已启用 · ${inspection.transfer.encryption}` : "未设置"],
      ...(inspection.transfer.data ? [["随包数据", formatBytes(inspection.transfer.data.bytes)]] : [])
    ] : []),
    ["解包后", formatBytes(inspection.package.unpackedBytes)],
    ["文件", `${inspection.package.verifiedFiles} 个已校验文件 / ${inspection.package.entryCount} 个 ZIP 条目`],
    ["跨平台", inspection.package.portability?.status === "portable"
      ? "通过 Windows x64 / Linux x64 房间合同检查"
      : "未提供可移植性结论"],
    ["官方模块", inspection.room.hostModules.length
      ? inspection.room.hostModules.map((moduleId) => state.roomModules.find((item) => item.id === moduleId)?.name ?? moduleId).join("、")
      : "无"],
    ["随房间依赖", inspection.room.embeddedDependencies.length
      ? inspection.room.embeddedDependencies.map((dependency) =>
        `${dependency.package}@${dependency.version}（${dependency.license}，${dependency.fileCount} 个文件，${formatBytes(dependency.bytes)}，内容 SHA-256 ${dependency.contentSha256}）`
      ).join("、")
      : "无"],
    ["SHA-256", inspection.package.sha256]
  ];
  elements.importPackageDetails.replaceChildren();
  for (const [name, value] of details) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = name;
    description.textContent = value;
    elements.importPackageDetails.append(term, description);
  }
  setInlineStatus(
    elements.importStatus,
    inspection.transfer?.kind === "app-and-data"
      ? "应用完整性、数据哈希、SQLite 快照与跨平台合同检查已通过。确认后将安装应用并恢复随包数据。"
      : "完整性与跨平台房间合同检查已通过。只有你勾选的能力会被授予。",
    false
  );
  elements.confirmImportButton.textContent = notices.button;
  elements.confirmImportButton.disabled = false;
  elements.importDialog.showModal();
}

async function beginImport(file = null) {
  try {
    const inspection = typeof file === "string"
      ? await window.workbench.inspectRoomPath(file)
      : file
      ? await window.workbench.inspectDroppedRoom(file)
      : await window.workbench.inspectRoom();
    if (!inspection) {
      await restoreActiveRoomAfterDialog();
      return;
    }
    if (inspection.locked) presentLockedImport(inspection);
    else renderImportInspection(inspection);
  } catch (error) {
    showToast(formatError(error));
    await restoreActiveRoomAfterDialog();
  }
}

function presentLockedImport(inspection) {
  state.pendingLockedImport = inspection;
  elements.unlockImportForm.reset();
  elements.unlockImportSummary.textContent = `房间：${inspection.room.name}\n版本：${inspection.room.version}\n内容：${inspection.transfer.kind === "app-and-data" ? "应用和数据" : "仅应用"}\n文件大小：${formatBytes(inspection.transfer.bytes)}\n保护：${inspection.transfer.encryption}`;
  setInlineStatus(elements.unlockImportStatus, "尚未解密、安装或授予任何权限。", false);
  elements.submitUnlockImportButton.disabled = false;
  elements.unlockImportDialog.showModal();
}

async function cancelLockedImport() {
  const pending = state.pendingLockedImport;
  state.pendingLockedImport = null;
  if (elements.unlockImportDialog.open) elements.unlockImportDialog.close();
  if (pending) {
    try { await window.workbench.cancelImport(pending.token); } catch {}
  }
  await restoreActiveRoomAfterDialog();
}

async function unlockRoomImport(event) {
  event.preventDefault();
  if (!state.pendingLockedImport) return;
  elements.submitUnlockImportButton.disabled = true;
  setInlineStatus(elements.unlockImportStatus, "正在解密并执行房间完整性预检……", false);
  try {
    const inspection = await window.workbench.unlockRoomImport(
      state.pendingLockedImport.token,
      elements.unlockImportForm.elements.password.value
    );
    state.pendingLockedImport = null;
    elements.unlockImportForm.reset();
    elements.unlockImportDialog.close();
    renderImportInspection(inspection);
  } catch (error) {
    setInlineStatus(elements.unlockImportStatus, formatError(error), true);
    elements.submitUnlockImportButton.disabled = false;
  }
}

async function cancelPendingImport() {
  const pending = state.pendingImport;
  state.pendingImport = null;
  if (elements.importDialog.open) elements.importDialog.close();
  if (pending) {
    try { await window.workbench.cancelImport(pending.token); } catch {}
  }
  await restoreActiveRoomAfterDialog();
}

async function confirmImport(event) {
  event.preventDefault();
  if (!state.pendingImport) return;
  elements.confirmImportButton.disabled = true;
  setInlineStatus(elements.importStatus, "正在原子安装房间并保存权限……", false);
  try {
    const room = await window.workbench.confirmImport(
      state.pendingImport.token,
      selectedPermissionKeys(elements.importPermissions)
    );
    state.pendingImport = null;
    elements.importDialog.close();
    if (elements.examplesDialog.open) elements.examplesDialog.close();
    await refreshExamples().catch(() => {});
    if (room.transferDataRestored) showToast(`已安装“${room.name}”并恢复随包数据`);
    else if (room.transferDataError) showToast(`应用已安装，但随包数据未能恢复：${room.transferDataError}`);
    else showToast(`已安装“${room.name}”`);
    await openRoom(room.id);
  } catch (error) {
    setInlineStatus(elements.importStatus, formatError(error), true);
    elements.confirmImportButton.disabled = false;
  }
}

function hideRoomForModal() {
  if (state.isAgentWindow) return Promise.resolve(true);
  return window.workbench.hideRoom();
}

async function showDetailsDialog() {
  if (!state.activeRoomId) return;
  try {
    await hideRoomForModal();
    const [result, history] = await Promise.all([
      window.workbench.getRoomPermissions(state.activeRoomId),
      window.workbench.getRoomHistory(state.activeRoomId)
    ]);
    state.detailsRoomId = result.room.id;
    state.detailsHistory = history;
    elements.detailsRoomName.textContent = result.room.name;
    const publisher = result.room.publisher ? `${result.room.publisher.name}（${result.room.publisher.id}）` : "未声明";
    const moduleNames = result.room.hostModules.length
      ? result.room.hostModules.map((moduleId) => state.roomModules.find((item) => item.id === moduleId)?.name ?? moduleId).join("、")
      : "无";
    const embeddedNames = result.room.embeddedDependencies.length
      ? result.room.embeddedDependencies.map((dependency) => `${dependency.package}@${dependency.version}`).join("、")
      : "无";
    const aiModification = result.room.source === "local-generated"
      ? "允许（本机生成）"
      : result.room.allowAiModification === true
        ? "允许（发布者开放修改）"
        : "未开放";
    elements.detailsIdentity.textContent = `ID：${result.room.id}\n版本：${result.room.version}\n来源：${SOURCE_LABELS[result.room.source] ?? result.room.source} / ${TRUST_LABELS[result.room.trust] ?? result.room.trust}\n发布者：${publisher}\nAI 修改：${aiModification}\n官方模块：${moduleNames}\n随房间依赖：${embeddedNames}`;
    renderPermissionOptions(
      elements.detailsPermissions,
      result.items,
      result.grantedKeys,
      {
        showGrantState: true,
        networkPolicy: state.networkPolicy,
        onSelectionChanged: () => renderDetailsPermissionSummary(result.items)
      }
    );
    renderDetailsPermissionSummary(result.items);
    await renderDetailsAiModel(result.room);
    renderRoomHistory(history);
    await renderDataRecoveryPoints(result.room.id);
    setInlineStatus(elements.detailsStatus, "权限由工作台在每次能力调用时检查。", false);
    elements.savePermissionsButton.disabled = false;
    elements.detailsDialog.showModal();
  } catch (error) {
    showToast(formatError(error));
    await restoreActiveRoomAfterDialog();
  }
}

async function renderDetailsAiModel(room) {
  elements.detailsAiModelSection.hidden = !room.permissions?.ai;
  if (!room.permissions?.ai) return;
  const { selection, models } = await window.workbench.getRoomAiModels(room.id);
  const select = elements.detailsAiModelSelect;
  select.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.providerName} · ${model.model}${model.ready ? "" : "（需配置密钥）"}`;
    option.disabled = !model.ready;
    select.append(option);
  }
  if (selection.profileId) select.value = selection.profileId;
  select.disabled = !models.some((model) => model.ready);
  elements.detailsSaveAiModelButton.disabled = select.disabled;
  elements.detailsTestAiModelButton.disabled = select.disabled;
  const selected = models.find((model) => model.id === selection.profileId);
  elements.detailsAiModelHint.textContent = !models.length
    ? "尚未启用 AI 模型。请先到 AI 能力中心添加模型和密钥。"
    : !selected?.ready
      ? "当前模型缺少可用密钥。请选择已配置模型，或在 AI 能力中心修复密钥。"
      : selection.source === "room"
        ? `当前房间已绑定 ${selected.providerName} · ${selected.model}。可测试连接后再使用。`
        : `当前跟随工作台默认模型 ${selected.providerName} · ${selected.model}。建议保存此房间的模型并测试连接。`;
}

async function saveDetailsAiModel() {
  if (!state.detailsRoomId || !elements.detailsAiModelSelect.value) return;
  elements.detailsSaveAiModelButton.disabled = true;
  try {
    await window.workbench.selectRoomAiModel(state.detailsRoomId, elements.detailsAiModelSelect.value);
    const room = state.rooms.find((item) => item.id === state.detailsRoomId);
    if (room) await renderDetailsAiModel(room);
    showToast("房间 AI 模型已保存");
  } catch (error) {
    elements.detailsAiModelHint.textContent = formatError(error);
  } finally {
    elements.detailsSaveAiModelButton.disabled = false;
  }
}

async function testDetailsAiModel() {
  const profileId = elements.detailsAiModelSelect.value;
  if (!profileId) return;
  elements.detailsTestAiModelButton.disabled = true;
  elements.detailsAiModelHint.textContent = "正在测试所选模型连接……";
  try {
    const result = await window.workbench.testProvider(profileId);
    elements.detailsAiModelHint.textContent = result.ok
      ? `连接成功（${result.latencyMs} ms）。${state.detailsRoomId && (await window.workbench.getRoomAiModels(state.detailsRoomId)).selection.profileId === profileId ? "此房间正在使用该模型。" : "请点击“保存模型”供此房间使用。"}`
      : "连接未通过，请检查 AI 能力中心的密钥。";
  } catch (error) {
    elements.detailsAiModelHint.textContent = `连接失败：${formatError(error)}`;
  } finally {
    elements.detailsTestAiModelButton.disabled = false;
  }
}

async function renderDataRecoveryPoints(roomId) {
  const root = document.getElementById("dataRecoveryList");
  root.replaceChildren();
  const points = await window.workbench.listDataRecoveryPoints(roomId);
  if (!points.length) root.textContent = "尚无数据恢复检查点。导入随包数据或恢复备份前会自动创建。";
  for (const point of points) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = `${point.name.replace('-pre-restore.room.db', '')} · ${formatBytes(point.bytes)} `;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondaryButton";
    button.textContent = "恢复此数据快照";
    button.addEventListener("click", async () => {
      if (!window.confirm("用此快照替换当前业务数据库？不会合并数据；替换前将再保留当前数据检查点。")) return;
      button.disabled = true;
      try {
        await window.workbench.restoreDataRecoveryPoint(roomId, point.name);
        await renderDataRecoveryPoints(roomId);
        setInlineStatus(elements.detailsStatus, "数据快照已恢复，替换前的数据仍保留为检查点。", false);
      } catch (error) { setInlineStatus(elements.detailsStatus, formatError(error), true); }
      finally { button.disabled = false; }
    });
    row.append(label, button);
    root.append(row);
  }
}

function renderRoomHistory(history) {
  elements.detailsHistory.replaceChildren();
  elements.historyGitVersion.textContent = history.gitVersion;
  for (const checkpoint of history.checkpoints) {
    const item = document.createElement("div");
    item.className = "historyItem";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = checkpoint.label;
    const meta = document.createElement("small");
    const changeCount = checkpoint.changes?.length ?? 0;
    meta.textContent = `${new Date(checkpoint.createdAt).toLocaleString()} · ${checkpoint.shortId} · ${changeCount} 个文件变化`;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "恢复";
    restore.addEventListener("click", () => restoreHistoryCheckpoint(checkpoint));
    text.append(title, meta);
    item.append(text, restore);
    elements.detailsHistory.appendChild(item);
  }
  if (!history.checkpoints.length) {
    const empty = document.createElement("div");
    empty.className = "emptyRooms";
    empty.textContent = "尚无版本检查点";
    elements.detailsHistory.appendChild(empty);
  }
}

async function createManualCheckpoint() {
  if (!state.detailsRoomId) return;
  const label = elements.checkpointLabel.value.trim() || "手动检查点";
  elements.createCheckpointButton.disabled = true;
  setInlineStatus(elements.detailsStatus, "正在使用内置 MinGit 创建检查点……", false);
  try {
    await window.workbench.createCheckpoint(state.detailsRoomId, label);
    state.detailsHistory = await window.workbench.getRoomHistory(state.detailsRoomId);
    renderRoomHistory(state.detailsHistory);
    elements.checkpointLabel.value = "";
    setInlineStatus(elements.detailsStatus, "检查点已创建。", false);
  } catch (error) {
    setInlineStatus(elements.detailsStatus, formatError(error), true);
  } finally {
    elements.createCheckpointButton.disabled = false;
  }
}

async function restoreHistoryCheckpoint(checkpoint) {
  if (!state.detailsRoomId) return;
  const confirmed = window.confirm(`恢复到“${checkpoint.label}”吗？\n\n只恢复房间程序，不覆盖业务数据库；恢复前会自动创建检查点。`);
  if (!confirmed) return;
  setInlineStatus(elements.detailsStatus, "正在验证并恢复房间程序……", false);
  try {
    await window.workbench.restoreCheckpoint(state.detailsRoomId, checkpoint.id);
    elements.detailsDialog.close();
    showToast(`已恢复到“${checkpoint.label}”，业务数据保持不变`);
  } catch (error) {
    setInlineStatus(elements.detailsStatus, formatError(error), true);
  }
}

async function saveRoomPermissions(event) {
  event.preventDefault();
  if (!state.detailsRoomId) return;
  elements.savePermissionsButton.disabled = true;
  try {
    await window.workbench.setRoomPermissions(state.detailsRoomId, selectedPermissionKeys(elements.detailsPermissions));
    elements.detailsDialog.close();
    showToast("房间权限已更新并立即生效");
  } catch (error) {
    setInlineStatus(elements.detailsStatus, formatError(error), true);
    elements.savePermissionsButton.disabled = false;
  }
}

function updateExportMode() {
  const includeData = elements.exportForm.elements.mode.value === "app-and-data";
  const protect = elements.exportForm.elements.protect.checked;
  elements.exportPasswordFields.hidden = !protect;
  for (const input of elements.exportPasswordFields.querySelectorAll("input")) input.required = protect;
  for (const option of elements.exportForm.querySelectorAll(".exportModeOption")) {
    option.classList.toggle("selected", option.querySelector("input")?.checked === true);
  }
  elements.submitExportButton.textContent = "选择位置并导出 .room";
  setInlineStatus(
    elements.exportStatus,
    includeData
      ? protect
        ? "将导出应用和当前业务数据，并用密码加密保护整个文件。"
        : "将导出应用和当前业务数据，不设置密码；接收者可以直接导入和读取随包数据。"
      : protect
        ? "只导出应用，并用密码加密保护整个文件。"
        : "只导出应用程序、静态资源和依赖声明，不读取或复制业务数据库。",
    false
  );
}

async function showExportDialog(roomId = state.activeRoomId) {
  const room = roomById(roomId);
  if (!room) return;
  await hideRoomForModal();
  state.exportRoomId = roomId;
  elements.exportRoomTitle.textContent = `导出房间 · ${room.name}`;
  elements.exportForm.reset();
  const allowAiModifyInput = elements.exportForm.elements.allowAiModify;
  const canOfferAiModification = isAiModifiable(room);
  allowAiModifyInput.disabled = !canOfferAiModification;
  allowAiModifyInput.checked = canOfferAiModification && room?.allowAiModification === true;
  elements.exportSharingHint.textContent = canOfferAiModification
    ? "勾选后，导入此房间的人可以让自己工作台里的 AI 继续修改它；不勾选则只能使用，不能 AI 修改"
    : "该房间由他人发布且未开放 AI 修改，再次导出时将保持限制";
  elements.submitExportButton.disabled = false;
  updateExportMode();
  elements.exportDialog.showModal();
}

async function exportRoomPackage(event) {
  event.preventDefault();
  const roomId = state.exportRoomId;
  if (!roomId || !roomById(roomId)) return;
  const includeData = elements.exportForm.elements.mode.value === "app-and-data";
  const protect = elements.exportForm.elements.protect.checked;
  const allowAiModifyInput = elements.exportForm.elements.allowAiModify;
  const allowAiModification = !allowAiModifyInput.disabled && allowAiModifyInput.checked;
  const password = protect ? elements.exportForm.elements.password.value : "";
  if (protect && password !== elements.exportForm.elements.confirmPassword.value) {
    setInlineStatus(elements.exportStatus, "两次输入的导出密码不一致。", true);
    return;
  }
  if (!elements.exportForm.reportValidity()) return;
  elements.submitExportButton.disabled = true;
  setInlineStatus(
    elements.exportStatus,
    includeData ? "正在校验应用并创建数据快照……" : "正在校验并打包房间应用……",
    false
  );
  try {
    const result = await window.workbench.exportRoom(roomId, { includeData, password, allowAiModification });
    if (!result) {
      setInlineStatus(elements.exportStatus, "已取消选择保存位置。", false);
      return;
    }
    elements.exportForm.reset();
    elements.exportDialog.close();
    showToast(`${includeData ? "应用和数据" : "房间应用"}已导出${result.protected ? " · 已设置密码" : " · 无密码"}${allowAiModification ? " · 允许 AI 修改" : ""} · ${formatBytes(result.bytes)}`);
  } catch (error) {
    setInlineStatus(elements.exportStatus, formatError(error), true);
  } finally {
    elements.submitExportButton.disabled = false;
  }
}

async function showBackupDialog() {
  if (!state.activeRoomId) return;
  await hideRoomForModal();
  elements.backupForm.reset();
  setInlineStatus(elements.backupStatus, "备份密码不会保存到磁盘或日志。", false);
  elements.submitBackupButton.disabled = false;
  elements.backupDialog.showModal();
}

async function exportRoomData(event) {
  event.preventDefault();
  if (!state.activeRoomId) return;
  const password = elements.backupForm.elements.password.value;
  const confirmation = elements.backupForm.elements.confirmPassword.value;
  if (password !== confirmation) {
    setInlineStatus(elements.backupStatus, "两次输入的密码不一致。", true);
    return;
  }
  elements.submitBackupButton.disabled = true;
  setInlineStatus(elements.backupStatus, "正在冻结短时写入并创建加密数据库快照……", false);
  try {
    const result = await window.workbench.exportRoomData(state.activeRoomId, password);
    if (!result) {
      setInlineStatus(elements.backupStatus, "已取消选择保存位置。", false);
      return;
    }
    elements.backupForm.reset();
    elements.backupDialog.close();
    showToast(`加密数据备份已创建 · ${formatBytes(result.bytes)}`);
  } catch (error) {
    setInlineStatus(elements.backupStatus, formatError(error), true);
  } finally {
    elements.submitBackupButton.disabled = false;
  }
}

function presentRestoreInspection(inspection) {
  state.pendingRestore = inspection;
  elements.restoreForm.reset();
  elements.restoreSummary.textContent = `房间：${inspection.room.name}\n房间 ID：${inspection.room.id}\n备份版本：${inspection.room.version}\n创建时间：${new Date(inspection.createdAt).toLocaleString()}\n文件大小：${formatBytes(inspection.bytes)}\n状态：已加密，等待密码验证`;
  setInlineStatus(elements.restoreStatus, "尚未修改当前数据。", false);
  elements.submitRestoreButton.disabled = false;
  elements.restoreDialog.showModal();
}

async function showRestoreDialog() {
  if (!state.activeRoomId) return;
  try {
    const inspection = await window.workbench.inspectRoomData(state.activeRoomId);
    if (!inspection) {
      await restoreActiveRoomAfterDialog();
      return;
    }
    presentRestoreInspection(inspection);
  } catch (error) {
    showToast(formatError(error));
    await restoreActiveRoomAfterDialog();
  }
}

async function cancelPendingRestore() {
  const pending = state.pendingRestore;
  state.pendingRestore = null;
  if (elements.restoreDialog.open) elements.restoreDialog.close();
  if (pending) {
    try { await window.workbench.cancelDataRestore(pending.token); } catch {}
  }
}

async function confirmDataRestore(event) {
  event.preventDefault();
  if (!state.pendingRestore) return;
  elements.submitRestoreButton.disabled = true;
  setInlineStatus(elements.restoreStatus, "正在验证密码、完整性和 SQLite 数据库……", false);
  try {
    const result = await window.workbench.confirmDataRestore(
      state.pendingRestore.token,
      elements.restoreForm.elements.password.value
    );
    state.pendingRestore = null;
    elements.restoreForm.reset();
    elements.restoreDialog.close();
    showToast(result.backupCreated ? "数据已恢复，原数据库检查点已保留" : "数据已恢复");
  } catch (error) {
    setInlineStatus(elements.restoreStatus, formatError(error), true);
    elements.submitRestoreButton.disabled = false;
  }
}

async function showProviderDialog() {
  await hideRoomForModal();
  state.providerEditorOpen = false;
  state.editingProviderId = null;
  state.credentialSourceProfileId = null;
  resetProviderModelSelection();
  renderProvider();
  const connectionCount = new Set(state.aiProfiles.map(providerConnectionKey)).size;
  setInlineStatus(
    elements.providerStatus,
    state.aiProfiles.length
      ? `已连接 ${connectionCount} 个提供商连接、启用 ${state.aiProfiles.length} 个模型。点击“管理 / 添加模型”可继续批量导入。`
      : "尚未连接提供商。点击“添加提供商”开始。",
    false
  );
  elements.providerDialog.showModal();
}

function closeProviderEditor() {
  setProviderPickerOpen(false);
  state.providerEditorOpen = false;
  state.editingProviderId = null;
  state.credentialSourceProfileId = null;
  state.providerQuery = "";
  elements.providerSearch.value = "";
  resetProviderModelSelection();
  elements.providerForm.reset();
  renderProvider();
}

function startNewProvider() {
  elements.providerDialog.classList.add("choosingProvider");
  state.providerEditorOpen = true;
  state.credentialSourceProfileId = null;
  state.editingProviderId = null;
  state.providerQuery = "";
  elements.providerSearch.value = "";
  resetProviderModelSelection();
  elements.providerForm.reset();
  elements.providerSelect.value = state.aiProviders.find((provider) => provider.featured)?.id || "custom-openai-compatible";
  renderProvider();
  setInlineStatus(elements.providerStatus, "选择提供商、填写一次 Key，再勾选一个或多个模型。", false);
  elements.providerPickerValue.textContent = "请选择要添加的提供商";
  setProviderPickerOpen(true);
  elements.providerDialog.scrollTop = 0;
  elements.providerSearch.focus();
}

function startProviderModel(profile) {
  elements.providerDialog.classList.remove("choosingProvider");
  state.providerEditorOpen = true;
  state.editingProviderId = null;
  state.credentialSourceProfileId = profile.id;
  state.providerQuery = "";
  elements.providerSearch.value = "";
  resetProviderModelSelection();
  elements.providerForm.reset();
  elements.providerSelect.value = profile.providerId;
  renderProvider();
  setInlineStatus(elements.providerStatus, `已沿用“${profile.label}”的安全连接；可一次勾选多个尚未启用的模型，不必重复填写 Key。`, false);
}

function startEditingProvider(profile) {
  elements.providerDialog.classList.remove("choosingProvider");
  state.providerEditorOpen = true;
  state.editingProviderId = profile.id;
  state.credentialSourceProfileId = null;
  state.providerQuery = "";
  elements.providerSearch.value = "";
  resetProviderModelSelection();
  elements.providerForm.reset();
  elements.providerSelect.value = profile.providerId;
  renderProvider();
  const keyStatus = WorkbenchPresentation.credentialStatus(profile);
  setInlineStatus(elements.providerStatus, `正在编辑 ${profile.label} · ${keyStatus}。`, false);
}

async function setActiveProvider(profileId) {
  try {
    applyAiState(await window.workbench.setActiveProvider(profileId));
    renderProvider();
    showToast(`房间默认 AI 模型已切换为 ${state.provider?.label || state.provider?.model}`);
  } catch (error) {
    setInlineStatus(elements.providerStatus, formatError(error), true);
    showToast(formatError(error));
  }
}

async function deleteProvider(profile) {
  if (!window.confirm(`删除已启用模型“${profile.label}”？使用它的房间会回退到默认模型，同一提供商的其他模型不受影响。`)) return;
  try {
    applyAiState(await window.workbench.deleteProvider(profile.id));
    renderProvider();
    setInlineStatus(elements.providerStatus, "模型配置及其密钥已删除。", false);
  } catch (error) {
    setInlineStatus(elements.providerStatus, formatError(error), true);
  }
}

async function saveProvider() {
  if (!elements.providerForm.reportValidity()) throw new Error("请完整填写 AI 提供商配置");
  const reusedConnection = Boolean(state.credentialSourceProfileId);
  const saved = await window.workbench.saveProvider(providerFormPayload());
  applySavedProvider(saved);
  state.editingProviderId = saved.id;
  state.credentialSourceProfileId = null;
  renderProvider();
  const keyStatus = saved.hasStoredKey ? "密钥已由系统安全存储加密" : saved.hasSessionKey ? "密钥仅在当前会话" : "未保存密钥";
  setInlineStatus(elements.providerStatus, reusedConnection
    ? `${saved.label} 已启用；${keyStatus}，默认模型未改变。`
    : `${saved.label} 已保存；${keyStatus}，${saved.isActive ? "仍为默认模型" : "默认模型未改变"}。`, false);
  return saved;
}

async function saveProviderSelection() {
  const provider = selectedProvider();
  if (!provider) throw new Error("请选择 AI 提供商");
  if (provider.configurable === false) throw new Error(provider.limitation || "当前工作台尚不能配置该 Pi Provider");
  if (!elements.providerForm.reportValidity()) throw new Error("请完整填写 AI 提供商配置");
  if (editingProviderProfile()) return [await saveProvider()];
  const modelIds = selectedProviderModelIds(provider);
  if (!modelIds.length) throw new Error(provider.id === "custom-openai-compatible"
    ? "请至少填写一个模型 ID，每行一个"
    : "请至少勾选一个尚未启用的模型");
  const labelPrefix = elements.providerProfileLabel.value.trim();
  const enteredKey = elements.providerApiKey.value;
  const rememberKey = elements.providerForm.elements.rememberKey.checked;
  let reuseProfileId = state.credentialSourceProfileId || null;
  const savedProfiles = [];
  for (let index = 0; index < modelIds.length; index += 1) {
    const modelId = modelIds[index];
    const definition = provider.models.find((model) => model.id === modelId);
    const modelName = definition?.name || modelId;
    const payload = {
      label: labelPrefix
        ? modelIds.length === 1 ? labelPrefix : `${labelPrefix} · ${modelName}`
        : `${provider.displayName} · ${modelName}`,
      providerId: provider.id,
      model: modelId,
      apiKey: index === 0 ? enteredKey : "",
      rememberKey,
      activate: !state.provider && index === 0,
      ...(definition ? {} : { modelSource: "custom", modelCapabilities: customCatalogModelCapabilities() }),
      ...(reuseProfileId ? { credentialSourceProfileId: reuseProfileId } : {})
    };
    if (provider.id === "custom-openai-compatible") {
      payload.name = elements.customProviderName.value;
      payload.baseUrl = elements.customBaseUrl.value;
    }
    const saved = await window.workbench.saveProvider(payload);
    applySavedProvider(saved);
    savedProfiles.push(saved);
    reuseProfileId = saved.id;
  }
  state.providerEditorOpen = false;
  state.editingProviderId = null;
  state.credentialSourceProfileId = null;
  resetProviderModelSelection();
  elements.providerForm.reset();
  renderProvider();
  const keyStatus = savedProfiles.some((profile) => profile.hasStoredKey)
    ? "密钥已由系统安全存储加密"
    : savedProfiles.some((profile) => profile.hasSessionKey)
      ? "密钥仅在当前会话"
      : "未保存密钥";
  setInlineStatus(elements.providerStatus, `已启用 ${savedProfiles.length} 个模型；${keyStatus}。`, false);
  return savedProfiles;
}

async function testProvider() {
  elements.testProviderButton.disabled = true;
  let savedProfiles = [];
  try {
    const provider = selectedProvider();
    setInlineStatus(elements.providerStatus, `正在通过 Pi ${provider?.displayName || "AI"} 测试连接……`, false);
    savedProfiles = await saveProviderSelection();
    const saved = savedProfiles[0];
    const result = await window.workbench.testProvider(saved.id);
    const importSummary = savedProfiles.length > 1 ? `已启用 ${savedProfiles.length} 个模型；` : "";
    setInlineStatus(elements.providerStatus, `${importSummary}首个模型连接成功 · ${result.model} · ${result.latencyMs} ms · 回复：${result.reply}`, false);
    showToast(`${saved.name} 已连接 · ${result.model}`);
  } catch (error) {
    const summary = savedProfiles.length
      ? `已保存 ${savedProfiles.length} 个模型；${savedProfiles[0].model} 连接测试失败${savedProfiles.length > 1 ? "，其余模型尚未测试" : ""}：`
      : "";
    setInlineStatus(elements.providerStatus, summary + formatError(error), true);
  } finally {
    elements.testProviderButton.disabled = selectedProvider()?.configurable === false;
  }
}

async function importProviderConfig() {
  try {
    const profile = await window.workbench.importProviderConfig();
    if (!profile) return;
    state.aiProfiles = [
      ...state.aiProfiles.map((entry) => ({ ...entry, isActive: false })),
      profile
    ];
    state.provider = profile;
    state.providerEditorOpen = false;
    state.editingProviderId = null;
    state.credentialSourceProfileId = null;
    resetProviderModelSelection();
    renderProvider();
    setInlineStatus(elements.providerStatus, "组织配置已导入；配置文件不包含 API Key。", false);
  } catch (error) {
    setInlineStatus(elements.providerStatus, formatError(error), true);
  }
}

function renderDiagnosticFieldList(container, fields) {
  container.replaceChildren();
  for (const field of fields) {
    const item = document.createElement("li");
    item.textContent = field;
    container.appendChild(item);
  }
}

async function showDiagnosticsDialog() {
  try {
    await hideRoomForModal();
    setInlineStatus(elements.diagnosticsStatus, "正在准备脱敏字段清单……", false);
    const preview = await window.workbench.previewDiagnostics();
    elements.diagnosticsSummary.textContent = `格式 ${preview.formatVersion} · ${preview.roomCount} 个房间摘要 · 最近 ${preview.eventCount} 条脱敏事件`;
    renderDiagnosticFieldList(elements.diagnosticsIncluded, preview.includedFields);
    renderDiagnosticFieldList(elements.diagnosticsExcluded, preview.excludedFields);
    setInlineStatus(elements.diagnosticsStatus, "请确认字段范围；点击导出后只会保存到你选择的位置。", false);
    elements.diagnosticsDialog.showModal();
  } catch (error) {
    showToast(formatError(error));
    await restoreActiveRoomAfterDialog();
  }
}

async function exportDiagnostics(event) {
  event.preventDefault();
  elements.confirmDiagnosticsButton.disabled = true;
  setInlineStatus(elements.diagnosticsStatus, "正在生成脱敏诊断报告……", false);
  try {
    const result = await window.workbench.exportDiagnostics();
    if (result) {
      elements.diagnosticsDialog.close();
      showToast(`脱敏诊断报告已导出 · ${result.eventCount} 条事件`);
    } else {
      setInlineStatus(elements.diagnosticsStatus, "已取消保存，未生成诊断报告。", false);
    }
  } catch (error) {
    setInlineStatus(elements.diagnosticsStatus, formatError(error), true);
  } finally {
    elements.confirmDiagnosticsButton.disabled = false;
  }
}

const AGENT_STATUS_LABELS = {
  idle: "就绪",
  working: "Agent 运行中",
  stopping: "正在停止",
  error: "需要处理",
  interrupted: "上次已中断"
};

function formatAgentTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function syncAgentSessionSummary() {
  const session = state.agentSession;
  if (!session) return;
  const summary = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    roomId: session.roomId,
    provider: session.provider
  };
  const index = state.agentSessions.findIndex((item) => item.id === session.id);
  if (index >= 0) state.agentSessions[index] = summary;
  else state.agentSessions.unshift(summary);
  state.agentSessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function renderAgentSessions() {
  const scrollTop = elements.agentSessionList.scrollTop;
  elements.agentSessionList.replaceChildren();
  if (!state.agentSessions.length) {
    const empty = document.createElement("div");
    empty.className = "emptyRooms";
    empty.textContent = "还没有房间开发对话";
    elements.agentSessionList.appendChild(empty);
    return;
  }
  for (const session of state.agentSessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agentSessionItem ${session.status || "idle"}${state.agentSession?.id === session.id ? " active" : ""}`;
    button.dataset.sessionId = session.id;
    const dot = document.createElement("span");
    dot.className = "agentSessionDot";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = session.title;
    const meta = document.createElement("small");
    const linkedRoom = state.rooms.find((room) => room.id === session.roomId);
    meta.textContent = `${new Date(session.updatedAt).toLocaleDateString()} ${formatAgentTime(session.updatedAt)} · ${AGENT_STATUS_LABELS[session.status] || "就绪"}${linkedRoom ? ` · ${linkedRoom.name}` : ""}`;
    button.title = `${session.title}\n${meta.textContent}`;
    copy.append(title, meta);
    button.append(dot, copy);
    button.addEventListener("click", () => loadAgentSession(session.id).catch((error) => showToast(formatError(error))));
    elements.agentSessionList.appendChild(button);
  }
  elements.agentSessionList.scrollTop = scrollTop;
}

function createAgentMessageElement(message) {
  const article = document.createElement("article");
  article.className = `agentMessage ${message.role} ${message.status || "complete"}`;
  article.dataset.messageId = message.id;
  const meta = document.createElement("div");
  meta.className = "agentMessageMeta";
  meta.textContent = `${message.role === "user" ? "你" : "智变 Agent"} · ${formatAgentTime(message.createdAt)}`;
  const body = document.createElement("div");
  body.className = "agentMessageBody";
  renderAgentRichText(body, message.content || (message.status === "streaming" || message.attachments?.length ? "" : "（无文字回复）"));
  article.append(meta);
  if (message.attachments?.length) {
    const gallery = document.createElement("div");
    gallery.className = "agentMessageGallery";
    for (const attachment of message.attachments) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "agentMessageImage loading";
      card.title = `${attachment.name} · ${formatBytes(attachment.bytes)}`;
      const image = document.createElement("img");
      image.alt = attachment.name || "参考图片";
      const label = document.createElement("span");
      label.textContent = attachment.name || "参考图片";
      card.append(image, label);
      gallery.appendChild(card);
      loadStoredAgentImage(image, card, attachment);
    }
    article.appendChild(gallery);
  }
  article.append(body);
  return article;
}

function openRoomFromAgent(roomId) {
  if (state.isAgentWindow) {
    window.workbench.requestOpenRoom(roomId).catch((error) => showToast(formatError(error)));
    return;
  }
  openRoom(roomId).catch((error) => showToast(formatError(error)));
}

function createAgentToolElement(step) {
  const article = document.createElement("article");
  article.className = `agentToolStep ${step.status || "running"}`;
  article.dataset.stepId = step.id;
  const header = document.createElement("div");
  header.className = "agentToolStepHeader";
  const icon = document.createElement("span");
  icon.className = "agentToolIcon";
  icon.textContent = step.status === "success" ? "✓" : step.status === "error" ? "!" : "••";
  const info = document.createElement("div");
  info.className = "agentToolInfo";
  const title = document.createElement("strong");
  title.textContent = step.label;
  const summary = document.createElement("small");
  summary.textContent = step.summary;
  info.append(title, summary);
  const status = document.createElement("span");
  status.className = "agentToolState";
  status.textContent = step.status === "success" ? "已完成" : step.status === "error" ? "失败" : "执行中";
  header.append(icon, info, status);
  const progress = document.createElement("div");
  progress.className = `agentToolProgress${step.status === "error" ? " agentToolError" : ""}`;
  progress.textContent = step.error || step.progress || "准备执行";
  article.append(header);
  if (step.status !== "success") article.append(progress);
  if (step.details || step.error) {
    const disclosure = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = "查看检查结果与详情";
    const content = document.createElement("pre");
    content.textContent = JSON.stringify({ error: step.error || undefined, ...step.details }, null, 2);
    const checks = step.details?.testChecks || step.details?.quality?.checks;
    if (Array.isArray(checks)) {
      const list = document.createElement("ul");
      for (const check of checks) {
        const item = document.createElement("li");
        item.textContent = `${check.passed === true ? "通过" : check.passed === false ? "未通过" : "检查"}：${check.message || check.label || check.id || String(check)}`;
        list.append(item);
      }
      disclosure.append(list);
    }
    disclosure.append(label, content);
    disclosure.open = step.status === "error";
    article.append(disclosure);
  }
  const room = step.details?.room;
  if (room) {
    const result = document.createElement("div");
    result.className = "agentRoomResult";
    const roomIcon = document.createElement("span");
    roomIcon.className = "agentRoomResultIcon";
    renderRoomIcon(roomIcon, room, { fallback: step.details.kind === "game3d" ? "3D" : step.details.kind === "custom" ? "码" : "房" });
    const roomInfo = document.createElement("div");
    const roomName = document.createElement("strong");
    roomName.textContent = room.name;
    const roomMeta = document.createElement("small");
    const capability = step.details.kind === "game3d"
      ? "模板化离线 3D 游戏"
      : step.details.kind === "custom"
        ? "自由房间 · 静态与启动检查通过 · 业务/视觉待验收"
        : `${step.details.pageCount || 1} 个页面 · ${(step.details.componentTypes || []).join(" / ")}`;
    roomMeta.textContent = `v${room.version} · ${capability} · 内置模块 ${(room.hostModules || []).length} 个`;
    roomInfo.append(roomName, roomMeta);
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "agentOpenRoomButton";
    openButton.textContent = "打开房间";
    openButton.addEventListener("click", () => openRoomFromAgent(room.id));
    result.append(roomIcon, roomInfo, openButton);
    article.appendChild(result);
  }
  return article;
}

function createQuestionForm(session) {
  const workflow = session.workflow;
  const key = `zhibian.question-draft.${session.id}.${workflow.questionSetId || workflow.askedAtMessage || 'legacy'}`;
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(key) || "{}"); } catch {}
  if (!draft || typeof draft !== "object") draft = {};
  const persist = () => { try { localStorage.setItem(key, JSON.stringify(draft)); } catch {} };
  const form = document.createElement("form");
  form.className = "agentQuestionForm";
  const controls = [];
  for (const [index, raw] of (workflow.questions || []).entries()) {
    const question = typeof raw === "string" ? { title: raw, options: ["你来推荐"] } : raw;
    const id = question.id || `q${index}`;
    const saved = draft[id];
    const multiple = question.selection === "multiple" || (!question.selection && question.topic === "features");
    const answer = { choice: typeof saved?.choice === "string" ? saved.choice : "", choices: Array.isArray(saved?.choices) ? saved.choices.filter(value => question.options?.includes(value)) : [], note: typeof saved?.note === "string" ? saved.note.slice(0, 600) : "" };
    if (multiple && !answer.choices.length && answer.choice) answer.choices = [answer.choice];
    if (question.selection === "text") { answer.choice = ""; answer.choices = []; }
    draft[id] = answer;
    const field = document.createElement("fieldset");
    field.className = "agentQuestion";
    field.disabled = ["working", "stopping"].includes(session.status);
    const legend = document.createElement("legend");
    legend.textContent = `${index + 1}. ${question.title}${multiple ? "（可多选）" : ""}`;
    field.append(legend);
    if (question.example) {
      const example = document.createElement("p");
      example.textContent = `例如：${question.example}`;
      field.append(example);
    }
    for (const option of question.selection === "text" ? [] : question.options || ["你来推荐"]) {
      const label = document.createElement("label");
      label.className = "agentQuestionOption";
      const radio = document.createElement("input");
      radio.type = multiple ? "checkbox" : "radio";
      radio.name = id;
      radio.value = option;
      radio.checked = multiple ? answer.choices.includes(option) : answer.choice === option;
      const text = document.createElement("span");
      text.textContent = option + (question.recommended === option ? "（推荐）" : "");
      radio.addEventListener("change", () => {
        if (multiple) {
          answer.choice = "";
          answer.choices = [...field.querySelectorAll('input:checked')].map(input => input.value);
          if (radio.checked) answer.choices = option === "你来推荐" ? [option] : answer.choices.filter(value => value !== "你来推荐");
          for (const input of field.querySelectorAll('input')) input.checked = answer.choices.includes(input.value);
        } else answer.choice = option;
        persist();
      });
      label.append(radio, text);
      field.append(label);
    }
    const noteLabel = document.createElement("label");
    noteLabel.textContent = "补充说明 / 自己的答案";
    const note = document.createElement("textarea");
    note.rows = 2;
    note.maxLength = 600;
    note.placeholder = "可以不选上面的选项，直接描述你的情况";
    note.value = answer.note || "";
    note.addEventListener("input", () => { answer.note = note.value; persist(); });
    noteLabel.append(note);
    const extra = document.createElement("details");
    extra.open = Boolean(answer.note) || question.selection === "text";
    const extraTitle = document.createElement("summary");
    extraTitle.textContent = "补充说明 / 自己填写";
    extra.append(extraTitle, noteLabel);
    field.append(extra);
    form.append(field);
    controls.push({ question, answer, note, extra });
  }
  const hint = document.createElement("p");
  hint.textContent = "按题目选择一项、多项或自己填写；也可以选择“你来推荐”。答案暂存在本机，提交后仍需确认方案才会制作。";
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primaryButton compact";
  submit.textContent = "提交回答，生成方案";
  submit.disabled = ["working", "stopping"].includes(session.status) || !WorkbenchPresentation.canUseProfile(state.aiProfiles.find(profile => profile.id === (session.profileId || state.provider?.id)));
  form.append(hint, feedback, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const missing = controls.findIndex(({ answer }) => !answer.choice && !answer.choices.length && !answer.note.trim());
    if (missing >= 0) { feedback.textContent = `第 ${missing + 1} 题还没有回答，请选择或补充。`; controls[missing].extra.open = true; controls[missing].note.focus(); return; }
    if (elements.generatePrompt.value.trim() || state.pendingAgentImages.length) { feedback.textContent = "聊天框里还有未发送文字或图片，请先发送或清空，再提交问答。"; return; }
    submit.disabled = true;
    const prompt = controls.map(({ question, answer }, index) => `${index + 1}. ${question.title}\n回答：${[answer.choices.length ? answer.choices.join('、') : answer.choice, answer.note.trim()].filter(Boolean).join('；补充：')}`).join("\n\n");
    try {
      const result = await window.workbench.sendRoomAgentMessage(session.id, prompt, []);
      try { localStorage.removeItem(key); } catch {}
      if (state.agentSession?.id === session.id) { state.agentSession = result.session; renderAgentWorkspace(); }
    } catch (error) { feedback.textContent = formatError(error); submit.disabled = false; }
  });
  return form;
}

function createAgentWorkflowCard(session) {
  const workflow = session.workflow;
  const plan = session.roomId ? null : workflow?.plan;
  const showQuestions = workflow?.phase === "clarifying" && !workflow.answered && Boolean(workflow.questions?.length);
  if (!showQuestions && !plan) return null;
  const card = document.createElement("section");
  card.className = "agentWorkflowCard";
  const heading = document.createElement("h3");
  heading.textContent = { clarifying: "① 澄清需求", review: "② 请确认实施方案", implementing: "③ 正在按方案实施", complete: "④ 本次实施完成" }[workflow.phase] || "房间方案";
  card.appendChild(heading);
  if (session.draft?.exists) {
    const saved = document.createElement("p");
    saved.textContent = `草稿已保存 · 修订 ${session.draft.revision} · ${Object.values(session.draft.files).filter(file => file.saved).length}/3 个文件。中断或失败后可以继续；已保存不代表运行检查通过。`;
    card.append(saved);
  }
  if (showQuestions) {
    card.appendChild(createQuestionForm(session));
  }
  if (plan) {
    const details = document.createElement("details");
    details.open = workflow.phase === "review";
    const summary = document.createElement("summary");
    summary.textContent = "查看功能、使用方式与验收标准";
    details.appendChild(summary);
    for (const [key, label] of Object.entries({ overview: "使用场景", features: "第一版功能", usage: "怎么使用", data: "数据规模与保存", permissions: "权限及用途", steps: "实施计划", acceptance: "如何验收", limitations: "假设、限制与不包含的功能" })) {
      const title = document.createElement("h4");
      title.textContent = label;
      const text = document.createElement("div");
      text.className = "agentRichText";
      renderAgentRichText(text, plan[key]);
      details.append(title, text);
    }
    card.appendChild(details);
    if (workflow.phase === "review") {
      const note = document.createElement("p");
      note.textContent = "有要调整的地方，请先在下方发送修改要求。确认方案不等于授予联网或文件等运行权限。";
      let aiTestToggle = null;
      let aiTestModel = null;
      if (plan.usesAi) {
        const testBox = document.createElement("div");
        testBox.className = "agentAiTestChoice";
        const heading = document.createElement("strong");
        heading.textContent = "真实 AI 能力测试";
        const explanation = document.createElement("p");
        explanation.textContent = `${plan.aiTestPurpose || "验证房间调用主工作台 AI 的链路"}。默认只做离线契约测试；开启后会消耗所选模型的少量 Token，失败将阻止安装。`;
        const toggleLabel = document.createElement("label");
        aiTestToggle = document.createElement("input");
        aiTestToggle.type = "checkbox";
        aiTestToggle.checked = workflow.approvedPlanId === plan.id && workflow.aiTestPolicy?.enabled === true;
        const toggleText = document.createElement("span");
        toggleText.textContent = "允许进行一次真实 AI 调用测试";
        toggleLabel.append(aiTestToggle, toggleText);
        aiTestModel = document.createElement("select");
        aiTestModel.setAttribute("aria-label", "真实 AI 测试使用的模型");
        const readyProfiles = state.aiProfiles.filter(WorkbenchPresentation.canUseProfile);
        for (const profile of readyProfiles) {
          const option = document.createElement("option");
          option.value = profile.id;
          option.textContent = `${profile.label || profile.name} · ${profile.model}`;
          aiTestModel.appendChild(option);
        }
        const preferred = readyProfiles.find((profile) => profile.id === workflow.aiTestPolicy?.profileId)
          || readyProfiles.find((profile) => profile.id === session.profileId)
          || readyProfiles[0];
        if (preferred) aiTestModel.value = preferred.id;
        aiTestModel.disabled = !aiTestToggle.checked;
        aiTestToggle.disabled = readyProfiles.length === 0;
        aiTestToggle.addEventListener("change", () => { aiTestModel.disabled = !aiTestToggle.checked; });
        if (!readyProfiles.length) {
          const option = document.createElement("option");
          option.textContent = "暂无可用模型，可保持关闭后继续";
          aiTestModel.appendChild(option);
        }
        testBox.append(heading, explanation, toggleLabel, aiTestModel);
        card.appendChild(testBox);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = workflow.approvedPlanId === plan.id
        ? "继续实施当前方案"
        : plan.migrationMode === "refactor" ? "同意重构方案，创建新房间" : plan.migrationMode === "adapt" ? "同意适配方案，创建新房间" : "同意方案，开始实施";
      button.className = "primaryButton compact";
      button.disabled = ["working", "stopping"].includes(session.status) || !WorkbenchPresentation.canUseProfile(state.aiProfiles.find(profile => profile.id === (session.profileId || state.provider?.id)));
      button.addEventListener("click", async () => {
        if (elements.generatePrompt.value.trim() || state.pendingAgentImages.length) {
          showToast("请先发送或清空尚未发送的补充要求，再确认方案");
          return;
        }
        button.disabled = true;
        try {
          const aiTest = plan.usesAi
            ? { enabled: Boolean(aiTestToggle?.checked), ...(aiTestToggle?.checked ? { profileId: aiTestModel?.value } : {}) }
            : null;
          const result = await window.workbench.sendRoomAgentMessage(session.id, "", [], plan.id, aiTest);
          if (state.agentSession?.id === session.id) state.agentSession = result.session;
          state.agentActivity = "已确认方案，正在实施";
          renderAgentWorkspace();
        } catch (error) {
          button.disabled = false;
          showToast(formatError(error));
        }
      });
      card.append(note, button);
    }
  }
  return card;
}

function renderAgentTimeline({ keepScroll = false } = {}) {
  const session = state.agentSession;
  const nearBottom = elements.agentConversation.scrollHeight - elements.agentConversation.scrollTop - elements.agentConversation.clientHeight < 100;
  elements.agentTimeline.replaceChildren();
  const records = session ? [
    ...session.messages.map((item, index) => ({ type: "message", item, at: item.createdAt, index })),
    ...session.steps.map((item, index) => ({ type: "step", item, at: item.startedAt, index }))
  ].sort((left, right) => String(left.at).localeCompare(String(right.at)) || left.index - right.index) : [];
  elements.agentEmptyState.hidden = records.length > 0;
  for (const record of records) {
    elements.agentTimeline.appendChild(record.type === "message"
      ? createAgentMessageElement(record.item)
      : createAgentToolElement(record.item));
  }
  const workflowCard = session ? createAgentWorkflowCard(session) : null;
  if (workflowCard) elements.agentTimeline.appendChild(workflowCard);
  if (!keepScroll || nearBottom) requestAnimationFrame(() => { elements.agentConversation.scrollTop = elements.agentConversation.scrollHeight; });
}

function renderAgentUsage(session) {
  const runs = session?.runs || [];
  const summary = document.getElementById("agentUsageSummary");
  const history = document.getElementById("agentUsageHistory");
  const describe = (run) => {
    const seconds = run.elapsedMs != null ? Math.round(run.elapsedMs / 1000) : run.status === "working" ? Math.max(0, Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)) : null;
    const tokens = run.reportedRequests ? `${run.tokens?.totalTokens ?? 0} Token${run.missingUsage ? '（部分已返回）' : ''}` : "Token 未返回";
    const cost = run.estimatedCostUsd > 0 ? `目录估算 $${run.estimatedCostUsd.toFixed(4)}${run.missingCost ? '（部分）' : ''}` : "费用未知";
    return `${seconds === null ? '耗时未知' : seconds + ' 秒'} · ${tokens} · ${cost}`;
  };
  summary.textContent = (runs.length ? `最近一轮：${describe(runs[runs.length - 1])}` : "本轮用量：尚无调用记录；历史缺失用量不追溯估算") + " · 任务预算和重试可用 /runtime 查看与调整；用量以模型返回为准";
  history.replaceChildren();
  for (const run of [...runs].reverse()) {
    const row = document.createElement("p");
    const t = run.tokens || {};
    const count = (field) => run.reportedFields?.[field] ? `${t[field]}${run.reportedFields[field] < run.requests ? '（部分）' : ''}` : "未知";
    row.textContent = `${new Date(run.startedAt).toLocaleString()} · ${run.provider || ''} / ${run.model || ''}\n${describe(run)} · 模型回复 ${run.requests || 0} 次 · ${run.status === 'working' ? '进行中' : run.status === 'error' ? '失败' : run.status === 'stopped' || run.status === 'interrupted' ? '中断' : '结束'}\n已返回 Token：输入 ${count('input')} / 输出 ${count('output')} / 缓存读取 ${count('cacheRead')} / 缓存写入 ${count('cacheWrite')}。${run.missingUsage ? '有请求未返回完整用量，以上不是完整总量。' : ''}`;
    history.append(row);
  }
}

function renderAgentProject(session) {
  const source = session?.sourceProject;
  const button = document.getElementById("agentProjectButton");
  button.disabled = !session || Boolean(source || session.roomId || session.draft?.exists) || ["working", "stopping"].includes(session.status);
  button.title = source || session?.roomId ? "每个迁移项目使用一个新对话；更换项目请新建对话" : "只读导入已脱敏的本地源码，不执行原项目";
  const panel = document.getElementById("agentProjectPanel");
  panel.hidden = !source;
  if (!source) return;
  const assessment = session.projectAssessment;
  const labels = { adapt: "可适配（待验证）", refactor: "需要重构", unsupported: "当前难以实现" };
  document.getElementById("agentProjectSummary").textContent = `项目：${source.name} · ${source.files.length} 个文本文件 · ${Math.ceil(source.totalBytes / 1024)} KiB · ${labels[assessment?.recommendation] || "待 AI 评估"}`;
  const body = document.getElementById("agentProjectDetails");
  body.replaceChildren();
  const paragraph = (text) => { const p = document.createElement("p"); p.textContent = text; body.append(p); };
  for (const warning of source.warnings) paragraph(warning);
  if (Object.keys(source.skipped).length) paragraph(`跳过统计：${Object.entries(source.skipped).map(([key, count]) => `${({ excluded: "排除目录/文件", link: "链接", nonSource: "非源码", size: "超出大小", depth: "超出深度", sensitive: "疑似敏感内容", binary: "二进制", encoding: "非 UTF-8" })[key] || key} ${count}`).join("；")}`);
  if (assessment) {
    for (const [key, label] of Object.entries({ summary: "结论", evidence: "依据", preserved: "保留功能", changes: "改写与不包含的功能", dependencies: "依赖替换", risks: "风险、权限及许可", acceptance: "验收方法" })) paragraph(`${label}：${assessment[key]}`);
    paragraph("评估不是实施授权。请在聊天中确认要保留的功能、是否接受重构或停止；之后仍须确认方案卡片。");
  }
  const list = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "查看快照文件清单（不含原始路径）";
  const pre = document.createElement("pre");
  pre.textContent = source.files.map(file => `${file.path} · ${file.bytes} B`).join("\n");
  list.append(summary, pre); body.append(list);
}

function renderAgentHeader() {
  const session = state.agentSession;
  renderAgentProject(session);
  const selectedProfileId = session?.profileId || session?.provider?.profileId || state.provider?.id || "";
  const selectedProfile = state.aiProfiles.find((profile) => profile.id === selectedProfileId) || null;
  elements.agentSessionTitle.textContent = session?.title || "新房间对话";
  elements.agentSessionTitle.title = session?.title || "新房间对话";
  renderAgentUsage(session);
  elements.agentProviderLabel.textContent = selectedProfile?.name || session?.provider?.name || state.provider?.name || "Pi Agent";
  elements.agentModelLabel.textContent = selectedProfile?.model || session?.provider?.model || state.provider?.model || "等待模型";
  const status = session?.status || "idle";
  elements.agentModelSelect.replaceChildren();
  const groupedProfiles = new Map();
  for (const profile of state.aiProfiles) {
    const groupKey = profile.name || profile.providerId;
    if (!groupedProfiles.has(groupKey)) groupedProfiles.set(groupKey, []);
    groupedProfiles.get(groupKey).push(profile);
  }
  for (const [providerName, profiles] of groupedProfiles) {
    const group = document.createElement("optgroup");
    group.label = providerName;
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.label + " · " + profile.model + (WorkbenchPresentation.canUseProfile(profile) ? "" : "（需配置密钥）");
      option.disabled = !WorkbenchPresentation.canUseProfile(profile);
      group.appendChild(option);
    }
    elements.agentModelSelect.appendChild(group);
  }
  if (!state.aiProfiles.length) {
    const option = document.createElement("option");
    option.textContent = "请先连接 AI";
    option.value = "";
    elements.agentModelSelect.appendChild(option);
  }
  elements.agentModelSelect.value = selectedProfileId;
  elements.agentModelSelect.disabled = !session || ["working", "stopping"].includes(status) || !state.aiProfiles.length;
  elements.agentRunStatus.className = "agentRunStatus " + status;
  elements.agentRunStatus.textContent = status === "idle" ? (session?.roomId && (!session.workflow?.questions?.length && !session.workflow?.plan) ? "已有房间 · 修改待沟通" : { clarifying: session?.roomId ? "修改需求沟通" : "需求沟通", review: "等待确认", complete: "房间已完成" }[session?.workflow?.phase] || "就绪") : (AGENT_STATUS_LABELS[status] || "就绪");
  elements.stopAgentButton.hidden = !["working", "stopping"].includes(status);
  elements.deleteAgentSessionButton.disabled = !session || ["working", "stopping"].includes(status);
  elements.exportAgentSessionButton.disabled = !session;
  elements.agentWindowButton.textContent = state.isAgentWindow || state.agentDetached ? "↙" : "↗";
  elements.agentWindowButton.title = state.isAgentWindow || state.agentDetached ? "收回工作台" : "在独立窗口打开";
  elements.closeAgentWorkspaceButton.title = state.isAgentWindow ? "收回工作台" : "关闭 AI 创建标签";
  const supportsImages = agentSupportsImages();
  elements.agentAttachButton.disabled = !session || !supportsImages || status === "stopping";
  elements.agentAttachButton.title = supportsImages ? "添加参考图片，也可以粘贴或拖入" : "当前模型仅支持文本";
  elements.agentVisionStatus.textContent = supportsImages
    ? "支持图片理解 · 可选择、粘贴或拖入图片 · AI 对话可访问当前模型 API"
    : "当前模型不支持图片 · AI 对话仍可访问当前模型 API；可切换多模态模型";
  elements.submitGenerateButton.disabled = !session || !WorkbenchPresentation.canUseProfile(selectedProfile) || status === "stopping" ||
    (state.pendingAgentImages.length > 0 && !supportsImages) ||
    (elements.generatePrompt.value.trim().length < 2 && state.pendingAgentImages.length === 0);
  elements.agentActivity.textContent = selectedProfile && !WorkbenchPresentation.canUseProfile(selectedProfile)
    ? `${WorkbenchPresentation.credentialStatus(selectedProfile)}；点击右上角“AI”配置，或切换其他模型。`
    : !state.provider
    ? "尚未连接 AI；点击右上角“AI”进入能力中心"
    : state.agentActivity || (status === "working"
    ? "Agent 正在工作；补充要求可以立即发送，将在当前工具步骤后接入"
    : status === "error" || status === "interrupted"
      ? (session?.error || "可以继续发送消息让 Agent 重试")
      : session?.roomId
        ? "房间已关联；描述修改要求，AI 将直接修改、测试，仅在必要时提问"
        : "先聊清需求，再确认方案，最后开始创建");
  syncAgentSessionSummary();
  renderAgentSessions();
}

function renderAgentWorkspace(options) {
  renderAgentHeader();
  renderAgentTimeline(options);
}

async function loadAgentSession(sessionId, { broadcast = true } = {}) {
  clearPendingAgentImages();
  state.agentSession = await window.workbench.getRoomAgentSession(sessionId);
  if (broadcast) await window.workbench.selectRoomAgentSession(sessionId);
  state.agentActivity = "";
  setInlineStatus(elements.generateStatus, "", false);
  renderAgentWorkspace();
  elements.generatePrompt.focus();
}

async function createAgentSession(roomId = null) {
  clearPendingAgentImages();
  state.agentSession = await window.workbench.createRoomAgentSession({
    ...(roomId ? { roomId } : {}),
    ...(state.provider?.id ? { profileId: state.provider.id } : {})
  });
  await window.workbench.selectRoomAgentSession(state.agentSession.id);
  state.agentActivity = roomId ? "已读取当前房间；告诉 Agent 想怎样修改" : "新对话已创建，可以开始描述需求";
  syncAgentSessionSummary();
  renderAgentWorkspace();
  elements.generatePrompt.focus();
  return state.agentSession;
}

async function showGenerateDialog(roomId = null) {
  if (typeof roomId !== "string") roomId = null;
  if (!state.isAgentWindow && state.agentDetached) {
    if (!roomId) {
      await window.workbench.detachAgent({ force: true });
      return;
    }
    await window.workbench.dockAgent();
    state.agentDetached = false;
  }
  state.agentTabOpen = true;
  state.activeSurface = "agent";
  state.activeRoomId = null;
  await hideRoomForModal();
  if (!elements.generateDialog.open) elements.generateDialog.show();
  renderRooms();
  renderTabs();
  elements.agentConversation.setAttribute("aria-busy", "true");
  setInlineStatus(elements.generateStatus, "正在恢复 Agent 会话……", false);
  try {
    state.agentSessions = await window.workbench.listRoomAgentSessions();
    const preferred = roomId
      ? state.agentSessions.find((session) => session.roomId === roomId)
      : state.agentSessions.find((session) => session.id === state.agentSession?.id) || state.agentSessions[0];
    if (preferred) await loadAgentSession(preferred.id);
    else await createAgentSession(roomId);
    if (roomId && state.agentSession.roomId !== roomId) await createAgentSession(roomId);
    setInlineStatus(elements.generateStatus, "", false);
    if (!state.provider) showToast("尚未连接 AI，可点击右上角“AI”进行配置");
  } catch (error) {
    setInlineStatus(elements.generateStatus, formatError(error), true);
  } finally {
    elements.agentConversation.removeAttribute("aria-busy");
  }
}

async function detachAgentWorkspace({ fromDrag = false } = {}) {
  if (state.isAgentWindow) return { mode: "detached", detached: false };
  state.agentTabOpen = true;
  const result = await window.workbench.detachAgent({ force: !fromDrag, fromDrag });
  if (result.mode !== "detached") return result;
  state.agentDetached = true;
  if (elements.generateDialog.open) elements.generateDialog.close();
  if (state.activeSurface === "agent") state.activeSurface = "home";
  renderRooms();
  renderTabs();
  showToast("AI 创建已移到独立窗口");
  await window.workbench.focusAgentWindow();
  return result;
}

async function dockAgentWorkspace() {
  const result = await window.workbench.dockAgent();
  if (state.isAgentWindow) return result;
  state.agentDetached = false;
  state.agentTabOpen = true;
  await showGenerateDialog();
  showToast("AI 创建已收回工作台");
  return result;
}

async function closeAgentWorkspace() {
  if (state.isAgentWindow) return window.workbench.dockAgent();
  if (state.agentDetached) await window.workbench.closeAgent();
  state.agentDetached = false;
  state.agentTabOpen = false;
  if (elements.generateDialog.open) elements.generateDialog.close();
  if (state.activeSurface === "agent") {
    state.activeSurface = "home";
    state.activeRoomId = null;
  }
  renderRooms();
  renderTabs();
}

function applyAgentWindowState(payload) {
  if (!payload?.mode || state.isAgentWindow) return;
  if (payload.mode === "detached") {
    state.agentDetached = true;
    state.agentTabOpen = true;
    if (elements.generateDialog.open) elements.generateDialog.close();
    if (state.activeSurface === "agent") state.activeSurface = "home";
    renderRooms();
    renderTabs();
    return;
  }
  state.agentDetached = false;
  if (payload.mode === "closed") {
    state.agentTabOpen = false;
    if (state.activeSurface === "agent") state.activeSurface = "home";
    renderRooms();
    renderTabs();
    return;
  }
  state.agentTabOpen = true;
  showGenerateDialog().catch((error) => showToast(formatError(error)));
}

async function generateRoom(event) {
  event.preventDefault();
  if (state.agentSession?.status === "stopping") return;
  const selectedProfile = state.aiProfiles.find(profile => profile.id === (state.agentSession?.profileId || state.provider?.id));
  if (!WorkbenchPresentation.canUseProfile(selectedProfile)) {
    showToast("当前模型缺少可用密钥，请打开 AI 能力中心配置或切换模型。");
    return;
  }
  const prompt = elements.generatePrompt.value.trim();
  const pendingImages = [...state.pendingAgentImages];
  if (!state.agentSession || (prompt.length < 2 && pendingImages.length === 0)) return;
  elements.submitGenerateButton.disabled = true;
  setInlineStatus(elements.generateStatus, pendingImages.length ? `正在发送 ${pendingImages.length} 张图片……` : "正在发送……", false);
  elements.generatePrompt.value = "";
  renderAgentCommandMenu();
  resizeAgentComposer();
  state.agentActivity = "Agent 正在接收需求";
  renderAgentHeader();
  try {
    const result = await window.workbench.sendRoomAgentMessage(state.agentSession.id, prompt, pendingImages.map((item) => item.file));
    if (state.agentSession.id === result.session.id) state.agentSession = result.session;
    clearPendingAgentImages();
    state.agentActivity = result.queued ? "补充要求已排队，将在当前步骤完成后继续" : "Agent 正在分析需求并选择工具";
    setInlineStatus(elements.generateStatus, "", false);
    renderAgentWorkspace();
  } catch (error) {
    elements.generatePrompt.value = prompt;
    resizeAgentComposer();
    setInlineStatus(elements.generateStatus, formatError(error), true);
    state.agentActivity = "发送失败，可以修改后重试";
    renderAgentHeader();
  } finally {
    renderAgentHeader();
    elements.generatePrompt.focus();
  }
}

function applyRoomAgentEvent(payload) {
  if (!payload?.sessionId) return;
  if (payload.type === "session_created" && payload.session) {
    const summary = payload.session;
    if (!state.agentSessions.some((item) => item.id === summary.id)) state.agentSessions.unshift(summary);
  }
  if (state.agentSession?.id !== payload.sessionId) {
    const summary = state.agentSessions.find((item) => item.id === payload.sessionId);
    if (summary && payload.status) summary.status = payload.status;
    renderAgentSessions();
    return;
  }
  const session = state.agentSession;
  if (payload.type === "session_updated" && payload.session) {
    state.agentSession = payload.session;
    state.agentActivity = "";
    renderAgentWorkspace({ keepScroll: true });
    return;
  }
  if (payload.type === "usage_updated") { session.runs = payload.runs; renderAgentUsage(session); return; }
  if (payload.type === "message_added" && payload.message && !session.messages.some((item) => item.id === payload.message.id)) {
    session.messages.push(payload.message);
  } else if (payload.type === "message_delta") {
    const message = session.messages.find((item) => item.id === payload.messageId);
    if (message) {
      const delta = payload.delta || "";
      message.content += delta;
      const article = elements.agentTimeline.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
      const body = article?.querySelector(".agentMessageBody");
      if (body) {
        const nearBottom = elements.agentConversation.scrollHeight - elements.agentConversation.scrollTop - elements.agentConversation.clientHeight < 100;
        if (body.dataset.streamingPlain === "true" && body.firstChild?.nodeType === Node.TEXT_NODE) {
          body.firstChild.appendData(delta);
        } else {
          body.textContent = message.content;
          body.dataset.streamingPlain = "true";
        }
        if (nearBottom) elements.agentConversation.scrollTop = elements.agentConversation.scrollHeight;
        return;
      }
    }
  } else if (payload.type === "message_finished" && payload.message) {
    const index = session.messages.findIndex((item) => item.id === payload.message.id);
    if (index >= 0) session.messages[index] = payload.message;
    else session.messages.push(payload.message);
  } else if (payload.type === "tool_started" && payload.step && !session.steps.some((item) => item.id === payload.step.id)) {
    session.steps.push(payload.step);
    state.agentActivity = payload.step.summary;
  } else if (["tool_updated", "tool_finished"].includes(payload.type) && payload.step) {
    const index = session.steps.findIndex((item) => item.id === payload.step.id);
    if (index >= 0) session.steps[index] = payload.step;
    else session.steps.push(payload.step);
    state.agentActivity = payload.step.progress || "";
    if (payload.type === "tool_updated") {
      const article = elements.agentTimeline.querySelector(`[data-step-id="${CSS.escape(payload.step.id)}"]`);
      const progress = article?.querySelector(".agentToolProgress");
      if (progress) {
        progress.textContent = payload.step.error || payload.step.progress || "执行中";
        elements.agentActivity.textContent = state.agentActivity;
        return;
      }
    }
  } else if (payload.type === "room_ready" && payload.room) {
    session.roomId = payload.room.id;
    const runningStep = [...session.steps].reverse().find((step) => step.status === "running" && (step.toolName.startsWith("build_") || step.toolName === "install_custom_room"));
    if (runningStep) runningStep.details = { ...(payload.details || {}), room: payload.room };
    state.agentActivity = `“${payload.room.name}”已构建，可以直接打开或继续修改`;
    showToast(`Agent 已完成“${payload.room.name}” v${payload.room.version}`);
  } else if (payload.type === "status") {
    session.status = payload.status;
    session.error = payload.error || "";
    if (payload.error) state.agentActivity = payload.error;
  } else if (payload.type === "activity") {
    state.agentActivity = payload.label || "";
    elements.agentActivity.textContent = state.agentActivity;
    return;
  }
  session.updatedAt = new Date().toISOString();
  renderAgentWorkspace({ keepScroll: true });
}

async function showModifyDialog() {
  const room = roomById(state.activeRoomId);
  if (!isAiModifiable(room)) {
    showToast("该房间未开放 AI 修改：仅支持本机生成的房间，或分享时发布者允许修改的房间");
    return;
  }
  if (!state.provider) {
    showToast("请先配置 AI Provider");
    await showProviderDialog();
    return;
  }
  await showGenerateDialog(room.id);
}

async function modifyRoom(event) {
  event.preventDefault();
  if (!state.activeRoomId) return;
  elements.submitModifyButton.disabled = true;
  setInlineStatus(elements.modifyStatus, "正在创建修改前检查点并调用 Pi AI……", false);
  try {
    const result = await window.workbench.modifyRoom(state.activeRoomId, elements.modifyForm.elements.prompt.value);
    elements.modifyDialog.close();
    elements.modifyForm.reset();
    const qualitySummary = result.repaired ? "自动修复后通过质量检查" : "一次修改并通过质量检查";
    showToast(`已更新“${result.room.name}”至 v${result.room.version} · ${qualitySummary}`);
    await openRoom(result.room.id);
  } catch (error) {
    setInlineStatus(elements.modifyStatus, formatError(error), true);
  } finally {
    elements.submitModifyButton.disabled = false;
  }
}

async function restoreActiveRoomAfterDialog() {
  if (state.navigatingAiUtility || document.querySelector("dialog[open]:not(#generateDialog)")) return;
  if (state.activeRoomId) {
    await syncViewport();
    if (state.navigatingAiUtility || document.querySelector("dialog[open]:not(#generateDialog)")) return;
    await window.workbench.openRoom(state.activeRoomId);
  }
}

async function initialize() {
  const initial = await window.workbench.getState();
  state.rooms = initial.rooms;
  state.provider = initial.provider;
  state.aiProfiles = initial.aiProfiles || (initial.provider ? [initial.provider] : []);
  state.aiUtilityProfiles = initial.aiUtilityProfiles || {};
  state.aiProviders = initial.aiProviders;
  state.aiCapabilities = initial.aiCapabilities;
  state.networkPolicy = initial.networkPolicy;
  state.credentials = initial.credentials || [];
  state.environment = initial.environment;
  state.dataLocation = initial.dataLocation || null;
  document.getElementById("dataLocation").textContent = state.dataLocation || "数据路径暂不可用";
  document.getElementById("storageLocationValue").textContent = state.dataLocation || "数据路径暂不可用";
  document.getElementById("storageSummaryNav").textContent = state.dataLocation || "查看安装目录";
  if (initial.storageWarning) setInlineStatus(document.getElementById("storageLocationStatus"), initial.storageWarning, true);
  refreshExamples().catch(error => console.warn("读取内置房间更新失败", error.message));
  state.roomModules = initial.roomModules;
  state.agentDetached = initial.agentWindow?.mode === "detached";
  if (state.isAgentWindow) {
    document.body.classList.add("agentWindow");
    document.title = "AI 创建房间 · 千万间 Roomillion";
    document.getElementById("windowTitlebarTitle").textContent = "AI 创建房间 · 千万间 Roomillion";
    state.activeSurface = "agent";
    state.agentTabOpen = true;
  }
  elements.appVersionLabel.textContent = `v${initial.environment.appVersion} 技术预览 · AI 房间工作台`;
  state.detachedRoomIds = new Set((initial.roomWindows || []).filter((item) => item.mode === "detached").map((item) => item.roomId));
  const environmentSummary = document.getElementById("environmentSummary");
  environmentSummary.textContent = `Electron ${initial.environment.electron} · 内置 Node.js ${initial.environment.node} · ${initial.environment.platform}/${initial.environment.arch}`;
  environmentSummary.title = `工作台 v${initial.environment.appVersion} · Chromium ${initial.environment.chrome} · 官方模块 ${initial.roomModules.length} 个 · ${initial.environment.git}`;
  document.getElementById("runtimeDetails").textContent = `工作台：v${initial.environment.appVersion} · Electron ${initial.environment.electron} · 内置 Node.js ${initial.environment.node}\n房间界面：Chromium ${initial.environment.chrome}（隔离运行）\n系统：${initial.environment.platform}/${initial.environment.arch}\n官方模块：${initial.roomModules.length} 个 · ${initial.environment.git}`;
  renderRooms();
  renderTabs();
  renderProvider();
  renderNetworkPolicy();
  window.workbench.onRoomsChanged((rooms) => {
    state.rooms = rooms;
    state.tabs = state.tabs.filter((roomId) => rooms.some((room) => room.id === roomId));
    state.detachedRoomIds = new Set([...state.detachedRoomIds].filter((roomId) => rooms.some((room) => room.id === roomId)));
    if (state.activeRoomId && !rooms.some((room) => room.id === state.activeRoomId)) state.activeRoomId = null;
    renderRooms();
    renderTabs();
  });
  window.workbench.onRoomWindowState(applyRoomWindowState);
  window.workbench.onRoomAgentEvent(applyRoomAgentEvent);
  window.workbench.onAgentWindowState(applyAgentWindowState);
  window.workbench.onAiStateChanged((result) => {
    applyAiState(result);
    renderProvider();
    renderAgentHeader();
  });
  window.workbench.onRoomAgentSessionSelected((sessionId) => {
    if (sessionId && state.agentSession?.id !== sessionId) {
      loadAgentSession(sessionId, { broadcast: false }).catch((error) => showToast(formatError(error)));
    }
  });
  window.workbench.onOpenRoomRequested((roomId) => {
    if (!state.isAgentWindow) openRoom(roomId).catch((error) => showToast(formatError(error)));
  });
  if (!state.isAgentWindow) {
    const openAssociatedRoom = (packagePath) => beginImport(packagePath).catch((error) => showToast(formatError(error)));
    window.workbench.onRoomImportRequested(openAssociatedRoom);
    const pendingRoomImports = await window.workbench.takePendingRoomImports();
    if (pendingRoomImports[0]) await openAssociatedRoom(pendingRoomImports[0]);
  }

  new ResizeObserver(() => {
    if (state.activeSurface === "room" && state.activeRoomId) syncViewport().catch(() => {});
  }).observe(elements.viewport);
  new ResizeObserver(() => requestAnimationFrame(updateTabOverflow)).observe(document.getElementById("tabRail"));
  if (state.isAgentWindow) await showGenerateDialog();
}

document.getElementById("generateButton").addEventListener("click", showGenerateDialog);
document.getElementById("welcomeGenerate").addEventListener("click", showGenerateDialog);
document.getElementById("importButton").addEventListener("click", () => beginImport());
document.getElementById("welcomeImport").addEventListener("click", () => beginImport());
elements.sidebarToggle.addEventListener("click", cycleSidebarState);
elements.workbenchSettingsButton.addEventListener("click", () => showSettingsHub().catch((error) => showToast(formatError(error))));
for (const item of elements.settingsHubDialog.querySelectorAll("[data-settings-section]")) {
  item.addEventListener("click", () => switchSettingsSection(item.dataset.settingsSection));
}
document.getElementById("openAppearanceButton").addEventListener("click", () => { closeSettingsHub(); showWorkbenchSettings().catch((error) => showToast(formatError(error))); });
document.getElementById("openAiCenterButton").addEventListener("click", () => { closeSettingsHub(); showProviderDialog().catch((error) => showToast(formatError(error))); });
for (const card of document.querySelectorAll("[data-ai-utility-kind]")) {
  card.addEventListener("click", () => showAiUtilityDialog(card.dataset.aiUtilityKind).catch((error) => showToast(formatError(error))));
}
elements.aiUtilityBackButton.addEventListener("click", () => returnFromAiUtilityDialog().catch((error) => showToast(formatError(error))));
elements.saveAiUtilityButton.addEventListener("click", () => saveAiUtilityProfile());
elements.testAiUtilityButton.addEventListener("click", () => saveAiUtilityProfile({ test: true }));
elements.clearAiUtilityKeyButton.addEventListener("click", async () => {
  const kind = state.editingAiUtilityKind;
  if (!AI_UTILITY_META[kind]) return;
  try {
    state.aiUtilityProfiles = await window.workbench.clearAiCapabilityKey(kind);
    elements.aiUtilityRememberKey.checked = false;
    renderAiUtilityProfiles();
    setInlineStatus(elements.aiUtilityStatus, "该能力的会话密钥和系统加密密钥已清除。", false);
  } catch (error) { setInlineStatus(elements.aiUtilityStatus, formatError(error), true); }
});
elements.deleteAiUtilityButton.addEventListener("click", async () => {
  const kind = state.editingAiUtilityKind;
  if (!AI_UTILITY_META[kind] || !window.confirm(`删除“${AI_UTILITY_META[kind].title}”配置？使用此能力的房间会收到未配置提示。`)) return;
  try {
    state.aiUtilityProfiles = await window.workbench.deleteAiCapabilityProfile(kind);
    renderAiUtilityProfiles();
    elements.aiUtilityDialog.close();
    showToast(`${AI_UTILITY_META[kind].title}配置已删除`);
  } catch (error) { setInlineStatus(elements.aiUtilityStatus, formatError(error), true); }
});
for (const select of [elements.settingsDefaultRoomModelSelect, elements.providerDefaultRoomModelSelect]) {
  select.addEventListener("change", async () => {
    if (!select.value || select.value === state.provider?.id) return;
    select.disabled = true;
    await setActiveProvider(select.value);
    renderDefaultRoomModelControls();
  });
}
document.getElementById("openNetworkButton").addEventListener("click", () => { closeSettingsHub(); showNetworkDialog().catch((error) => showToast(formatError(error))); });
document.getElementById("openDiagnosticsButton").addEventListener("click", () => { closeSettingsHub(); showDiagnosticsDialog().catch((error) => showToast(formatError(error))); });
document.getElementById("changeStorageLocationButton").addEventListener("click", async () => {
  const status = document.getElementById("storageLocationStatus");
  try {
    const result = await window.workbench.chooseRoomStorageLocation();
    if (result.canceled) return;
    if (!result.changed) {
      setInlineStatus(status, "当前已经使用这个房间位置。", false);
      return;
    }
    setInlineStatus(status, `新位置：${result.target}。请关闭并重新打开程序；下次启动会复制现有房间与数据，旧目录会保留。`, false);
  } catch (error) {
    setInlineStatus(status, formatError(error), true);
  }
});

for (const button of document.querySelectorAll("[data-theme-choice]")) {
  button.addEventListener("click", () => applyWorkbenchTheme(button.dataset.themeChoice, { announce: true }));
}
elements.resetThemeButton.addEventListener("click", () => applyWorkbenchTheme(DEFAULT_WORKBENCH_THEME, { announce: true }));
if (themeChannel) {
  themeChannel.addEventListener("message", (event) => {
    if (event.data?.type === "theme") applyWorkbenchTheme(event.data.themeId, { persist: false, broadcast: false });
  });
}
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) applyWorkbenchTheme(event.newValue, { persist: false, broadcast: false });
});
elements.tabsScrollBack.addEventListener("click", () => elements.tabs.scrollBy({ left: -Math.max(220, elements.tabs.clientWidth * .55), behavior: "smooth" }));
elements.tabsScrollForward.addEventListener("click", () => elements.tabs.scrollBy({ left: Math.max(220, elements.tabs.clientWidth * .55), behavior: "smooth" }));
elements.tabs.addEventListener("scroll", updateTabOverflow, { passive: true });
elements.tabs.addEventListener("wheel", (event) => {
  if (elements.tabs.scrollWidth <= elements.tabs.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  elements.tabs.scrollLeft += event.deltaY;
}, { passive: false });
elements.tabOverviewButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderMenu("tabs");
});
elements.headerMoreButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderMenu("more");
});
elements.headerMoreMenu.addEventListener("click", (event) => {
  if (!event.target.closest("button")) return;
  closeHeaderMenus({ restoreRoom: false });
});
elements.detachButton.addEventListener("click", () => {
  if (state.activeSurface === "agent") detachAgentWorkspace().catch((error) => showToast(formatError(error)));
  else if (state.activeRoomId) detachRoom(state.activeRoomId).catch((error) => showToast(formatError(error)));
});
document.getElementById("exampleButton").addEventListener("click", showExamplesDialog);
document.getElementById("exampleUpdateNotice").addEventListener("click", showExamplesDialog);
document.getElementById("welcomeExample").addEventListener("click", showExamplesDialog);
elements.detailsButton.addEventListener("click", showDetailsDialog);
elements.detailsSaveAiModelButton.addEventListener("click", () => saveDetailsAiModel());
elements.detailsTestAiModelButton.addEventListener("click", () => testDetailsAiModel());
document.getElementById("detailsOpenAiCenterButton").addEventListener("click", () => {
  elements.detailsDialog.close();
  showProviderDialog().catch((error) => showToast(formatError(error)));
});
elements.modifyButton.addEventListener("click", showModifyDialog);
elements.backupButton.addEventListener("click", showBackupDialog);
elements.restoreButton.addEventListener("click", showRestoreDialog);
document.getElementById("providerButton")?.addEventListener("click", showProviderDialog);
document.getElementById("networkButton")?.addEventListener("click", () => showNetworkDialog().catch((error) => showToast(formatError(error))));
document.getElementById("diagnosticsButton")?.addEventListener("click", showDiagnosticsDialog);
elements.networkForm.addEventListener("submit", saveNetworkPolicy);
elements.saveCredentialButton.addEventListener("click", saveNamedCredential);
document.getElementById("importProviderButton").addEventListener("click", importProviderConfig);
// Put credentials before model selection, matching the visible connection steps.
const credentialAnchor = document.getElementById("modelSelectField");
for (const field of [
  document.getElementById("credentialReuseNotice"),
  elements.providerApiKey.closest("label"),
  elements.providerForm.elements.rememberKey.closest("label")
]) credentialAnchor.before(field);

const agentShell = document.querySelector(".agentShell");
const agentSidebarToggle = document.getElementById("agentSidebarToggle");
function setAgentSidebar(open) {
  agentShell.classList.toggle("historyOpen", open);
  agentSidebarToggle.setAttribute("aria-expanded", String(open));
  agentSidebarToggle.setAttribute("aria-label", open ? "收起历史对话" : "展开历史对话");
}
setAgentSidebar(window.innerWidth >= 1500);
agentSidebarToggle.addEventListener("click", () => setAgentSidebar(!agentShell.classList.contains("historyOpen")));
document.getElementById("renameAgentSessionButton").addEventListener("click", () => {
  const session = state.agentSession;
  if (!session) return;
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "对话名称（最多 80 字）";
  const input = document.createElement("input");
  input.value = session.title;
  input.maxLength = 80;
  input.required = true;
  label.append(input);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.onclick = () => dialog.close();
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "保存名称";
  form.append(label, cancel, save);
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const updated = await window.workbench.renameRoomAgentSession(session.id, input.value);
      if (state.agentSession?.id === session.id) state.agentSession = updated;
      syncAgentSessionSummary();
      renderAgentSessions();
      renderAgentHeader();
      dialog.close();
    } catch (error) { showToast(formatError(error)); save.disabled = false; }
  };
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  input.select();
});

elements.newProviderButton.addEventListener("click", startNewProvider);
elements.cancelProviderEditorButton.addEventListener("click", () => {
  closeProviderEditor();
  setInlineStatus(elements.providerStatus, "已收起添加区域；已连接的提供商和模型没有变化。", false);
});
document.getElementById("saveProviderButton").addEventListener("click", () => saveProviderSelection().catch((error) => setInlineStatus(elements.providerStatus, formatError(error), true)));
document.getElementById("testProviderButton").addEventListener("click", testProvider);
elements.providerSelect.addEventListener("change", () => {
  elements.providerDialog.classList.remove("choosingProvider");
  state.credentialSourceProfileId = null;
  resetProviderModelSelection();
  elements.providerSelect.disabled = false;
  elements.providerPickerButton.disabled = false;
  elements.providerApiKey.value = "";
  elements.providerForm.elements.rememberKey.checked = false;
  renderProviderFields();
  const provider = selectedProvider();
  setInlineStatus(
    elements.providerStatus,
    provider?.configurable === false
      ? provider.limitation
      : provider?.configurationHint || "填写该提供商的 API Key，勾选一个或多个模型后启用。",
    provider?.configurable === false
  );
});
elements.providerSearch.addEventListener("input", () => {
  const previousProviderId = elements.providerSelect.value;
  state.providerQuery = elements.providerSearch.value;
  renderProviderChoices(previousProviderId);
  if (elements.providerSelect.value !== previousProviderId) {
    state.credentialSourceProfileId = null;
    resetProviderModelSelection();
    elements.providerApiKey.value = "";
    elements.providerForm.elements.rememberKey.checked = false;
  }
  renderProviderFields();
  // Filtering must not move focus/caret out of the search input (including IME input).
  setProviderPickerOpen(true, { focusChoice: false });
});
elements.providerSearch.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setProviderPickerOpen(true);
  }
});
elements.providerPickerButton.addEventListener("click", () => {
  setProviderPickerOpen(elements.providerChoiceList.hidden);
});
elements.providerChoiceList.addEventListener("keydown", (event) => {
  const choices = [...elements.providerChoiceList.querySelectorAll(".providerChoice:not(:disabled)")];
  const index = choices.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    choices[(index + direction + choices.length) % choices.length]?.focus({ preventScroll: true });
  }
  if (event.key === "Escape") {
    event.preventDefault();
    setProviderPickerOpen(false);
    elements.providerPickerButton.focus({ preventScroll: true });
  }
});
elements.modelSelect.addEventListener("change", updateModelSummary);
elements.providerModelSearch.addEventListener("input", () => {
  const provider = selectedProvider();
  if (!provider) return;
  state.providerModelQuery = elements.providerModelSearch.value;
  renderProviderModelList(provider);
});
elements.selectAllProviderModels.addEventListener("click", () => {
  const provider = selectedProvider();
  if (!provider) return;
  const configured = configuredModelIds(provider);
  for (const model of [...provider.models, ...catalogExtraModels(provider)]) {
    if (!configured.has(model.id)) state.pendingProviderModelIds.add(model.id);
  }
  renderProviderModelList(provider);
});
elements.clearProviderModels.addEventListener("click", () => {
  const provider = selectedProvider();
  if (!provider) return;
  state.pendingProviderModelIds.clear();
  renderProviderModelList(provider);
});
elements.fetchProviderModelsButton.addEventListener("click", () => {
  fetchProviderModelsAction().catch((error) => showToast(formatError(error)));
});
for (const target of [
  elements.customCatalogModelIds,
  elements.customModelContextWindow,
  elements.customModelSupportsImages,
  elements.customModelSupportsAudio
]) {
  target.addEventListener("input", () => {
    const provider = selectedProvider();
    if (provider && !editingProviderProfile()) renderProviderModelList(provider);
  });
  target.addEventListener("change", () => {
    const provider = selectedProvider();
    if (provider && !editingProviderProfile()) renderProviderModelList(provider);
  });
}
document.getElementById("cancelCredentialReuseButton").addEventListener("click", () => {
  const currentModel = elements.modelSelect.value;
  state.credentialSourceProfileId = null;
  resetProviderModelSelection();
  elements.providerSelect.disabled = false;
  elements.providerPickerButton.disabled = false;
  renderProviderFields(currentModel);
  elements.providerForm.elements.rememberKey.checked = false;
  setInlineStatus(elements.providerStatus, "请输入这个模型要使用的新 API Key。", false);
});
elements.clearKeyButton.addEventListener("click", async () => {
  const profile = editingProviderProfile();
  if (!profile) {
    setInlineStatus(elements.providerStatus, "请先选择一个已配置模型。", true);
    return;
  }
  const updated = await window.workbench.clearSessionKey(profile.id);
  state.aiProfiles = state.aiProfiles.map((entry) => entry.id === updated.id ? updated : entry);
  if (state.provider?.id === updated.id) state.provider = updated;
  renderProvider();
  setInlineStatus(elements.providerStatus, "该配置的会话密钥和系统加密密钥已清除。", false);
});
elements.unlockImportForm.addEventListener("submit", unlockRoomImport);
elements.unlockImportDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelLockedImport();
});
document.getElementById("cancelUnlockImportButton").addEventListener("click", cancelLockedImport);
document.getElementById("cancelUnlockImportTopButton").addEventListener("click", cancelLockedImport);
elements.importForm.addEventListener("submit", confirmImport);
elements.importDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelPendingImport();
});
document.getElementById("cancelImportButton").addEventListener("click", cancelPendingImport);
document.getElementById("cancelImportTopButton").addEventListener("click", cancelPendingImport);
elements.detailsForm.addEventListener("submit", saveRoomPermissions);
elements.createCheckpointButton.addEventListener("click", createManualCheckpoint);
elements.exportForm.addEventListener("submit", exportRoomPackage);
elements.exportForm.addEventListener("change", (event) => {
  if (event.target.name === "mode" || event.target.name === "protect") updateExportMode();
});
elements.backupForm.addEventListener("submit", exportRoomData);
elements.restoreForm.addEventListener("submit", confirmDataRestore);
elements.restoreDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelPendingRestore();
});
document.getElementById("cancelRestoreButton").addEventListener("click", cancelPendingRestore);
document.getElementById("cancelRestoreTopButton").addEventListener("click", cancelPendingRestore);
elements.generateForm.addEventListener("submit", generateRoom);
elements.newAgentSessionButton.addEventListener("click", () => createAgentSession().catch((error) => showToast(formatError(error))));
document.getElementById("agentTopNewButton").addEventListener("click", () => createAgentSession().catch((error) => showToast(formatError(error))));
elements.agentNewTaskButton.addEventListener("click", () => createAgentSession().catch((error) => showToast(formatError(error))));
elements.exportAgentSessionButton.addEventListener("click", async () => {
  const sessionId = state.agentSession?.id;
  if (!sessionId) return;
  try {
    const result = await window.workbench.exportRoomAgentSession(sessionId);
    if (result?.filePath) showToast("对话记录已导出");
  } catch (error) {
    showToast(formatError(error));
  }
});
elements.deleteAgentSessionButton.addEventListener("click", async () => {
  const session = state.agentSession;
  if (!session || !window.confirm(`删除对话“${session.title}”及其中的参考图片？已生成的房间不会删除。`)) return;
  try {
    await window.workbench.deleteRoomAgentSession(session.id);
    state.agentSessions = state.agentSessions.filter((item) => item.id !== session.id);
    for (const key of [...state.agentAttachmentCache.keys()]) {
      if (key.startsWith(`${session.id}:`)) state.agentAttachmentCache.delete(key);
    }
    state.agentSession = null;
    await createAgentSession();
    showToast("对话及参考图片已删除");
  } catch (error) {
    showToast(formatError(error));
  }
});
elements.stopAgentButton.addEventListener("click", async () => {
  if (!state.agentSession) return;
  try {
    await window.workbench.abortRoomAgent(state.agentSession.id);
    state.agentActivity = "正在停止当前 Agent 运行";
    renderAgentHeader();
  } catch (error) {
    showToast(formatError(error));
  }
});
elements.generatePrompt.addEventListener("keydown", (event) => {
  const commands = matchingAgentCommands();
  if (commands.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    state.agentCommandIndex = (state.agentCommandIndex + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length;
    renderAgentCommandMenu();
    elements.agentCommandMenu.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (commands.length && event.key === "Tab" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    chooseAgentCommand(commands[state.agentCommandIndex] || commands[0]);
    return;
  }
  if (event.key === "Escape" && !elements.agentCommandMenu.hidden) {
    event.preventDefault();
    elements.agentCommandMenu.hidden = true;
    return;
  }
  if (!WorkbenchPresentation.shouldSubmitAgentPrompt(event)) return;
  event.preventDefault();
  elements.generateForm.requestSubmit();
});
elements.generatePrompt.addEventListener("input", () => {
  resizeAgentComposer();
  state.agentCommandIndex = 0;
  renderAgentCommandMenu();
  renderAgentHeader();
});
elements.generatePrompt.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && looksLikeAgentImage(item.getAsFile()))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (images.length) addAgentImages(images);
});
elements.agentAttachButton.addEventListener("click", () => elements.agentImageInput.click());
document.getElementById("agentProjectButton").addEventListener("click", async () => {
  const sessionId = state.agentSession?.id;
  if (!sessionId) return;
  const button = document.getElementById("agentProjectButton");
  button.disabled = true;
  try {
    const result = await window.workbench.importSourceProject(sessionId);
    if (result && state.agentSession?.id === sessionId) {
      state.agentSession = result;
      if (!elements.generatePrompt.value.trim()) elements.generatePrompt.value = "请评估这个项目能否迁移为房间，先与我确认需要保留的功能，再给出适配或重构方案。";
      state.agentActivity = "源码快照已就绪；点击发送后 AI 才会读取并评估。可展开查看收集范围。";
      renderAgentWorkspace();
    }
  } catch (error) { showToast(formatError(error)); }
  finally { renderAgentHeader(); }
});
elements.agentProviderSettingsButton.addEventListener("click", () => showProviderDialog().catch((error) => showToast(formatError(error))));
elements.agentModelSelect.addEventListener("change", async () => {
  if (!state.agentSession || !elements.agentModelSelect.value) return;
  const previousProfileId = state.agentSession.profileId || state.agentSession.provider?.profileId || "";
  elements.agentModelSelect.disabled = true;
  try {
    state.agentSession = await window.workbench.setRoomAgentModel(state.agentSession.id, elements.agentModelSelect.value);
    state.agentActivity = "已切换编程模型：" + (state.agentSession.provider?.model || "当前模型");
    renderAgentHeader();
  } catch (error) {
    elements.agentModelSelect.value = previousProfileId;
    showToast(formatError(error));
    renderAgentHeader();
  }
});
elements.agentWindowButton.addEventListener("click", () => {
  (state.isAgentWindow || state.agentDetached ? dockAgentWorkspace() : detachAgentWorkspace()).catch((error) => showToast(formatError(error)));
});
elements.closeAgentWorkspaceButton.addEventListener("click", () => closeAgentWorkspace().catch((error) => showToast(formatError(error))));
elements.agentImageInput.addEventListener("change", () => addAgentImages(elements.agentImageInput.files || []));
for (const eventName of ["dragenter", "dragover"]) {
  elements.generateDialog.addEventListener(eventName, (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    elements.generateForm.classList.add("agentImageDrag");
  });
}
elements.generateDialog.addEventListener("dragleave", (event) => {
  if (event.relatedTarget && elements.generateDialog.contains(event.relatedTarget)) return;
  elements.generateForm.classList.remove("agentImageDrag");
});
elements.generateDialog.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  elements.generateForm.classList.remove("agentImageDrag");
  addAgentImages(event.dataTransfer.files || []);
});
for (const button of document.querySelectorAll("[data-agent-suggestion]")) {
  button.addEventListener("click", () => {
    elements.generatePrompt.value = button.dataset.agentSuggestion;
    elements.generatePrompt.focus();
  });
}
elements.modifyForm.addEventListener("submit", modifyRoom);
elements.diagnosticsForm.addEventListener("submit", exportDiagnostics);
elements.exportButton.addEventListener("click", () => showExportDialog().catch((error) => showToast(formatError(error))));
async function uninstallRoom(roomId) {
  if (!roomId || !roomById(roomId)) return;
  const wasActive = state.activeRoomId === roomId;
  try {
    const result = await window.workbench.uninstallRoom(roomId);
    if (!result?.uninstalled) {
      if (!elements.detailsDialog.open) await restoreActiveRoomAfterDialog();
      return;
    }
    state.rooms = state.rooms.filter((room) => room.id !== roomId);
    state.tabs = state.tabs.filter((id) => id !== roomId);
    state.detachedRoomIds.delete(roomId);
    if (wasActive) state.activeRoomId = null;
    if (elements.detailsDialog.open && state.detailsRoomId === roomId) elements.detailsDialog.close();
    renderRooms();
    renderTabs();
    const message = result.dataRetained
      ? "房间已卸载，业务数据已保留；重装相同房间可继续使用"
      : "房间及其本地数据已彻底卸载";
    showToast(result.historyWarning ? `${message}；版本历史清理需要稍后重试` : message);
    if (state.activeRoomId) await openRoom(state.activeRoomId);
  } catch (error) {
    showToast(formatError(error));
    if (!elements.detailsDialog.open) await restoreActiveRoomAfterDialog();
  }
}

elements.uninstallButton.addEventListener("click", () => {
  if (state.activeRoomId) uninstallRoom(state.activeRoomId);
});
elements.detailsUninstallButton.addEventListener("click", () => {
  if (state.detailsRoomId) uninstallRoom(state.detailsRoomId);
});
elements.roomContextMenu.addEventListener("click", (event) => {
  const action = event.target.closest("[data-room-context-action]")?.dataset.roomContextAction;
  const roomId = state.contextRoomId;
  hideRoomContextMenu();
  if (action === "export" && roomId) showExportDialog(roomId).catch((error) => showToast(formatError(error)));
  if (action === "uninstall" && roomId) uninstallRoom(roomId);
});
document.addEventListener("pointerdown", (event) => {
  if (!elements.providerChoiceList.hidden && !elements.providerPickerField.contains(event.target)) setProviderPickerOpen(false);
  if (!elements.roomContextMenu.hidden && !elements.roomContextMenu.contains(event.target)) hideRoomContextMenu();
  const outsideTabMenu = !elements.tabOverviewMenu.hidden && !event.target.closest("#tabRail");
  const outsideMoreMenu = !elements.headerMoreMenu.hidden && !elements.headerMoreWrap.contains(event.target);
  if (outsideTabMenu || outsideMoreMenu) closeHeaderMenus().catch((error) => showToast(formatError(error)));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.roomContextMenu.hidden) hideRoomContextMenu();
  if (event.key === "Escape") {
    setProviderPickerOpen(false);
    closeHeaderMenus().catch((error) => showToast(formatError(error)));
  }
});
window.addEventListener("resize", () => {
  hideRoomContextMenu();
  closeHeaderMenus().catch((error) => showToast(formatError(error)));
  updateTabOverflow();
});
elements.roomList.addEventListener("scroll", hideRoomContextMenu);

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
}
elements.providerDialog.addEventListener("close", () => {
  setProviderPickerOpen(false);
  restoreActiveRoomAfterDialog();
});
elements.aiUtilityDialog.addEventListener("close", () => {
  state.editingAiUtilityKind = null;
  state.aiUtilityReturnTarget = null;
  restoreActiveRoomAfterDialog();
});
elements.workbenchSettingsDialog.addEventListener("close", restoreActiveRoomAfterDialog);
elements.networkDialog.addEventListener("close", restoreActiveRoomAfterDialog);
elements.agentImagePreviewDialog.addEventListener("close", () => {
  elements.agentImagePreview.removeAttribute("src");
});
elements.modifyDialog.addEventListener("close", restoreActiveRoomAfterDialog);
elements.detailsDialog.addEventListener("close", restoreActiveRoomAfterDialog);
elements.exportDialog.addEventListener("close", () => {
  if (elements.exportDialog.open) return;
  state.exportRoomId = null;
  restoreActiveRoomAfterDialog();
});
elements.backupDialog.addEventListener("close", restoreActiveRoomAfterDialog);
elements.restoreDialog.addEventListener("close", restoreActiveRoomAfterDialog);
elements.diagnosticsDialog.addEventListener("close", restoreActiveRoomAfterDialog);
elements.examplesDialog.addEventListener("close", restoreActiveRoomAfterDialog);

document.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  if (elements.generateDialog.open || state.isAgentWindow) return;
  event.preventDefault();
  state.dragDepth += 1;
  document.body.classList.add("dragging");
});
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  if (elements.generateDialog.open || state.isAgentWindow) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", () => {
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (event) => {
  if (elements.generateDialog.open || state.isAgentWindow) return;
  event.preventDefault();
  state.dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = [...(event.dataTransfer?.files ?? [])].filter((file) => {
    const name = file.name.toLowerCase();
    return name.endsWith(".room");
  });
  if (files.length !== 1) {
    showToast("请一次拖入一个 .room 文件");
    return;
  }
  beginImport(files[0]);
});

const FONT_SIZE_KEY = "zhibian.appearance.font-size.v1";
function applyWorkbenchFontSize(value, { persist = true, broadcast = persist } = {}) {
  const size = ["standard", "large", "extra"].includes(value) ? value : "standard";
  document.documentElement.dataset.fontSize = size;
  document.getElementById("workbenchFontSize").value = size;
  if (persist) { try { localStorage.setItem(FONT_SIZE_KEY, size); } catch {} }
  if (broadcast) themeChannel?.postMessage({ type: "font-size", value: size });
  requestAnimationFrame(() => { if (typeof syncViewport === "function") syncViewport().catch(() => {}); });
}
document.getElementById("workbenchFontSize").addEventListener("change", (event) => applyWorkbenchFontSize(event.target.value));
window.addEventListener("storage", (event) => { if (event.key === FONT_SIZE_KEY) applyWorkbenchFontSize(event.newValue, { persist: false }); });
themeChannel?.addEventListener("message", (event) => { if (event.data?.type === "font-size") applyWorkbenchFontSize(event.data.value, { persist: false }); });
let savedFontSize;
try { savedFontSize = localStorage.getItem(FONT_SIZE_KEY); } catch {}
applyWorkbenchFontSize(savedFontSize, { persist: false });
setInterval(() => { if (state.agentSession?.runs?.some((run) => run.status === "working") && elements.generateDialog.open) renderAgentUsage(state.agentSession); }, 1000);
applyWorkbenchTheme(readStoredTheme(), { persist: false, broadcast: false });
applySidebarState(readStoredSidebarState(), { persist: false });
initialize().catch((error) => showToast(formatError(error)));
