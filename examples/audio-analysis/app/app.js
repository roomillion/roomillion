"use strict";

const MODES = Object.freeze({
  music: {
    hint: "选择一段音乐，AI 会分析乐器编制、风格流派、情绪氛围、节奏速度和结构段落。分析质量取决于所选模型的真实音频能力。",
    runLabel: "开始分析",
    resultTitle: "音乐分析",
    maxTokens: 2000,
    timeoutMs: 180000,
    prompt: "请仔细听这段音频，用简体中文按以下条目输出音乐分析：\n1. **乐器编制**：识别出现的主奏、伴奏和打击乐器，逐项列出；\n2. **风格与流派**：给出最可能的流派（可列 2–3 个并说明理由）；\n3. **情绪与氛围**：整体情绪走向和画面感；\n4. **节奏与速度**：大致 BPM 区间和节拍感；\n5. **结构段落**：按顺序描述前奏/主歌/副歌/桥段/尾声等结构；\n6. **一句话总结**。\n如果这段音频不是音乐，或听不出某项内容，请如实说明，不要编造。"
  },
  meeting: {
    hint: "选择一段会议录音，AI 会转写成 Markdown：按说话人分段，并在末尾整理讨论要点、决定事项和待办事项。转写质量取决于所选模型的真实音频能力。",
    runLabel: "开始转写",
    resultTitle: "会议记录",
    maxTokens: 6000,
    timeoutMs: 300000,
    prompt: "请把这段会议录音转写成 Markdown 文本，使用简体中文，遵守以下规则：\n1. 按说话人分段，格式为“**说话人 A**：内容”；能辨认名字时用名字，不能辨认时按音色顺序编号；\n2. 保留口语原意，可以去掉口头禅和无意义重复，但不要增删事实内容；\n3. 听不清的部分用 [不可辨] 标注，不要猜测编造；\n4. 转写正文结束后，另起输出三个小节：`## 讨论要点`、`## 决定事项`、`## 待办事项`（待办尽量带负责人和期限，仅限录音中明确提到的）；\n5. 如果这段音频不是会议，请如实说明你听到的内容。"
  }
});

const AUDIO_EXTENSIONS = Object.freeze(["wav", "mp3", "ogg", "flac", "m4a", "webm"]);
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const PREFERENCE_KEY = "audio-analysis-preferences";

const state = {
  mode: "music",
  models: [],
  file: null,
  running: false,
  resultMarkdown: "",
  detachModelListener: null
};

const elements = {
  modelSelect: document.getElementById("modelSelect"),
  modeMusic: document.getElementById("modeMusic"),
  modeMeeting: document.getElementById("modeMeeting"),
  modeHint: document.getElementById("modeHint"),
  pickButton: document.getElementById("pickButton"),
  fileName: document.getElementById("fileName"),
  fileMeta: document.getElementById("fileMeta"),
  runButton: document.getElementById("runButton"),
  resultCard: document.getElementById("resultCard"),
  resultTitle: document.getElementById("resultTitle"),
  resultText: document.getElementById("resultText"),
  exportButton: document.getElementById("exportButton"),
  clearButton: document.getElementById("clearButton"),
  status: document.getElementById("status"),
  toast: document.getElementById("toast")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#b34834" : "#6f7486";
}

let toastTimer = null;
function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function selectedProfileId() {
  return elements.modelSelect.value || null;
}

function audioReadyModels() {
  return state.models.filter((model) => model.supportsAudio === true);
}

