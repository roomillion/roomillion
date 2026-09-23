"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { AiService, getProviderCompatibility, validateOrganizationConfig } = require("../src/main/ai-service.cjs");

test("connection verification is per-model, timestamped, and cleared on credential changes", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-provider-health-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new AiService(root).init();
  const profile = await service.saveProfile({ name: "Test", baseUrl: "http://127.0.0.1:8000/v1", model: "demo", apiKey: "not-a-real-key" });
  assert.equal(service.getPublicProfile(profile.id).connectionTest, null);
  service.complete = async (request) => {
    assert.equal(request.maxTokens, 256);
    return { text: "OK", model: "demo" };
  };
  await service.testConnection(profile.id);
  assert.equal(service.getPublicProfile(profile.id).connectionTest.ok, true);
  assert.ok(service.getPublicProfile(profile.id).connectionTest.checkedAt);
  service.complete = async () => { throw new Error("offline"); };
  await assert.rejects(service.testConnection(profile.id), /offline/);
  assert.equal(service.getPublicProfile(profile.id).connectionTest.ok, false);
  await service.clearSessionKey(profile.id);
  assert.equal(service.getPublicProfile(profile.id).connectionTest, null);
});

test("OpenCode Go sends workbench identity and stable conversation headers through all native Pi protocols", async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers });
      // Stop at the real HTTP boundary: no model generation is needed to inspect routing headers.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "diagnostic boundary" } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const service = new AiService(os.tmpdir());
  const catalog = (await service.getProviderCatalog()).find(p => p.id === "opencode-go");
  const nativeRuntime = service.createRuntime.bind(service);
  service.createRuntime = async id => {
    const runtime = await nativeRuntime(id);
    return { ...runtime, model: { ...runtime.model, baseUrl: `http://127.0.0.1:${server.address().port}${runtime.model.api === "anthropic-messages" ? "" : "/v1"}` } };
  };
  for (const [protocol, endpoint] of [["anthropic-messages", "/v1/messages"], ["openai-completions", "/v1/chat/completions"], ["openai-responses", "/v1/responses"]]) {
    await t.test(protocol, async () => {
      const model = catalog.models.find(m => m.api === protocol);
      assert.ok(model, `No ${protocol} model found`);
      const profile = await service.resolveProfileInput({ id: protocol, providerId: catalog.id, model: model.id });
      service.profiles.set(profile.id, profile);
      service.sessionApiKeys.set(profile.id, "test-key");
      const start = requests.length;
      await assert.rejects(service.complete({ prompt: "test", profileId: profile.id, sessionId: "conversation-a" }), /diagnostic boundary/);
      const runtime = await service.createAgentRuntime({ profileId: profile.id });
      const context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
      for (const sessionId of ["conversation-a", "conversation-b", undefined, undefined]) {
        const result = await runtime.streamFn(runtime.model, context, { sessionId, headers: { "x-test-header": "preserved" } }).result();
        assert.equal(result.stopReason, "error");
      }
      const sent = requests.slice(start);
      assert.equal(sent.length, 5);
      for (const request of sent) {
        assert.equal(new URL(request.url, "http://localhost").pathname, endpoint);
        assert.equal(request.headers["user-agent"], `roomillion/${require("../package.json").version}`);
        assert.ok(request.headers["x-opencode-session"]);
      }
      assert.deepEqual(sent.slice(0, 3).map(r => r.headers["x-opencode-session"]), ["conversation-a", "conversation-a", "conversation-b"]);
      assert.equal(sent[3].headers["x-opencode-session"], sent[4].headers["x-opencode-session"]);
      assert.notEqual(sent[3].headers["x-opencode-session"], "conversation-b");
      assert.equal(sent[1].headers["x-test-header"], "preserved");
    });
  }
});

