"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AgentWebService, htmlToText, isBlockedAddress } = require("../src/main/agent-web-service.cjs");

function networkService(enabled = true) {
  return { getPublicState: () => ({ roomNetworkEnabled: enabled }) };
}

test("agent web tools obey the workbench network switch", async () => {
  const service = new AgentWebService({
    networkService: networkService(false),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => new Response("unexpected")
  });
  await assert.rejects(service.read("https://example.com"), /工作台联网已关闭/);
  await assert.rejects(service.search("Roomillion"), /工作台联网已关闭/);
});

test("agent web page reader extracts bounded text and revalidates redirects", async () => {
  const calls = [];
  const service = new AgentWebService({
    networkService: networkService(true),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url) => {
      calls.push(url.toString());
      if (url.pathname === "/start") return new Response(null, { status: 302, headers: { location: "/article" } });
      return new Response("<html><head><style>secret{}</style></head><body><h1>公开文档</h1><p>第一段 &amp; 第二段</p><script>ignore()</script></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
  });
  const result = await service.read("https://example.com/start", { maxChars: 2000 });
  assert.deepEqual(calls, ["https://example.com/start", "https://example.com/article"]);
  assert.match(result.text, /公开文档/);
  assert.match(result.text, /第一段 & 第二段/);
  assert.doesNotMatch(result.text, /ignore|secret/);
  assert.equal(result.truncated, false);
});

test("agent web search returns normalized public results", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title>Roomillion &amp; Docs</title><link>https://example.com/docs</link><description><![CDATA[公开 <b>文档</b> 摘要]]></description></item></channel></rss>`;
  const service = new AgentWebService({
    networkService: networkService(true),
    lookup: async () => [{ address: "204.79.197.200", family: 4 }],
    fetchImpl: async (url) => {
      assert.equal(url.hostname, "www.bing.com");
      assert.match(url.search, /Roomillion/);
      return new Response(rss, { headers: { "content-type": "application/rss+xml" } });
    }
  });
  const result = await service.search("Roomillion", { limit: 3 });
  assert.deepEqual(result.results, [{ title: "Roomillion & Docs", url: "https://example.com/docs", snippet: "公开 文档 摘要" }]);
});

test("agent web access allows intranet sites but rejects local host, link-local and binary targets", async () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("169.254.1.2"), true);
  assert.equal(isBlockedAddress("192.168.1.2"), false);
  assert.equal(isBlockedAddress("10.0.0.5"), false);
  const blockedService = new AgentWebService({
    networkService: networkService(true),
    lookup: async () => [{ address: "169.254.1.5", family: 4 }],
    fetchImpl: async () => new Response("unexpected")
  });
  await assert.rejects(blockedService.read("https://metadata.example"), /链路本地或保留地址/);
  await assert.rejects(blockedService.read("http://localhost/admin"), /工作台自身/);

  const intranetService = new AgentWebService({
    networkService: networkService(true),
    lookup: async () => [{ address: "192.168.1.20", family: 4 }],
    fetchImpl: async () => new Response("<main>内网文档</main>", { headers: { "content-type": "text/html" } })
  });
  assert.match((await intranetService.read("http://docs.intranet.local")).text, /内网文档/);

  const binaryService = new AgentWebService({
    networkService: networkService(true),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } })
  });
  await assert.rejects(binaryService.read("https://example.com/file"), /不读取二进制内容/);
});

test("agent web reader can use an isolated JavaScript renderer", async () => {
  const calls = [];
  const service = new AgentWebService({
    networkService: networkService(true),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    pageRenderer: async (url, options) => {
      calls.push({ url, maxChars: options.maxChars });
      await options.validateUrl("https://cdn.example.com/app.js");
      return { url, title: "控制台", text: "JavaScript 渲染后的页面", renderedJavaScript: true };
    }
  });
  const result = await service.read("https://example.com/app", { maxChars: 50000, renderJavaScript: true });
  assert.equal(result.renderedJavaScript, true);
  assert.deepEqual(calls, [{ url: "https://example.com/app", maxChars: 50000 }]);
});

test("html text conversion keeps readable structure", () => {
  assert.equal(htmlToText("<h1>A</h1><p>B<br>C</p>"), "A\nB\nC");
});
