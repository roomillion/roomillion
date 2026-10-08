"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCatalog, chatEndpoint } = require("../scripts/android-stage-ai-providers.cjs");

test("Android provider presets keep model-specific routes and exclude unsupported authentication/protocols", async () => {
  const { providers } = await buildCatalog();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.size, providers.length);
  assert.ok(byId.size > 10);
  assert.equal(byId.get("xiaomi-token-plan-cn").endpoint, "https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
  assert.equal(byId.get("opencode-go").endpoint, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.ok(byId.get("fireworks").models.every((model) => model.endpoint === "https://api.fireworks.ai/inference/v1/chat/completions"));
  for (const id of ["anthropic", "google", "openai-codex", "github-copilot", "cloudflare-ai-gateway", "cloudflare-workers-ai"]) {
    assert.equal(byId.has(id), false, id);
  }
  for (const provider of providers) {
    assert.ok(provider.models.some((model) => model.id === provider.defaultModel));
    assert.equal(new Set(provider.models.map((model) => model.id)).size, provider.models.length);
    for (const model of provider.models) {
      const url = new URL(model.endpoint);
      assert.equal(url.protocol, "https:");
      assert.ok(url.pathname.endsWith("/chat/completions"));
      assert.equal(url.username + url.password + url.search + url.hash, "");
    }
  }
});

test("Android catalog does not turn placeholders or credential-bearing URLs into selectable endpoints", () => {
  for (const value of [undefined, "bad URL", "http://example.test/v1", "https://example.test/{ACCOUNT}/v1", "https://user:secret@example.test/v1", "https://example.test/v1?key=secret", "https://example.test/v1#key"]) {
    assert.equal(chatEndpoint(value), null);
  }
  assert.equal(chatEndpoint("https://example.test/v1/"), "https://example.test/v1/chat/completions");
});
