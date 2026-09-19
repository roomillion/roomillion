"use strict";

function shortTaskTitle(prompt) {
  const first = String(prompt || "新房间对话").split(/[。！？\n]/)[0]
    .replace(/^(?:请|帮我|我想|我要|想要|能否|可以|做一个|创建一个|制作一个)+/g, "")
    .replace(/^[，,\s]+/, "").trim();
  return [...(first || "新房间对话")].slice(0, 18).join("");
}

function normalizeQuestions(input, { ensureAudience = false, minimum = 2 } = {}) {
  const minimumQuestions = minimum === 1 ? 1 : 2;
  if (!Array.isArray(input) || input.length < minimumQuestions || input.length > 4) throw new Error(`请提供 ${minimumQuestions}–4 个清晰的问题`);
  const questions = input.map((entry, index) => {
    const legacy = typeof entry === "string";
    const title = legacy ? entry : entry?.title;
    if (typeof title !== "string" || title.trim().length < 5 || title.length > 700) throw new Error("问题文字需要 5–700 字");
    const selection = legacy ? "single" : entry.selection || (entry.topic === "features" ? "multiple" : "single");
    if (!["single", "multiple", "text"].includes(selection)) throw new Error("问题回答类型无效");
    const options = legacy ? ["你来推荐"] : entry.options;
    if (!Array.isArray(options) || options.length < (legacy ? 1 : 2) || options.length > 5 || options.some((s) => typeof s !== "string" || !s.trim() || s.length > 150)) throw new Error("每题需要 2–5 个简短选项");
    const choices = [...new Set(options.map((s) => s.trim()))];
    const requestedRecommendation = legacy ? "你来推荐" : String(entry.recommended || "").trim();
    const recommended = choices.includes(requestedRecommendation)
      ? requestedRecommendation
      : choices.find((choice) => requestedRecommendation && (requestedRecommendation.includes(choice) || choice.includes(requestedRecommendation))) || choices[0];
    if (!choices.includes("你来推荐")) choices.push("你来推荐");
    return { id: `q${index + 1}`, selection, topic: entry?.topic || "other", title: title.trim(), options: choices, recommended, example: legacy ? "可选择你来推荐，或填写自己的情况。" : String(entry.example || "").slice(0, 300) };
  });
  if (ensureAudience && !questions.some((q) => q.topic === "audience" || /谁.*用|使用者|几个人|多人|协作|个人使用/.test(q.title))) {
    questions.unshift({ id: "audience", topic: "audience", title: "谁会使用这个房间，需要多人共同处理同一份数据吗？", options: ["我自己在一台电脑使用", "多人各自独立使用", "多人共同编辑同一份数据", "你来推荐"], recommended: "我自己在一台电脑使用", example: "例如：店主自己记账，或店主和两名店员共同记账。" });
  }
  return questions;
}

function accumulateUsage(run, usage) {
  if (!run || typeof run !== "object") return;
  run.requests = Number.isFinite(run.requests) ? run.requests : 0;
  run.reportedRequests = Number.isFinite(run.reportedRequests) ? run.reportedRequests : 0;
  run.missingUsage = Number.isFinite(run.missingUsage) ? run.missingUsage : 0;
  run.missingCost = Number.isFinite(run.missingCost) ? run.missingCost : 0;
  run.tokens = run.tokens && typeof run.tokens === "object" ? run.tokens : {};
  run.requests += 1;
  const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const fields = ["input", "output", "cacheRead", "cacheWrite"];
  if (!usage || !number(usage.input) || !number(usage.output)) run.missingUsage += 1;
  run.reportedFields ||= {};
  for (const field of [...fields, "totalTokens"]) if (!number(run.tokens[field])) run.tokens[field] = 0;
  for (const field of fields) if (number(usage?.[field])) { run.tokens[field] += usage[field]; run.reportedFields[field] = (run.reportedFields[field] || 0) + 1; }
  const total = number(usage?.totalTokens) ? usage.totalTokens
    : number(usage?.input) && number(usage?.output) ? fields.reduce((sum, field) => sum + (number(usage[field]) ? usage[field] : 0), 0) : null;
  if (total !== null) { run.tokens.totalTokens += total; run.reportedRequests += 1; }
  // Pi costs are catalogue estimates, never the provider's actual bill.
  if (number(usage?.cost?.total) && usage.cost.total > 0) run.estimatedCostUsd = (run.estimatedCostUsd || 0) + usage.cost.total;
  else run.missingCost += 1;
}

module.exports = { shortTaskTitle, normalizeQuestions, accumulateUsage };