function fillModelSelect(preferredProfileId) {
  const models = audioReadyModels();
  elements.modelSelect.replaceChildren();
  if (!models.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "没有支持音频的模型";
    elements.modelSelect.appendChild(empty);
    return;
  }
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.label} · ${model.providerName ?? ""}`.trim();
    option.disabled = model.ready === false;
    elements.modelSelect.appendChild(option);
  }
  const preferred = preferredProfileId && models.some((model) => model.id === preferredProfileId && model.ready !== false)
    ? preferredProfileId
    : (models.find((model) => model.isDefault && model.ready !== false) || models.find((model) => model.ready !== false))?.id || "";
  elements.modelSelect.value = preferred;
}

function updateRunState() {
  const hasModel = audioReadyModels().some((model) => model.id === elements.modelSelect.value && model.ready !== false);
  elements.runButton.disabled = state.running || !state.file || !hasModel;
  elements.runButton.textContent = state.running ? "正在处理……" : MODES[state.mode].runLabel;
  document.body.classList.toggle("running", state.running);
  if (!audioReadyModels().length) {
    setStatus("当前没有声明了音频输入能力的模型。请先在主工作台“AI 能力中心”启用支持音频的模型；目录外模型可在能力设置里勾选“支持音频输入”。", true);
  } else if (state.file && !hasModel) {
    setStatus("请选择一个就绪的音频模型。", true);
  }
}

function applyMode(mode) {
  state.mode = mode;
  elements.modeMusic.classList.toggle("active", mode === "music");
  elements.modeMeeting.classList.toggle("active", mode === "meeting");
  elements.modeHint.textContent = MODES[mode].hint;
  elements.resultTitle.textContent = MODES[mode].resultTitle;
  elements.exportButton.hidden = mode !== "meeting";
  if (!state.running) updateRunState();
}

async function refreshModels() {
  state.models = await window.room.ai.listModels();
  const preferences = await window.room.storage.get(PREFERENCE_KEY);
  fillModelSelect(preferences?.profileId);
  updateRunState();
}

async function pickAudio() {
  const picked = await window.room.files.pickBinary({ extensions: AUDIO_EXTENSIONS });
  if (!picked) return;
  if (picked.size > MAX_AUDIO_BYTES) {
    showToast("音频文件超过 64 MiB，请截取较短的片段", true);
    return;
  }
  if (picked.size < 12) {
    showToast("音频文件内容无效", true);
    return;
  }
  state.file = picked;
  elements.fileName.textContent = picked.name;
  elements.fileMeta.textContent = `${formatSize(picked.size)} · 将交给所选模型直接听取`;
  updateRunState();
  setStatus(`已选择 ${picked.name}，${MODES[state.mode].runLabel.includes("转写") ? "可以开始转写" : "可以开始分析"}。`);
}

async function runAnalysis() {
  if (!state.file || state.running) return;
  const profileId = selectedProfileId();
  if (!profileId) return;
  const mode = MODES[state.mode];
  state.running = true;
  state.resultMarkdown = "";
  elements.resultCard.hidden = false;
  elements.resultText.textContent = "";
  updateRunState();
  setStatus(`已把 ${state.file.name} 发给模型，${state.mode === "meeting" ? "转写可能需要几分钟" : "正在分析"}……`);
  try {
    const result = await window.room.ai.generate(mode.prompt, {
      profileId,
      audio: [{ data: new Uint8Array(state.file.data) }],
      maxTokens: mode.maxTokens,
      timeoutMs: mode.timeoutMs,
      onChunk: (delta, full) => {
        state.resultMarkdown = full;
        elements.resultText.textContent = full;
      }
    });
    state.resultMarkdown = result.text;
    elements.resultText.textContent = result.text;
    setStatus(`完成 · 模型 ${result.model}${result.usage?.totalTokens != null ? ` · ${result.usage.totalTokens} Token` : ""}`);
    showToast(`${state.file.name} 处理完成`);
  } catch (error) {
    setStatus(`处理失败：${error.message}`, true);
    showToast(error.message, true);
  } finally {
    state.running = false;
    updateRunState();
  }
}

async function exportMarkdown() {
  if (!state.resultMarkdown) {
    showToast("还没有可导出的内容", true);
    return;
  }
  const header = `# 会议记录\n\n- 来源音频：${state.file?.name ?? "未知"}\n- 导出时间：${new Date().toLocaleString("zh-CN")}\n\n---\n\n`;
  const saved = await window.room.files.exportText("会议记录.md", header + state.resultMarkdown);
  if (saved) showToast("会议记录已导出");
}

async function savePreferences() {
  await window.room.storage.set(PREFERENCE_KEY, { profileId: selectedProfileId(), mode: state.mode });
}

async function initialize() {
  const preferences = await window.room.storage.get(PREFERENCE_KEY).catch(() => null);
  applyMode(preferences?.mode === "meeting" ? "meeting" : "music");
  await refreshModels();
  elements.modelSelect.addEventListener("change", () => { savePreferences().catch(() => {}); updateRunState(); });
  elements.modeMusic.addEventListener("click", () => { applyMode("music"); savePreferences().catch(() => {}); });
  elements.modeMeeting.addEventListener("click", () => { applyMode("meeting"); savePreferences().catch(() => {}); });
  elements.pickButton.addEventListener("click", () => { pickAudio().catch((error) => showToast(error.message, true)); });
  elements.runButton.addEventListener("click", () => { runAnalysis().catch((error) => showToast(error.message, true)); });
  elements.exportButton.addEventListener("click", () => { exportMarkdown().catch((error) => showToast(error.message, true)); });
  elements.clearButton.addEventListener("click", () => {
    state.resultMarkdown = "";
    elements.resultCard.hidden = true;
    setStatus("");
  });
  state.detachModelListener = window.room.ai.onModelsChanged(() => { refreshModels().catch(() => {}); });
  document.documentElement.dataset.roomReady = "true";
}

initialize().catch((error) => {
  document.documentElement.dataset.roomError = String(error?.message || error);
  setStatus(`初始化失败：${error?.message || error}`, true);
});

window.addEventListener("beforeunload", () => {
  state.detachModelListener?.();
});
