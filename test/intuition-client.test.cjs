"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { requestIntuition, validateQuestions } = require("../src/main/intuition-client.cjs");

test("Jev intuition client sends System One typed questions and validates typed probabilities", async () => {
  const calls = [];
  const profile = { baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest" };
  const questions = {
    route: { type: "choice", instructions: "选择路线", criteria: { sales: "销售", support: "支持" } },
    urgency: { type: "score", instructions: "紧急程度", criteria: ["可等待", "今天处理"] },
    risky: { type: "noul", instructions: "是否有风险？" }
  };
  const output = await requestIntuition(profile, "jev-secret", { message: "马上处理" }, questions, {}, async (url, input) => {
    calls.push({ url: String(url), body: JSON.parse(input.body), authorization: input.headers.Authorization });
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        route: { type: "choice", choice: "support", confidence: 0.8, probabilities: { sales: 0.2, support: 0.8 } },
        urgency: { type: "score", score: 0.9, confidence: 0.7, legend: { 0: "可等待", 1: "今天处理" }, probabilities: { 0: 0.1, 1: 0.9 } },
        risky: { type: "noul", noul: 0.4 }
      },
      usage: { input_tokens: 20, output_tokens: 5 }
    }));
  });
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].authorization, "Bearer jev-secret");
  assert.equal(calls[0].body.questions.route.type, "choice");
  assert.equal(output.answers.route.choice, "support");
  assert.equal(output.answers.urgency.score, 0.9);
  assert.equal(output.usage.inputTokens, 20);
  await assert.rejects(requestIntuition(profile, "key", "state", { invalid: { type: "choice", criteria: {} } }), /缺少候选项/);
  await assert.rejects(requestIntuition(profile, "key", "state", { route: questions.route }, {}, async () => new Response(JSON.stringify({
    answers: { route: { type: "choice", choice: "support", confidence: 0.8, probabilities: { support: 0.8, other: 0.2 } } }
  }))), /概率选项不匹配/);
  assert.throws(() => validateQuestions({ bad: { type: "text" } }), /类型无效/);
});