async function startFakeOpenAiServer() {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      assert.equal(payload.model, "test-model");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "test-model" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("cancelling AI completion closes the live provider stream without retrying", async t => {
  for (const streaming of [true, false]) await t.test(streaming ? "onChunk" : "ordinary completion", async t => {
    let seen = 0;
    let started, closed;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const closedPromise = new Promise(resolve => { closed = resolve; });
    const server = http.createServer((req, res) => {
      seen += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`);
        res.on("close", closed);
        started();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "room-ai-abort-"));
    t.after(async () => { server.closeAllConnections(); server.close(); await fsp.rm(root, { recursive: true, force: true }); });
    const service = await new AiService(root).init();
    await service.saveProfile({ name: "Abort test", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "test-model", apiKey: "test-key" });
    const controller = new AbortController();
    const pending = service.complete({ prompt: "synthetic", signal: controller.signal, ...(streaming ? { onTextDelta: () => {} } : {}) });
    const rejected = assert.rejects(pending, /cancelled by test/);
    await startedPromise;
    controller.abort(new Error("cancelled by test"));
    await rejected;
    await closedPromise;
    assert.equal(seen, 1);
    await assert.rejects(service.complete({ prompt: "synthetic", signal: controller.signal }), /cancelled by test/);
    assert.equal(seen, 1);
  });
});

test("Pi AI adapter calls an OpenAI-compatible endpoint", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-test-"));
  const server = await startFakeOpenAiServer();
  t.after(async () => {
    server.close();
    await once(server, "close");
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const address = server.address();
  const service = await new AiService(tempRoot).init();
  await service.saveProfile({
    name: "Fake API",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
    apiKey: "test-key"
  });
  const result = await service.testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.reply, "OK");
  assert.equal(result.model, "test-model");
});

test("Agent runtime forwards configurable provider retries and defaults to two", async () => {
  const service = new AiService(os.tmpdir());
  const profile = { id: "retry-profile", providerId: "custom-openai-compatible", name: "Retry", protocol: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1", model: "retry-model" };
  service.profiles.set(profile.id, profile);
  service.sessionApiKeys.set(profile.id, "test-key");
  const seen = [];
  service.createRuntime = async () => ({
    pi: {},
    model: { id: profile.model, maxTokens: 8192 },
    models: { streamSimple: (_model, _context, options) => { seen.push(options.maxRetries); return {}; } }
  });
  const defaultRuntime = await service.createAgentRuntime({ profileId: profile.id });
  defaultRuntime.streamFn(defaultRuntime.model, { messages: [] });
  const tunedRuntime = await service.createAgentRuntime({ profileId: profile.id, maxRetries: 4 });
  tunedRuntime.streamFn(tunedRuntime.model, { messages: [] });
  assert.deepEqual(seen, [2, 4]);
  await assert.rejects(() => service.createAgentRuntime({ profileId: profile.id, maxRetries: 6 }), /0–5/);
});
test("AI completion accepts room token requests above 4000 and follows the selected model limit", async () => {
  const service = new AiService(os.tmpdir());
  const profile = {
    id: "token-limit-profile",
    providerId: "custom-openai-compatible",
    name: "Token limit test",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "token-limit-model"
  };
  service.profiles.set(profile.id, profile);
  service.sessionApiKeys.set(profile.id, "test-key");
  const sentMaxTokens = [];
  service.createRuntime = async () => ({
    pi: { contentText: () => "OK" },
    model: { id: profile.model, input: ["text"], maxTokens: 8192 },
    models: {
      completeSimple: async (_model, _context, options) => {
        sentMaxTokens.push(options.maxTokens);
        return { stopReason: "stop", content: [] };
      }
    }
  });

  await service.complete({ prompt: "允许超过旧上限", maxTokens: 6000, profileId: profile.id });
  await service.complete({ prompt: "超过模型自身上限", maxTokens: 20000, profileId: profile.id });

  assert.deepEqual(sentMaxTokens, [6000, 8192]);
  await assert.rejects(
    service.complete({ prompt: "无效参数", maxTokens: 0, profileId: profile.id }),
    /必须是正整数/
  );
});

test("AI completion forwards real text deltas while preserving its final result", async () => {
  const service = new AiService(os.tmpdir());
  const profile = { id: "stream-profile", providerId: "custom-openai-compatible", name: "Stream", protocol: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1", model: "stream-model" };
  service.profiles.set(profile.id, profile);
  service.sessionApiKeys.set(profile.id, "test-key");
  const deltas = [];
  service.createRuntime = async () => ({
    pi: { contentText: content => content[0].text },
    model: { id: profile.model, input: ["text"], maxTokens: 8192 },
    models: {
      completeSimple: () => { throw new Error("expected streaming transport"); },
      streamSimple: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", delta: "Hello" };
          yield { type: "text_delta", delta: " world" };
        },
        result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Hello world" }], usage: {} })
      })
    }
  });
  const result = await service.complete({ prompt: "翻译", profileId: profile.id, onTextDelta: delta => deltas.push(delta) });
  assert.deepEqual(deltas, ["Hello", " world"]);
  assert.equal(result.text, "Hello world");
});
test("MiMo compatibility disables thinking and requests JSON objects for structured generation", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-mimo-test-"));
  let capturedPayload = null;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      capturedPayload = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const base = { id: "chatcmpl-mimo-test", object: "chat.completion.chunk", created: 1, model: "mimo-v2.5" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const service = await new AiService(tempRoot).init();
  await service.saveProfile({
    name: "MiMo",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "mimo-v2.5",
    apiKey: "test-key"
  });
  const result = await service.complete({
    systemPrompt: "Return JSON.",
    prompt: "Return an object.",
    structuredOutput: true,
    temperature: 0.1
  });
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(capturedPayload.thinking, { type: "disabled" });
  assert.deepEqual(capturedPayload.response_format, { type: "json_object" });
  assert.equal(capturedPayload.temperature, 0.1);
});

test("AiService forwards validated image blocks through the native Pi multimodal message format", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-vision-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const service = await new AiService(tempRoot).init();
  const profile = await service.saveProfile({
    name: "Vision Test",
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "vision-test-model",
    apiKey: "test-key"
  });
  let capturedContext = null;
  let runtimeInput = ["text", "image"];
  service.createRuntime = async () => ({
    pi: { contentText: () => "{\"seen\":true}" },
    model: { id: "vision-test-model", input: runtimeInput },
    models: {
      completeSimple: async (_model, context) => {
        capturedContext = context;
        return { content: [{ type: "text", text: "{\"seen\":true}" }], usage: { input: 8, output: 3, totalTokens: 11 }, stopReason: "stop" };
      }
    }
  });
  const result = await service.complete({
    systemPrompt: "Inspect the image.",
    prompt: "Return JSON.",
    images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
    structuredOutput: true,
    profileId: profile.id
  });
  assert.equal(result.text, '{"seen":true}');
  assert.deepEqual(capturedContext.messages[0].content, [
    { type: "text", text: "Return JSON." },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
  ]);

  runtimeInput = ["text"];
  await assert.rejects(() => service.complete({
    systemPrompt: "Inspect.", prompt: "Look.", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], profileId: profile.id
  }), /不支持图片输入/);
});

test("provider compatibility detects MiMo without changing generic endpoints", () => {
  assert.deepEqual(getProviderCompatibility({
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.5"
  }), {
    family: "mimo",
    disableThinking: true,
    supportsJsonObject: true
  });
  assert.equal(getProviderCompatibility({
    baseUrl: "https://ai.internal.example/v1",
    model: "qwen-local"
  }).disableThinking, false);
});

test("Pi provider catalog supplies MiMo Token Plan settings and selectable models", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-catalog-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const service = await new AiService(tempRoot).init();
  const catalog = await service.getProviderCatalog();
  const mimo = catalog.find((provider) => provider.id === "xiaomi-token-plan-cn");
  assert.equal(mimo.source, "pi-builtin");
  assert.equal(mimo.baseUrl, "https://token-plan-cn.xiaomimimo.com/v1");
  assert.equal(mimo.defaultModel, "mimo-v2.5");
  assert.ok(["mimo-v2.5", "mimo-v2.5-pro"].every((id) => mimo.models.some((model) => model.id === id)));

  const saved = await service.saveProfile({
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-v2.5",
    apiKey: "test-token-plan-key"
  });
  assert.equal(saved.name, "MiMo Token Plan（中国）");
  assert.equal(saved.protocol, "openai-completions");
  assert.equal(saved.baseUrl, mimo.baseUrl);
  const runtime = await service.createRuntime();
  assert.equal(runtime.model.provider, "xiaomi-token-plan-cn");
  assert.equal(runtime.model.contextWindow, 1048576);
  const capabilities = await service.getActiveModelCapabilities();
  assert.equal(capabilities.model, "mimo-v2.5");
  assert.equal(capabilities.supportsImages, true);
  assert.deepEqual(capabilities.input, ["text", "image"]);
});

test("workbench mirrors the complete Pi provider catalog and keeps Kimi Code separate from Moonshot Platform", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-native-catalog-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const service = await new AiService(tempRoot).init();
  const catalog = await service.getProviderCatalog();
  const nativeProviders = catalog.filter((provider) => provider.source === "pi-builtin");
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const expectedProviderIds = builtinProviders().map((provider) => provider.id).sort();
  assert.equal(nativeProviders.length, expectedProviderIds.length);
  assert.equal(new Set(nativeProviders.map((provider) => provider.id)).size, expectedProviderIds.length);
  assert.deepEqual(nativeProviders.map((provider) => provider.id).sort(), expectedProviderIds);
  assert.equal(catalog.filter((provider) => provider.id === "custom-openai-compatible").length, 1);

  const kimiCode = catalog.find((provider) => provider.id === "kimi-coding");
  assert.equal(kimiCode.displayName, "Kimi Code / Token Plan");
  assert.equal(kimiCode.baseUrl, "https://api.kimi.com/coding");
  assert.equal(kimiCode.defaultModel, "kimi-for-coding");
  assert.equal(kimiCode.configurable, true);
  assert.equal(kimiCode.supportsApiKey, true);
  assert.equal(kimiCode.supportsOAuth, true);
  assert.deepEqual(kimiCode.models.map((model) => model.id), [
    "k3",
    "k3-256k",
    "kimi-for-coding",
    "kimi-for-coding-highspeed"
  ]);
  assert.ok(kimiCode.models.every((model) =>
    model.api === "anthropic-messages" &&
    model.baseUrl === "https://api.kimi.com/coding" &&
    model.input.includes("image")
  ));

  const moonshot = catalog.find((provider) => provider.id === "moonshotai-cn");
  assert.equal(moonshot.displayName, "Kimi 开放平台（中国）");
  assert.equal(moonshot.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(moonshot.models.find((model) => model.id === "kimi-k3").api, "openai-completions");

  const saved = await service.saveProfile({
    providerId: "kimi-coding",
    model: "kimi-for-coding",
    apiKey: "test-kimi-code-key"
  });
  assert.equal(saved.protocol, "anthropic-messages");
  assert.equal(saved.baseUrl, "https://api.kimi.com/coding");
  const runtime = await service.createRuntime(saved.id);
  assert.equal(runtime.model.provider, "kimi-coding");
  assert.equal(runtime.model.id, "kimi-for-coding");
});

test("Pi providers with model-specific endpoints can reuse one credential across protocols", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-model-endpoint-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const service = await new AiService(tempRoot).init();
  const catalog = await service.getProviderCatalog();
  const provider = catalog.find((entry) => entry.id === "opencode");
  const sourceModel = provider.models[0];
  const otherModel = provider.models.find((model) => model.baseUrl !== sourceModel.baseUrl);
  assert.ok(sourceModel.baseUrl);
  assert.ok(otherModel?.baseUrl);

  const source = await service.saveProfile({
    providerId: provider.id,
    model: sourceModel.id,
    apiKey: "shared-opencode-key",
    activate: false
  });
  const other = await service.saveProfile({
    providerId: provider.id,
    model: otherModel.id,
    credentialSourceProfileId: source.id,
    activate: false
  });
  assert.equal(source.baseUrl, sourceModel.baseUrl);
  assert.equal(other.baseUrl, otherModel.baseUrl);
  assert.equal(service.sessionApiKeys.get(other.id), "shared-opencode-key");
});

test("Pi providers requiring OAuth or advanced Azure parameters stay visible with actionable limitations", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-provider-limit-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const service = await new AiService(tempRoot).init();
  const catalog = await service.getProviderCatalog();
  for (const providerId of ["openai-codex", "radius", "azure-openai-responses"]) {
    const provider = catalog.find((entry) => entry.id === providerId);
    assert.ok(provider);
    assert.equal(provider.configurable, false);
    assert.ok(provider.limitation);
    await assert.rejects(() => service.saveProfile({
      providerId,
      model: provider.models[0]?.id || "unavailable",
      apiKey: "not-used"
    }), /OAuth|模型|Azure|尚不能配置/);
  }
});

test("legacy MiMo profile is matched to the Pi built-in provider", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-migrate-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  await fsp.writeFile(path.join(tempRoot, "provider.json"), JSON.stringify({
    id: "default",
    name: "Xiaomi MiMo Token Plan",
    protocol: "openai-completions",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.5"
  }));
  const service = await new AiService(tempRoot).init();
  assert.equal(service.getPublicProfile().providerId, "xiaomi-token-plan-cn");
});

test("API key is encrypted by injected system storage and never written to provider config", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-secret-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`, "utf8"),
    decryptString: (buffer) => Buffer.from(buffer.toString("utf8").slice("encrypted:".length), "base64").toString("utf8")
  };
  const service = await new AiService(tempRoot, { secureStorage }).init();
  const saved = await service.saveProfile({
    name: "Secure API",
    baseUrl: "https://ai.example.test/v1",
    model: "secure-model",
    apiKey: "SECRET_API_KEY_VALUE",
    rememberKey: true
  });
  assert.equal(saved.hasStoredKey, true);
  assert.equal(saved.hasSessionKey, true);
  assert.doesNotMatch(await fsp.readFile(path.join(tempRoot, "provider.json"), "utf8"), /SECRET_API_KEY_VALUE/);
  const secretPath = service.secretPathFor(saved.id);
  assert.doesNotMatch(await fsp.readFile(secretPath, "utf8"), /SECRET_API_KEY_VALUE/);

  const reloaded = await new AiService(tempRoot, { secureStorage }).init();
  assert.equal(reloaded.getPublicProfile().hasStoredKey, true);
  assert.equal(reloaded.sessionApiKey, "SECRET_API_KEY_VALUE");
  await reloaded.clearSessionKey();
  assert.equal(reloaded.getPublicProfile().hasStoredKey, false);
  await assert.rejects(() => fsp.access(secretPath));
});

test("organization provider config imports non-secret settings only", () => {
  assert.deepEqual(validateOrganizationConfig({
    formatVersion: "0.1",
    provider: { name: "内网模型", baseUrl: "http://ai.internal.test/v1", model: "qwen" }
  }), {
    id: "default",
    label: "内网模型 · qwen",
    providerId: "custom-openai-compatible",
    name: "内网模型",
    protocol: "openai-completions",
    baseUrl: "http://ai.internal.test/v1",
    model: "qwen"
  });
  assert.throws(() => validateOrganizationConfig({
    formatVersion: "0.1",
    provider: { name: "错误配置", baseUrl: "https://ai.example/v1", model: "qwen", apiKey: "secret" }
  }), /不得包含密钥/);
});

test("multiple model profiles keep separate credentials and expose a sanitized room catalog", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-multi-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`, "utf8"),
    decryptString: (buffer) => Buffer.from(buffer.toString("utf8").slice("encrypted:".length), "base64").toString("utf8")
  };
  const service = await new AiService(tempRoot, { secureStorage }).init();
  const daily = await service.saveProfile({
    label: "日常 MiMo",
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-v2.5",
    apiKey: "daily-key",
    rememberKey: true
  });
  const pro = await service.saveProfile({
    label: "MiMo Pro",
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-v2.5-pro",
    credentialSourceProfileId: daily.id,
    rememberKey: true,
    activate: false
  });
  const local = await service.saveProfile({
    label: "内网 Qwen",
    name: "内网服务",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "qwen-local",
    apiKey: "local-key",
    activate: false
  });

  assert.equal(service.getPublicProfile().id, daily.id);
  assert.equal(service.listPublicProfiles().length, 3);
  assert.equal(service.sessionApiKeys.get(daily.id), "daily-key");
  assert.equal(service.sessionApiKeys.get(pro.id), "daily-key");
  assert.equal(pro.hasStoredKey, true);
  service.sessionApiKeys.delete(daily.id);
  assert.equal(service.getPublicProfile(daily.id).hasStoredKey, true);
  assert.equal(service.getPublicProfile(daily.id).ready, false);
  assert.equal((await service.listRoomModels("cn.zhibian.test.room")).find(entry => entry.id === daily.id).ready, false);
  assert.equal(service.getPublicProfile(pro.id).ready, true);
  service.sessionApiKeys.set(daily.id, "daily-key");
  assert.equal(service.sessionApiKeys.get(local.id), "local-key");
  await assert.rejects(
    service.saveProfile({
      label: "错误复用",
      providerId: "xiaomi",
      model: "mimo-v2.5",
      credentialSourceProfileId: daily.id,
      activate: false
    }),
    /只能复用同一 AI 提供商/
  );

  await service.selectRoomModel("cn.zhibian.test.room", local.id);
  await service.selectRoomModelSlot("cn.zhibian.test.room", "vision", daily.id);
  await service.selectRoomModelSlot("cn.zhibian.test.room", "text-review", pro.id);
  assert.equal(service.resolveRoomModelProfile("cn.zhibian.test.room", { slot: "vision" }), daily.id);
  const roomModels = await service.listRoomModels("cn.zhibian.test.room");
  assert.equal(roomModels.find((entry) => entry.id === local.id).isSelected, true);
  assert.equal(roomModels.find((entry) => entry.id === daily.id).isDefault, true);
  assert.equal(roomModels.find((entry) => entry.id === daily.id).supportsImages, true);
  assert.equal(roomModels.some((entry) => "apiKey" in entry || "baseUrl" in entry), false);

  const switched = await service.setActiveProfile(local.id);
  assert.equal(switched.activeProfile.id, local.id);
  assert.equal(switched.profiles.find((entry) => entry.id === daily.id).isActive, false);

  const reloaded = await new AiService(tempRoot, { secureStorage }).init();
  assert.equal(reloaded.getPublicProfile().id, local.id);
  assert.equal(reloaded.sessionApiKeys.get(daily.id), "daily-key");
  assert.equal(reloaded.sessionApiKeys.get(pro.id), "daily-key");
  assert.equal(reloaded.sessionApiKeys.has(local.id), false);
  assert.equal(reloaded.getRoomModelSelection("cn.zhibian.test.room").profileId, local.id);
  assert.deepEqual(reloaded.getRoomModelSlots("cn.zhibian.test.room"), { vision: daily.id, "text-review": pro.id });

  await reloaded.deleteProfile(daily.id);
  assert.equal(reloaded.sessionApiKeys.get(pro.id), "daily-key");
  await reloaded.deleteProfile(local.id);
  assert.equal(reloaded.getRoomModelSelection("cn.zhibian.test.room").profileId, pro.id);
  assert.equal(reloaded.getRoomModelSelection("cn.zhibian.test.room").source, "default");
});

test("legacy single profile and encrypted key migrate into the multi-profile registry", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-ai-legacy-registry-test-"));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`),
    decryptString: (buffer) => buffer.toString().slice("protected:".length)
  };
  await fsp.writeFile(path.join(tempRoot, "provider.json"), JSON.stringify({
    id: "default",
    name: "Legacy local",
    baseUrl: "http://127.0.0.1:9000/v1",
    model: "legacy-model"
  }));
  await fsp.writeFile(path.join(tempRoot, "provider-secret.bin"), secureStorage.encryptString("legacy-key"));
  const service = await new AiService(tempRoot, { secureStorage }).init();
  assert.equal(service.listPublicProfiles().length, 1);
  assert.equal(service.sessionApiKey, "legacy-key");
  const registry = JSON.parse(await fsp.readFile(path.join(tempRoot, "provider.json"), "utf8"));
  assert.equal(registry.formatVersion, "0.2");
  assert.equal(registry.activeProfileId, "default");
  assert.equal(registry.profiles.length, 1);
  assert.doesNotMatch(JSON.stringify(registry), /legacy-key/);
  await assert.rejects(() => fsp.access(path.join(tempRoot, "provider-secret.bin")));
  await fsp.access(service.secretPathFor("default"));
});

