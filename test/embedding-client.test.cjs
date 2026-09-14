"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { requestEmbeddings } = require("../src/main/embedding-client.cjs");

test("embedding gateway uses saved connection, keeps input order, accepts intranet and masks credentials", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, key: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ index: 1, embedding: [0,1,0] }, { index: 0, embedding: [1,0,0] }], usage: { prompt_tokens: 9, total_tokens: 9 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const profile = { id: "saved", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const result = await requestEmbeddings(profile, "fake-unit-test-key", ["第一段", "第二段"], { model: "embedding-model" });
  assert.deepEqual(result.embeddings, [[1,0,0], [0,1,0]]);
  assert.equal(result.dimensions, 3);
  assert.equal(result.usage.totalTokens, 9);
  assert.equal(requests[0].url, "/v1/embeddings");
  assert.equal(requests[0].key, "Bearer fake-unit-test-key");
  assert.equal(requests[0].body.encoding_format, "float");
  assert.doesNotMatch(JSON.stringify(result), /fake-unit-test-key|127\.0\.0\.1/);
  await assert.rejects(requestEmbeddings(profile, "secret", ["test"], {}), /明确指定/);
  await assert.rejects(requestEmbeddings({ ...profile, protocol: "anthropic-messages" }, "secret", ["test"], { model: "embedding-model" }), /协议/);
  await assert.rejects(requestEmbeddings(profile, "secret", ["test"], { model: "embedding-model" }, async () => new Response("secret body", { status: 401 })), (e) => /HTTP 401/.test(e.message) && !/secret/.test(e.message));
});

test("embedding gateway rejects duplicate indexes, non-finite vectors and dimension mismatches", async () => {
  const profile = { id: "saved", protocol: "openai-completions", baseUrl: "https://example.invalid/v1" };
  const request = (data, options = {}) => requestEmbeddings(profile, "secret", ["one", "two"], { model: "embed", ...options }, async () => new Response(JSON.stringify({ data })));
  await assert.rejects(request([{ index: 0, embedding: [1,0] }, { index: 0, embedding: [1,0] }]), /索引/);
  await assert.rejects(request([{ index: 0, embedding: [1,0] }, { index: 1, embedding: [null,0] }]), /向量无效/);
  await assert.rejects(request([{ index: 0, embedding: [1,0] }, { index: 1, embedding: [1,0,0] }]), /维度/);
  await assert.rejects(request([{ index: 0, embedding: [1,0] }, { index: 1, embedding: [1,0] }], { dimensions: 3 }), /维度/);
});
