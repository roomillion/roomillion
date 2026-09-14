"use strict";
const crypto = require("node:crypto");

function supportsEmbeddingTransport(profile) {
  return ["openai-completions", "openai-responses"].includes(profile.protocol);
}
async function requestEmbeddings(profile, apiKey, texts, options = {}, fetcher = fetch) {
  if (!supportsEmbeddingTransport(profile)) throw new Error("该连接未接入 Embeddings 协议，请在 AI 能力中心添加 OpenAI 兼容连接");
  if (typeof options.model !== "string" || !options.model.trim()) throw new Error("请明确指定 Embedding 模型名称，不能默认使用聊天模型");
  if (!Array.isArray(texts) || !texts.length || texts.some((s) => typeof s !== "string" || !s.trim())) throw new Error("Embedding 输入必须是非空文本数组");
  if (options.dimensions !== undefined && (!Number.isInteger(options.dimensions) || options.dimensions < 1)) throw new Error("Embedding 维度必须为正整数");
  const url = new URL(profile.baseUrl.replace(/\/+$/, "") + "/embeddings");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Embedding 连接地址无效");
  let response;
  try {
    const timeoutMs = options.timeoutMs === undefined ? 120000 : Number(options.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Embedding 超时必须是正整数毫秒");
    response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model: options.model.trim(), input: texts, encoding_format: "float", ...(options.dimensions ? { dimensions: options.dimensions } : {}) }) });
  } catch { throw new Error("向量服务连接失败或超时，请检查工作台连接地址与网络"); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`向量服务返回 HTTP ${response.status}，请确认此连接支持 /embeddings、模型名称及凭据有效；聊天订阅不一定提供此服务`); }
  const chunks = [];
  try {
    for await (const chunk of response.body) chunks.push(chunk);
  } catch { throw new Error("向量服务响应中断或超时"); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("向量服务返回的 JSON 无效"); }
  if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error("向量服务返回数量不匹配");
  const embeddings = new Array(texts.length);
  for (const item of data.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || embeddings[item.index]) throw new Error("向量服务返回索引无效或重复");
    if (!Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every((n) => typeof n === "number" && Number.isFinite(n)) || !item.embedding.some((n) => n !== 0)) throw new Error("向量服务返回的向量无效");
    embeddings[item.index] = item.embedding;
  }
  const dimensions = embeddings[0].length;
  if (embeddings.some((v) => v.length !== dimensions) || options.dimensions && dimensions !== options.dimensions) throw new Error("向量服务返回维度不一致");
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const source = crypto.createHash("sha256").update(url.href).digest("hex").slice(0, 24);
  return { embeddings, dimensions, model: options.model.trim(), embedding: `${source}:${options.model.trim()}:${dimensions}`, profileId: profile.id, usage: { input: count(data.usage?.prompt_tokens), totalTokens: count(data.usage?.total_tokens) } };
}
module.exports = { requestEmbeddings, supportsEmbeddingTransport };