async function withCatalogBaseUrlOverride(service, providerId, baseUrl) {
  const original = service.getProviderCatalog.bind(service);
  service.getProviderCatalog = async () => {
    const catalog = await original();
    return catalog.map((entry) => entry.id === providerId ? { ...entry, baseUrl } : entry);
  };
}

test("provider catalog marks which providers support automatic model fetching", async () => {
  const service = new AiService(os.tmpdir());
  const catalog = await service.getProviderCatalog();
  assert.equal(catalog.find(p => p.id === "xiaomi-token-plan-cn").supportsModelFetch, true);
  assert.equal(catalog.find(p => p.id === "deepseek").supportsModelFetch, true);
  assert.equal(catalog.find(p => p.id === "openai").supportsModelFetch, false);
  assert.equal(catalog.find(p => p.id === "openai-codex").supportsModelFetch, false);
  assert.equal(catalog.find(p => p.id === "custom-openai-compatible").supportsModelFetch, false);
});

test("fetchProviderModels pulls sanitized model IDs from the OpenAI-compatible /models endpoint", async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [
        { id: "mimo-v2.5" },
        { id: "mimo-v3" },
        { id: "mimo-v3" },
        { id: "  mimo-v3.5-flash  " },
        { id: "" },
        { id: "bad id with spaces!" },
        { object: "model" },
        { id: "x".repeat(161) }
      ] }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const service = await new AiService(await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-fetch-models-"))).init();
  await withCatalogBaseUrlOverride(service, "xiaomi-token-plan-cn", `http://127.0.0.1:${server.address().port}/v1`);
  const result = await service.fetchProviderModels({ providerId: "xiaomi-token-plan-cn", apiKey: "transient-key" });
  assert.deepEqual(result.models, [{ id: "mimo-v2.5" }, { id: "mimo-v3" }, { id: "mimo-v3.5-flash" }]);
  assert.equal(result.providerId, "xiaomi-token-plan-cn");
  assert.ok(result.checkedAt);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, "Bearer transient-key");
});

