"use strict";

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonValue(value, label) {
  if (!(typeof value === "string" || Array.isArray(value) || isPlainObject(value))) throw new Error(`${label}必须是文本、对象或数组`);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    JSON.parse(serialized);
  } catch { throw new Error(`${label}必须是可序列化的数据`); }
  return value;
}

function validateQuestions(input) {
  if (!isPlainObject(input) || !Object.keys(input).length) throw new Error("直觉问题必须是非空对象");
  const questions = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!name.trim() || name.length > 160) throw new Error("直觉问题名称无效");
    if (!isPlainObject(raw) || !["noul", "score", "choice"].includes(raw.type)) throw new Error(`直觉问题 ${name} 的类型无效`);
    const question = { type: raw.type };
    if (raw.instructions !== undefined) question.instructions = raw.instructions;
    if (raw.type === "noul") {
      if (raw.criteria !== undefined) question.criteria = raw.criteria;
    } else if (raw.type === "score") {
      if (!Array.isArray(raw.criteria) || !raw.criteria.length) throw new Error(`直觉评分问题 ${name} 缺少有序标准`);
      question.criteria = raw.criteria;
    } else {
      if (!isPlainObject(raw.criteria) || !Object.keys(raw.criteria).length) throw new Error(`直觉选择问题 ${name} 缺少候选项`);
      question.criteria = raw.criteria;
    }
    validateJsonValue({ question }, `直觉问题 ${name}`);
    questions[name] = question;
  }
  return questions;
}

function endpoint(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  const url = new URL(normalized.endsWith("/systemone") ? normalized : normalized + "/systemone");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("直觉模型连接地址无效");
  return url;
}

function probability(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${label}概率无效`);
  return number;
}

function validateAnswers(answers, questions) {
  if (!isPlainObject(answers)) throw new Error("直觉模型返回答案格式无效");
  const result = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!isPlainObject(answer) || answer.type !== question.type) throw new Error(`直觉模型返回的 ${name} 答案类型不匹配`);
    if (answer.type === "noul") result[name] = { type: "noul", noul: probability(answer.noul, `${name} `) };
    else if (answer.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`直觉模型返回的 ${name} 选择无效`);
      if (!isPlainObject(answer.probabilities)) throw new Error(`直觉模型返回的 ${name} 概率分布无效`);
      const probabilityKeys = Object.keys(answer.probabilities);
      if (probabilityKeys.length !== Object.keys(question.criteria).length || probabilityKeys.some((key) => !Object.hasOwn(question.criteria, key))) {
        throw new Error(`直觉模型返回的 ${name} 概率选项不匹配`);
      }
      result[name] = {
        type: "choice",
        choice: answer.choice,
        confidence: probability(answer.confidence, `${name} 置信度`),
        probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, value]) => [key, probability(value, `${name}.${key} `)]))
      };
    } else {
      if (!Number.isFinite(Number(answer.score)) || !isPlainObject(answer.probabilities) || !isPlainObject(answer.legend)) throw new Error(`直觉模型返回的 ${name} 评分无效`);
      result[name] = {
        type: "score",
        score: Number(answer.score),
        confidence: probability(answer.confidence, `${name} 置信度`),
        legend: structuredClone(answer.legend),
        probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, value]) => [key, probability(value, `${name}.${key} `)]))
      };
    }
  }
  return result;
}

async function requestIntuition(profile, apiKey, state, rawQuestions, options = {}, fetcher = fetch) {
  validateJsonValue(state, "直觉模型 state");
  const questions = validateQuestions(rawQuestions);
  const model = String(options.model || profile.model || "jev-latest").trim();
  if (!model) throw new Error("请配置直觉模型名称");
  const timeoutMs = options.timeoutMs === undefined ? 120_000 : Number(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("直觉模型超时必须是正整数毫秒");
  let response;
  try {
    response = await fetcher(endpoint(profile.baseUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ state, model, questions })
    });
  } catch { throw new Error("直觉模型连接失败或超时，请检查 TypeSafe API 地址与网络"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`直觉模型返回 HTTP ${response.status}，请确认 Jev 模型名称及 TypeSafe API Key 有效`);
  }
  const chunks = [];
  try { for await (const chunk of response.body) chunks.push(chunk); }
  catch { throw new Error("直觉模型响应中断或超时"); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("直觉模型返回的 JSON 无效"); }
  const count = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  return {
    answers: validateAnswers(data.answers, questions),
    model: String(data.model || model),
    usage: { inputTokens: count(data.usage?.input_tokens), outputTokens: count(data.usage?.output_tokens) }
  };
}

module.exports = { requestIntuition, validateQuestions };
