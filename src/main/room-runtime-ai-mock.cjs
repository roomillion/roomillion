"use strict";

function createRoomRuntimeAiMock(mocks = []) {
  let index = 0;
  const generate = () => {
    const mock = mocks[index++];
    if (!mock) throw new Error("隔离检查不调用真实 AI；请在 room-tests.json 的 mocks.ai 中提供模拟响应");
    return { text: mock.text, model: "mock-model", profileId: "mock-profile", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  };
  const batch = (requests, options = {}) => {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 500) throw new Error("批量 AI 请求必须包含 1–500 项");
    const concurrency = Number(options.concurrency || 3);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("AI 并发数必须是 1–8");
    const results = requests.map((request) => {
      try {
        if (!request || typeof request.prompt !== "string" || !request.prompt) throw new Error("AI 提示内容不能为空");
        return { ok: true, ...generate() };
      } catch (error) {
        return { ok: false, error: String(error.message || error).slice(0, 2000) };
      }
    });
    return { results, total: results.length, passed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length };
  };
  return { generate, batch };
}

module.exports = { createRoomRuntimeAiMock };