test("fetchProviderModels reuses an existing session key when no transient key is given", async (t) => {
  let authorization = null;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "mimo-v3" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const service = await new AiService(await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-fetch-reuse-"))).init();
  const saved = await service.saveProfile({ providerId: "xiaomi-token-plan-cn", model: "mimo-v2.5", apiKey: "stored-session-key" });
  await withCatalogBaseUrlOverride(service, "xiaomi-token-plan-cn", `http://127.0.0.1:${server.address().port}/v1`);
  const result = await service.fetchProviderModels({ providerId: "xiaomi-token-plan-cn" });
  assert.deepEqual(result.models, [{ id: "mimo-v3" }]);
  assert.equal(authorization, "Bearer stored-session-key");
  assert.equal(service.getPublicProfile(saved.id).modelSource, undefined);
});

test("fetchProviderModels reports clear failures for keys, statuses, timeouts, and unsupported providers", async (t) => {
  const service = await new AiService(await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-fetch-fail-"))).init();
  await assert.rejects(
    service.fetchProviderModels({ providerId: "xiaomi-token-plan-cn" }),
    /请先填写该提供商的 API Key/
  );
  await assert.rejects(
    service.fetchProviderModels({ providerId: "custom-openai-compatible" }),
    /不支持的 Pi Provider/
  );
  await assert.rejects(
    service.fetchProviderModels({ providerId: "openai" }),
    /该提供商暂不支持自动获取/
  );
  await assert.rejects(
    service.fetchProviderModels({ providerId: "openai-codex" }),
    /OAuth/
  );

  const unauthorized = http.createServer((request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  unauthorized.listen(0, "127.0.0.1");
  await once(unauthorized, "listening");
  t.after(() => unauthorized.close());
  await withCatalogBaseUrlOverride(service, "xiaomi-token-plan-cn", `http://127.0.0.1:${unauthorized.address().port}/v1`);
  await assert.rejects(
    service.fetchProviderModels({ providerId: "xiaomi-token-plan-cn", apiKey: "wrong" }),
    /HTTP 401，请检查 API Key/
  );

  const hanging = http.createServer(() => {});
  hanging.listen(0, "127.0.0.1");
  await once(hanging, "listening");
  t.after(() => hanging.close());
  await withCatalogBaseUrlOverride(service, "xiaomi-token-plan-cn", `http://127.0.0.1:${hanging.address().port}/v1`);
  await assert.rejects(
    service.fetchProviderModels({ providerId: "xiaomi-token-plan-cn", apiKey: "k", timeoutMs: 150 }),
    /获取模型列表超时/
  );
});

test("catalog providers accept custom out-of-catalog model IDs with declared capabilities", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-custom-catalog-model-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const service = await new AiService(root).init();
  const saved = await service.saveProfile({
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-v3",
    modelSource: "custom",
    modelCapabilities: { contextWindow: 262144, input: ["text", "image"] },
    apiKey: "test-key"
  });
  assert.equal(saved.providerId, "xiaomi-token-plan-cn");
  assert.equal(saved.protocol, "openai-completions");
  assert.equal(saved.baseUrl, "https://token-plan-cn.xiaomimimo.com/v1");
  assert.equal(saved.modelSource, "custom");
  assert.deepEqual(saved.modelCapabilities, { contextWindow: 262144, input: ["text", "image"] });

  const capabilities = await service.getModelCapabilities(saved.id);
  assert.equal(capabilities.supportsImages, true);
  assert.equal(capabilities.contextWindow, 262144);
  assert.deepEqual(capabilities.input, ["text", "image"]);

  const runtime = await service.createRuntime(saved.id);
  assert.equal(runtime.model.id, "mimo-v3");
  assert.equal(runtime.model.baseUrl, "https://token-plan-cn.xiaomimimo.com/v1");
  assert.deepEqual(runtime.model.input, ["text", "image"]);
  assert.equal(runtime.model.contextWindow, 262144);

  // Registry round-trip keeps the custom model fields.
  const reloaded = await new AiService(root).init();
  const reloadedProfile = reloaded.listPublicProfiles().find((profile) => profile.id === saved.id);
  assert.equal(reloadedProfile.modelSource, "custom");
  assert.deepEqual(reloadedProfile.modelCapabilities.input, ["text", "image"]);

  // Unflagged out-of-catalog models stay rejected (regression guard).
  await assert.rejects(
    service.saveProfile({ providerId: "xiaomi-token-plan-cn", model: "mimo-unknown", apiKey: "k" }),
    /所选模型不属于当前 Provider/
  );

  // Capability validation failures.
  for (const bad of [
    { contextWindow: 0, input: ["text"] },
    { contextWindow: "big", input: ["text"] },
    { contextWindow: 1000, input: ["image"] },
    { contextWindow: 1000, input: ["text", "video"] }
  ]) {
    await assert.rejects(
      service.saveProfile({
        providerId: "xiaomi-token-plan-cn",
        model: "mimo-x",
        modelSource: "custom",
        modelCapabilities: bad,
        apiKey: "k"
      }),
      /模型上下文长度|模型输入模态/
    );
  }
});

test("custom out-of-catalog models gate image requests by the declared capabilities", async (t) => {
  const payloads = [];
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      payloads.push(JSON.parse(body));
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const base = { id: "chatcmpl-custom", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mimo-v3" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const service = await new AiService(await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-custom-image-"))).init();
  await withCatalogBaseUrlOverride(service, "xiaomi-token-plan-cn", `http://127.0.0.1:${server.address().port}/v1`);
  const imageProfile = await service.saveProfile({
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-v3",
    modelSource: "custom",
    modelCapabilities: { contextWindow: 200000, input: ["text", "image"] },
    apiKey: "test-key",
    activate: true
  });
  const result = await service.complete({
    prompt: "看图说话",
    images: [{ mimeType: "image/png", data: "aW1hZ2UtZGF0YQ==" }],
    profileId: imageProfile.id
  });
  assert.equal(result.text, "OK");
  assert.equal(result.model, "mimo-v3");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].model, "mimo-v3");
  assert.ok(JSON.stringify(payloads[0].messages).includes("image_url"));
  assert.ok(JSON.stringify(payloads[0].messages).includes("aW1hZ2UtZGF0YQ=="));

  const textOnlyProfile = await service.saveProfile({
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-v3-text",
    modelSource: "custom",
    apiKey: "test-key",
    activate: false
  });
  assert.deepEqual(textOnlyProfile.modelCapabilities.input, ["text"]);
  assert.equal((await service.getModelCapabilities(textOnlyProfile.id)).supportsImages, false);
  await assert.rejects(
    service.complete({
      prompt: "看图说话",
      images: [{ mimeType: "image/png", data: "aW1hZ2UtZGF0YQ==" }],
      profileId: textOnlyProfile.id
    }),
    /不支持图片输入/
  );
});

