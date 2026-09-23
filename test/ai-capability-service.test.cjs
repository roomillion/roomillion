"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { AiCapabilityService } = require("../src/main/ai-capability-service.cjs");

const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => Buffer.from(value).toString("utf8").replace(/^encrypted:/, "")
};

test("specialized AI capabilities persist encrypted keys and serve embedding, rerank and Jev", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-ai-capabilities-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push({ url: req.url, authorization: req.headers.authorization, input });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/embeddings") return res.end(JSON.stringify({ model: input.model, data: input.input.map((_value, index) => ({ index, embedding: index ? [0, 1] : [1, 0] })) }));
    if (req.url === "/v1/rerank") return res.end(JSON.stringify({ model: input.model, results: [{ index: 1, relevance_score: 0.92 }, { index: 0, relevance_score: 0.31 }] }));
    if (req.url === "/v1/systemone") return res.end(JSON.stringify({ model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.88 } }, usage: { input_tokens: 8, output_tokens: 1 } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const service = await new AiCapabilityService(root, { secureStorage }).init();
  for (const [kind, model] of [["embedding", "embed-v1"], ["rerank", "rerank-v1"], ["intuition", "jev-latest"]]) {
    await service.saveProfile(kind, { baseUrl, model, apiKey: `${kind}-secret`, rememberKey: true });
  }
  const embedded = await service.embed(["甲", "乙"]);
  assert.deepEqual(embedded.embeddings, [[1, 0], [0, 1]]);
  const ranked = await service.rerank("查询", ["一", "二"], { topN: 2 });
  assert.deepEqual(ranked.results, [{ index: 1, relevanceScore: 0.92 }, { index: 0, relevanceScore: 0.31 }]);
  const intuition = await service.intuition("服务器停止", { urgent: { type: "noul", instructions: "是否紧急？" } });
  assert.deepEqual(intuition.answers.urgent, { type: "noul", noul: 0.88 });
  assert.equal(intuition.model, "jev-1.13.0");
  assert.equal(requests[0].authorization, "Bearer embedding-secret");
  assert.equal(requests[1].authorization, "Bearer rerank-secret");
  assert.equal(requests[2].authorization, "Bearer intuition-secret");
  assert.deepEqual(requests.map((item) => item.url), ["/v1/embeddings", "/v1/rerank", "/v1/systemone"]);
  const config = await fsp.readFile(path.join(root, "ai-capabilities.json"), "utf8");
  assert.doesNotMatch(config, /embedding-secret|rerank-secret|intuition-secret/);
  const catalog = service.getRoomCatalog();
  assert.deepEqual(Object.keys(catalog), ["embedding", "rerank", "intuition"]);
  assert.equal(catalog.intuition.model, "jev-latest");
  assert.doesNotMatch(JSON.stringify(catalog), /baseUrl|127\.0\.0\.1|secret/);
  const restored = await new AiCapabilityService(root, { secureStorage }).init();
  assert.equal(restored.getPublicProfile("rerank").hasStoredKey, true);
  assert.equal(restored.getPublicProfile("intuition").ready, true);
});

test("specialized AI capability profiles validate type, endpoint and optional embedding dimensions", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-ai-capability-validation-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new AiCapabilityService(root, { secureStorage }).init();
  await assert.rejects(service.saveProfile("unknown", {}), /类型无效/);
  await assert.rejects(service.saveProfile("embedding", { baseUrl: "file:///tmp/model", model: "e" }), /HTTP/);
  await assert.rejects(service.saveProfile("embedding", { baseUrl: "https://example.test/v1", model: "e", dimensions: 0 }), /维度/);
  await assert.rejects(service.saveProfile("rerank", { baseUrl: "https://example.test/v1", model: "r", dimensions: 3 }), /只有 Embedding/);
  await service.saveProfile("intuition", { apiKey: "session-only", rememberKey: false });
  assert.equal(service.getPublicProfile("intuition").model, "jev-latest");
});
