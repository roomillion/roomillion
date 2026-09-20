(function (root) {
  "use strict";
  function canUseProfile(profile) {
    return Boolean(profile && (profile.hasSessionKey || /^http:\/\//.test(profile.baseUrl || "")));
  }
  function credentialStatus(profile) {
    if (!profile) return "尚未配置";
    if (profile.hasSessionKey) return profile.hasStoredKey ? "密钥可用 · 已安全保存" : "密钥可用 · 仅本次会话";
    if (profile.keyStorageError || profile.hasStoredKey) return "已存密钥无法读取 · 请重新输入";
    return canUseProfile(profile) ? "本地服务 · 未配置密钥" : "缺少密钥 · 请配置";
  }
  function importNotices(inspection) {
    const withData = inspection.transfer?.kind === "app-and-data";
    const program = {
      same: `将重新安装当前版本 v${inspection.room.version}。`,
      upgrade: `将从 v${inspection.existing?.version} 更新到 v${inspection.room.version}。`,
      downgrade: `将从 v${inspection.existing?.version} 降级到 v${inspection.room.version}，请确认数据兼容性。`,
      install: `将安装 v${inspection.room.version}。`
    }[inspection.versionChange] || "";
    const legacyData = inspection.transfer?.formatVersion === "0.2";
    return {
      program: program + (withData ? "数据处理见下方说明。" : "仅安装应用，保留现有业务数据。"),
      data: withData ? (inspection.existing
        ? legacyData
          ? "注意：旧版包只会替换本机数据库，不会合并；本机 Blob 和任务文件保持原样。替换前会保留原数据库检查点。"
          : "注意：随包数据库、Blob、制品和任务文件将替换本机现有业务数据，不会合并。替换前仅保留原数据库检查点；原有图片、制品和任务文件不会进入该检查点。"
        : legacyData
          ? "旧版包将以随包数据库快照初始化此房间；不包含 Blob、制品或任务文件。"
          : "将以随包数据库、Blob、制品和任务文件初始化此房间的业务数据。") : "",
      button: withData && inspection.existing ? "安装并替换数据" : withData ? "安装并恢复数据" : "确认并安装"
    };
  }
  function shouldSubmitAgentPrompt(event) {
    return Boolean(event && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229);
  }
  const api = { canUseProfile, credentialStatus, importNotices, shouldSubmitAgentPrompt };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkbenchPresentation = api;
})(typeof globalThis === "object" ? globalThis : this);
