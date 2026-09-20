"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeQuestions, shortTaskTitle, accumulateUsage } = require("../src/main/room-agent-ux.cjs");

const question = { topic: "data", title: "大约有多少条账目，需要导入吗？", options: ["百条以内，手动录入", "已有 Excel，需要导入"], recommended: "百条以内，手动录入", example: "比如每天记录十笔收入和支出。" };
test("feature questions default to multiple selection and explicit single/text modes are retained", () => {
  const result = normalizeQuestions([{ ...question, topic: "features" }, { ...question, selection: "text" }]);
  assert.equal(result[0].selection, "multiple");
  assert.equal(result[1].selection, "text");
  assert.equal(normalizeQuestions([{ ...question, topic: "features", selection: "single" }, question])[0].selection, "single");
  assert.throws(() => normalizeQuestions([{ ...question, selection: "code" }, question]), /回答类型/);
});
test("clarification may contain one focused question", () => {
  assert.equal(normalizeQuestions([question], { minimum: 1 }).length, 1);
  assert.equal(normalizeQuestions([question]).length, 1);
});
test("structured questions preserve choices, examples and add missing audience coverage", () => {
  const questions = normalizeQuestions([question, { ...question, topic: "features" }], { ensureAudience: true });
  assert.equal(questions.length, 3);
  assert.equal(questions[0].topic, "audience");
  assert.ok(questions[0].options.includes("多人共同编辑同一份数据"));
  assert.equal(questions[1].example, question.example);
  assert.equal(normalizeQuestions([{ topic: "data", title: "需要保存翻译历史吗？", options: ["保存", "不保存"], recommended: "保存" }, { topic: "features", title: "需要手动选择目标语言吗？", options: ["需要", "不需要"], recommended: "需要" }])[0].example, "");
  assert.ok(questions[1].options.includes("你来推荐"));
  assert.equal(new Set(questions.map((q) => q.id)).size, 3);
  assert.equal(normalizeQuestions([question, { ...question, recommended: "不存在" }])[1].recommended, question.options[0]);
  assert.equal(normalizeQuestions([question, { ...question, recommended: "已有 Excel，需要导入（推荐）" }])[1].recommended, question.options[1]);
  assert.equal(normalizeQuestions([question, { ...question, recommended: undefined }])[1].recommended, question.options[0]);
  assert.throws(() => normalizeQuestions([question, { ...question, options: ["只有一项"] }]), /2–5/);
});
test("legacy question strings remain readable without losing their original text", () => {
  const result = normalizeQuestions(["谁来使用？推荐个人使用。", "大概有多少条数据？"], { ensureAudience: true });
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "谁来使用？推荐个人使用。");
});
test("automatic titles are bounded and keep the core first sentence", () => {
  assert.equal(shortTaskTitle("我想做一个小店记账的房间，简单好用就行。不要修改旧房间。"), "小店记账的房间，简单好用就行");
  assert.ok([...shortTaskTitle("测试".repeat(50))].length <= 18);
  assert.equal(shortTaskTitle(""), "新房间对话");
});
test("usage sums model calls, distinguishes unknown fields and never treats zero catalogue cost as a free bill", () => {
  const run = { requests: 0, reportedRequests: 0, missingUsage: 0, missingCost: 0, estimatedCostUsd: null, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
  accumulateUsage(run, { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 135, cost: { total: .02 } });
  accumulateUsage(run, { input: 60, output: 30, cost: { total: 0 } });
  accumulateUsage(run, undefined);
  assert.equal(run.tokens.totalTokens, 225);
  assert.equal(run.tokens.input, 160);
  assert.equal(run.requests, 3);
  assert.equal(run.reportedRequests, 2);
  assert.equal(run.missingUsage, 1);
  assert.equal(run.reportedFields.cacheRead, 1);
  assert.equal(run.missingCost, 2);
  assert.equal(run.estimatedCostUsd, .02);
});

test("usage accounting repairs incomplete restored run objects", () => {
  const run = {};
  accumulateUsage(run, undefined);
  accumulateUsage(run, { input: 7, output: 2 });
  assert.deepEqual(run.tokens, { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9 });
  assert.equal(run.requests, 2);
  assert.equal(run.missingUsage, 1);
});
