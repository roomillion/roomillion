"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { requestRerank } = require("../src/main/rerank-client.cjs");

test("rerank client normalizes common provider results and rejects malformed scores", async () => {
  const profile = { baseUrl: "https://rerank.example/v1", model: "ranker" };
  const calls = [];
  const result = await requestRerank(profile, "secret", "query", ["a", "b"], { topN: 1 }, async (url, input) => {
    calls.push({ url: String(url), input: JSON.parse(input.body), authorization: input.headers.Authorization });
    return new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }] }));
  });
  assert.deepEqual(result.results, [{ index: 1, relevanceScore: 0.9 }]);
  assert.equal(calls[0].url, "https://rerank.example/v1/rerank");
  assert.equal(calls[0].input.top_n, 1);
  assert.equal(calls[0].authorization, "Bearer secret");
  await assert.rejects(requestRerank(profile, "secret", "q", ["a"], {}, async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: "nan" }] }))), /分数/);
  await assert.rejects(requestRerank(profile, "secret", "", ["a"]), /查询/);
});
