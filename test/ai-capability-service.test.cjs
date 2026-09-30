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

test("multiple specialized models keep separate keys; rooms can select either while the first remains default", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-multiple-capabilities-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push({ url: req.url, model: input.model, key: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/embeddings") return res.end(JSON.stringify({ data: input.input.map((_item, index) => ({ index, embedding: [index + 1, 1] })) }));
    if (req.url === "/v1/rerank") return res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }));
    if (req.url === "/v1/systemone") return res.end(JSON.stringify({ answers: { check: { type: "noul", noul: 0.8 } } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const service = await new AiCapabilityService(root, { secureStorage }).init();
  for (const kind of ["embedding", "rerank", "intuition"]) {
    await service.saveProfile(kind, { baseUrl, model: `${kind}-first`, apiKey: `${kind}-key-1`, rememberKey: true });
    await service.saveProfile(kind, { create: true, baseUrl, model: `${kind}-second`, apiKey: `${kind}-key-2`, rememberKey: true });
    const catalog = service.getRoomCatalog()[kind];
    assert.equal(catalog.profiles.length, 2);
    assert.equal(catalog.defaultProfileId, catalog.profiles[0].id);
    assert.equal(catalog.model, `${kind}-first`);
    assert.doesNotMatch(JSON.stringify(catalog), /127\.0\.0\.1|key-/);
  }
  const originalIntuition = service.getRoomCatalog().intuition.profiles[0];
  await assert.rejects(service.saveProfile("intuition", {
    create: true, id: originalIntuition.id, baseUrl, model: "should-not-overwrite"
  }), /新增模型不能覆盖已有模型配置/);
  assert.equal(service.getRoomCatalog().intuition.profiles[0].model, originalIntuition.model);
  const second = (kind) => service.getRoomCatalog()[kind].profiles[1].id;
  assert.equal((await service.embed(["文本"])).model, "embedding-first");
  assert.equal((await service.embed(["文本"], { profileId: second("embedding") })).model, "embedding-second");
  const ranked = await service.rerank("查询", ["文档"], { profileId: second("rerank") });
  assert.equal(ranked.model, "rerank-second");
  assert.equal(ranked.profileId, second("rerank"));
  const questions = { check: { type: "noul" } };
  assert.equal((await service.intuition("状态", questions)).model, "intuition-first");
  const alternate = await service.intuition("状态", questions, { profileId: second("intuition") });
  assert.equal(alternate.model, "intuition-second");
  assert.equal(alternate.profileId, second("intuition"));
  assert.deepEqual(requests.map(({ model, key }) => [model, key]), [
    ["embedding-first", "Bearer embedding-key-1"], ["embedding-second", "Bearer embedding-key-2"],
    ["rerank-second", "Bearer rerank-key-2"], ["intuition-first", "Bearer intuition-key-1"], ["intuition-second", "Bearer intuition-key-2"]
  ]);
  await assert.rejects(service.intuition("状态", questions, { profileId: second("rerank") }), /ID 无效/);
  const firstIntuitionId = service.getRoomCatalog().intuition.defaultProfileId;
  const secondIntuitionId = second("intuition");
  await assert.rejects(service.setDefaultProfile("intuition", second("rerank")), /ID 无效/);
  await assert.rejects(service.setDefaultProfile("intuition", ""), /请选择默认模型/);
  await service.setDefaultProfile("embedding", second("embedding"));
  await service.setDefaultProfile("rerank", second("rerank"));
  await service.setDefaultProfile("intuition", secondIntuitionId);
  assert.equal(service.getRoomCatalog().intuition.defaultProfileId, secondIntuitionId);
  assert.deepEqual(service.getRoomCatalog().intuition.profiles.map((profile) => profile.isDefault), [false, true]);
  assert.equal(service.getPublicState().intuition.model, "intuition-second");
  assert.equal((await service.embed(["文本"])).model, "embedding-second");
  assert.equal((await service.rerank("查询", ["文档"])).model, "rerank-second");
  assert.equal((await service.intuition("状态", questions)).profileId, secondIntuitionId);
  assert.equal((await service.intuition("状态", questions, { profileId: firstIntuitionId })).profileId, firstIntuitionId);
  const restored = await new AiCapabilityService(root, { secureStorage }).init();
  assert.equal(restored.getPublicState().embedding.profiles.length, 2);
  assert.equal(restored.getRoomCatalog().embedding.defaultProfileId, second("embedding"));
  assert.equal(restored.getPublicState().intuition.model, "intuition-second");
  assert.equal(restored.getPublicState().intuition.hasStoredKey, true);
  await restored.deleteProfile("intuition", secondIntuitionId);
  assert.equal(restored.getRoomCatalog().intuition.defaultProfileId, firstIntuitionId);
  await assert.rejects(restored.intuition("状态", questions, { profileId: secondIntuitionId }), /不存在/);
  assert.doesNotMatch(await fsp.readFile(path.join(root, "ai-capabilities.json"), "utf8"), /key-1|key-2/);
});

test("format 0.1 specialized configuration and encrypted key migrate without changing its default ID", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-capability-migration-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "ai-capability-secrets"));
  await fsp.writeFile(path.join(root, "ai-capabilities.json"), JSON.stringify({ formatVersion: "0.1", profiles: {
    intuition: { label: "旧模型", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest" }
  } }));
  await fsp.writeFile(path.join(root, "ai-capability-secrets", "intuition.bin"), secureStorage.encryptString("old-secret"));
  const service = await new AiCapabilityService(root, { secureStorage }).init();
  assert.equal(service.getRoomCatalog().intuition.defaultProfileId, "capability-intuition");
  assert.equal(service.getPublicProfile("intuition").hasStoredKey, true);
  await service.saveProfile("intuition", { baseUrl: "https://api.typesafe.ai/v1", model: "jev-new" });
  assert.equal(service.getPublicState().intuition.profiles.length, 2);
  const restored = await new AiCapabilityService(root, { secureStorage }).init();
  assert.equal(restored.getPublicProfile("intuition", "capability-intuition").hasStoredKey, true);
});

test("format 0.2 model lists retain their first default until the user chooses another", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-capability-list-migration-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const firstId = "capability-intuition-11111111-1111-1111-1111-111111111111";
  const secondId = "capability-intuition-22222222-2222-2222-2222-222222222222";
  await fsp.writeFile(path.join(root, "ai-capabilities.json"), JSON.stringify({ formatVersion: "0.2", profiles: [
    { id: firstId, kind: "intuition", label: "旧一", baseUrl: "http://127.0.0.1:8000/v1", model: "jev-a" },
    { id: secondId, kind: "intuition", label: "旧二", baseUrl: "http://127.0.0.1:8000/v1", model: "jev-b" }
  ] }));
  const service = await new AiCapabilityService(root, { secureStorage }).init();
  assert.equal(service.getRoomCatalog().intuition.defaultProfileId, firstId);
  await service.setDefaultProfile("intuition", secondId);
  const stored = JSON.parse(await fsp.readFile(path.join(root, "ai-capabilities.json"), "utf8"));
  assert.equal(stored.formatVersion, "0.3");
  assert.equal(stored.defaults.intuition, secondId);
  assert.equal((await new AiCapabilityService(root, { secureStorage }).init()).getPublicProfile("intuition").id, secondId);
});