test("audio input is injected as OpenAI input_audio blocks and gates on declared capabilities", async (t) => {
  const payloads = [];
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      payloads.push(JSON.parse(body));
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const base = { id: "chatcmpl-audio", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mimo-audio" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const wavBuffer = Buffer.concat([
    Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)
  ]);
  const wavBase64 = wavBuffer.toString("base64");

  const service = await new AiService(await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-audio-"))).init();
  await withCatalogBaseUrlOverride(service, "xiaomi-token-plan-cn", `http://127.0.0.1:${server.address().port}/v1`);
  const audioProfile = await service.saveProfile({
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-audio",
    modelSource: "custom",
    modelCapabilities: { contextWindow: 200000, input: ["text", "audio"] },
    apiKey: "test-key",
    activate: true
  });

  // 纯文本提示 + 音频：payload 最后一条 user 消息含 input_audio，且保留文本；MiMo 兼容注入不丢。
  const result = await service.complete({
    prompt: "听写这段录音",
    audio: [{ mimeType: "audio/wav", data: wavBase64 }],
    profileId: audioProfile.id
  });
  assert.equal(result.text, "OK");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].model, "mimo-audio");
  assert.deepEqual(payloads[0].thinking, { type: "disabled" });
  const userMessage = payloads[0].messages.at(-1);
  assert.equal(userMessage.role, "user");
  assert.ok(Array.isArray(userMessage.content));
  assert.deepEqual(userMessage.content[0], { type: "text", text: "听写这段录音" });
  assert.deepEqual(userMessage.content[1], {
    type: "input_audio",
    input_audio: { data: wavBase64, format: "wav" }
  });

  // 图片 + 音频同时发送：image_url 与 input_audio 并存。
  payloads.length = 0;
  const multimodalProfile = await service.saveProfile({
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-av",
    modelSource: "custom",
    modelCapabilities: { contextWindow: 200000, input: ["text", "image", "audio"] },
    apiKey: "test-key",
    activate: false
  });
  await service.complete({
    prompt: "看图听音",
    images: [{ mimeType: "image/png", data: "aW1hZ2UtZGF0YQ==" }],
    audio: [{ mimeType: "audio/mpeg", data: Buffer.from("ID3").toString("base64") + Buffer.alloc(9).toString("base64") }],
    profileId: multimodalProfile.id
  });
  const mixedContent = payloads[0].messages.at(-1).content;
  assert.ok(mixedContent.some((part) => part.type === "image_url"));
  assert.deepEqual(mixedContent.find((part) => part.type === "input_audio").input_audio.format, "mp3");

  // 未声明音频能力的模型被拒绝；非法 mime 被拒绝。
  const textOnlyProfile = await service.saveProfile({
    providerId: "xiaomi-token-plan-cn",
    model: "mimo-text-only",
    modelSource: "custom",
    apiKey: "test-key",
    activate: false
  });
  await assert.rejects(
    service.complete({
      prompt: "听写",
      audio: [{ mimeType: "audio/wav", data: wavBase64 }],
      profileId: textOnlyProfile.id
    }),
    /不支持音频输入/
  );
  await assert.rejects(
    service.complete({
      prompt: "听写",
      audio: [{ mimeType: "audio/x-flac", data: wavBase64 }],
      profileId: audioProfile.id
    }),
    /AI 音频格式无效/
  );

  // 无音频时请求体不含 input_audio。
  payloads.length = 0;
  await service.complete({ prompt: "普通提问", profileId: audioProfile.id });
  assert.equal(JSON.stringify(payloads[0].messages).includes("input_audio"), false);
});
