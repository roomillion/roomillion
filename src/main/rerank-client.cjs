"use strict";

function endpoint(baseUrl, suffix) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  const url = new URL(normalized.endsWith(suffix) ? normalized : normalized + suffix);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Rerank 连接地址无效");
  }
  return url;
}

async function readJson(response, label) {
  const chunks = [];
  try { for await (const chunk of response.body) chunks.push(chunk); }
  catch { throw new Error(`${label}响应中断或超时`); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error(`${label}返回的 JSON 无效`); }
}

async function requestRerank(profile, apiKey, query, documents, options = {}, fetcher = fetch) {
  if (typeof query !== "string" || !query.trim()) throw new Error("Rerank 查询必须是非空文本");
  if (!Array.isArray(documents) || !documents.length || documents.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Rerank 文档必须是非空文本数组");
  }
  const model = String(options.model || profile.model || "").trim();
  if (!model) throw new Error("请配置 Rerank 模型名称");
  const topN = options.topN === undefined ? documents.length : Number(options.topN);
  if (!Number.isSafeInteger(topN) || topN < 1) throw new Error("Rerank topN 必须是正整数");
  const url = endpoint(profile.baseUrl, "/rerank");
  const timeoutMs = options.timeoutMs === undefined ? 120_000 : Number(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Rerank 超时必须是正整数毫秒");
  let response;
  try {
    response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, query, documents, top_n: Math.min(topN, documents.length), return_documents: false })
    });
  } catch { throw new Error("Rerank 服务连接失败或超时，请检查工作台连接地址与网络"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Rerank 服务返回 HTTP ${response.status}，请确认接口地址、模型名称及凭据有效`);
  }
  const data = await readJson(response, "Rerank 服务");
  if (!Array.isArray(data.results)) throw new Error("Rerank 服务返回结果格式无效");
  const seen = new Set();
  const results = data.results.map((item) => {
    const index = Number(item?.index);
    const relevanceScore = Number(item?.relevance_score ?? item?.score);
    if (!Number.isSafeInteger(index) || index < 0 || index >= documents.length || seen.has(index)) throw new Error("Rerank 服务返回文档索引无效或重复");
    if (!Number.isFinite(relevanceScore)) throw new Error("Rerank 服务返回相关性分数无效");
    seen.add(index);
    return { index, relevanceScore };
  });
  const count = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  return {
    results,
    model: String(data.model || model),
    usage: {
      searchUnits: count(data.meta?.billed_units?.search_units),
      totalTokens: count(data.usage?.total_tokens)
    }
  };
}

module.exports = { requestRerank };
