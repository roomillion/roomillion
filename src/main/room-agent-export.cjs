"use strict";

// Export only the user-visible conversation and compact execution evidence.
// The persisted Pi context can contain image data, project snapshots and tool payloads.
function buildRoomAgentExport(session, { appVersion, exportedAt = new Date().toISOString() } = {}) {
  if (!session || typeof session !== "object" || !session.id) throw new Error("对话不存在");
  return {
    formatVersion: "roomillion-agent-chat@1",
    exportedAt,
    appVersion: appVersion || null,
    privacyNotice: "包含对话正文、需求卡片及工具错误，分享前请检查个人信息和可能粘贴的凭据。不会自动附带已配置的 API 密钥、图片原件、项目源码快照或内部模型上下文。",
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status,
      error: session.error || "",
      roomId: session.roomId || null,
      provider: session.provider ? {
        name: session.provider.name,
        model: session.provider.model
      } : null,
      workflow: {
        phase: session.workflow?.phase || null,
        mode: session.workflow?.mode || null,
        answered: session.workflow?.answered === true,
        approvedPlanId: session.workflow?.approvedPlanId || null,
        questionHistory: session.workflow?.questionHistory || [],
        questions: (session.workflow?.questions || []).map((question) => ({
          topic: question.topic,
          selection: question.selection,
          title: question.title,
          options: question.options,
          recommended: question.recommended,
          example: question.example
        })),
        plan: session.workflow?.plan ? Object.fromEntries(
          ["id", "overview", "summary", "features", "usage", "data", "permissions", "steps", "acceptance", "limitations", "usesAi", "aiTestPurpose", "migrationMode"]
            .filter((key) => session.workflow.plan[key] !== undefined)
            .map((key) => [key, session.workflow.plan[key]])
        ) : null
      },
      contextCompaction: session.context?.compaction || null
    },
    messages: (session.messages || []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content || "",
      status: message.status || null,
      createdAt: message.createdAt || null,
      attachments: (message.attachments || []).map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        bytes: attachment.bytes
      }))
    })),
    steps: (session.steps || []).map((step) => ({
      id: step.id,
      toolName: step.toolName,
      label: step.label,
      summary: step.summary,
      status: step.status,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      progress: step.progress,
      error: step.error || "",
      details: step.details || null
    })),
    runs: (session.runs || []).map((run) => ({
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      elapsedMs: run.elapsedMs,
      status: run.status,
      provider: run.provider,
      model: run.model,
      limits: run.limits,
      requests: run.requests,
      toolErrors: run.toolErrors || 0,
      streamRetries: run.streamRetries || 0,
      tokens: run.tokens,
      limitReason: run.limitReason || ""
    }))
  };
}

module.exports = { buildRoomAgentExport };
