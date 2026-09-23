# 专用 AI 模型与 Jev 直觉接口

## 1. 为什么与 LLM 分开

生成式 LLM、Embedding、Rerank 和 System One 模型具有不同的输入输出合同。把它们都伪装成聊天模型会导致模型名误用、返回格式靠提示词猜测，也会让房间重复处理 API Key。因此工作台为四类能力分别管理默认配置：

- **LLM**：生成文本、代码、图片理解和音频理解，使用 `room.ai.generate()`。
- **Embedding**：文本转向量，使用 `room.ai.embed()`。
- **Rerank**：按照查询重排候选文本，使用 `room.ai.rerank()`。
- **直觉**：快速做有类型的概率决策，当前接入 TypeSafe AI 的 Jev，使用 `room.ai.intuition()`。

三类专用配置都保存显示名称、API 基础地址和模型名；API Key 只进入主进程内存或系统安全存储。房间调用 `getCapabilities()` 只能看到脱敏的配置状态、模型名和是否可用。

## 2. 工作台设置

“设置 → AI 能力”和“AI 能力中心”均显示 Embedding、Rerank、直觉三张卡片。每项都支持保存、真实连接测试、清除密钥和删除配置。

- Embedding 调用 OpenAI 兼容 `POST /embeddings`，配置可选默认向量维度。
- Rerank 调用常见 `POST /rerank` 合同，请求使用 `model`、`query`、`documents`、`top_n`，兼容 Cohere、Jina 及同结构网关。
- 直觉默认地址为 `https://api.typesafe.ai/v1`，默认模型为 `jev-latest`，调用 `POST /systemone`。

测试按钮会产生一次真实模型请求，因此测试成功只证明当时所填端点、模型和凭据可用。

## 3. 房间接口

```js
const capabilities = await room.ai.getCapabilities();

const vectors = await room.ai.embed(["第一段", "第二段"]);

const ranked = await room.ai.rerank("退款政策", candidateTexts, { topN: 5 });
// ranked.results: [{ index, relevanceScore }, ...]

const decision = await room.ai.intuition(
  { message: "生产服务已经停止，请尽快处理" },
  {
    urgent: { type: "noul", instructions: "这是否需要立即处理？" },
    queue: {
      type: "choice",
      instructions: "应该交给哪个队列？",
      criteria: { support: "普通支持", oncall: "生产事故值班" }
    },
    severity: {
      type: "score",
      instructions: "事故严重程度",
      criteria: ["低", "中", "高", "严重"]
    }
  }
);
```

`noul` 返回 0–1 的是/真概率；`choice` 返回选中项、各项概率和置信度；`score` 返回概率加权分数、各等级概率、图例和置信度。所有答案在主进程按请求类型、候选项、索引和有限数值进行校验后才交给房间。

## 4. Jev / System One 边界

Jev 不生成文字、摘要、代码或解释。它接收一份文本或结构化 `state`，并针对同一状态并行回答多项有类型问题。房间应在代码里组合概率、阈值和业务规则；低置信度结果应进入复核流程，而不是把概率当成事实。

本实现依据 TypeSafe AI 2026-09-15 的官方发布说明和当前 OpenAPI：

- [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe AI OpenAPI / Swagger](https://api.typesafe.ai/docs)

## 5. 安全与兼容

- 三类专用能力都要求房间已获得 AI 权限，调用模型 API 不受普通房间联网总开关影响。
- 房间无法读取 API Key、Authorization 头或服务地址。
- 请求不跟随重定向，超时默认 120 秒；错误信息不包含密钥和响应正文。
- `embed()` 保留旧式 `profileId + model` 调用；当工作台已配置专用 Embedding 时，无参数调用优先使用专用配置。
- Rerank 只返回输入文档索引和相关性分数，不把服务商返回的未知字段透传给房间。
- Jev 返回值必须与问题名和问题类型逐项对应，概率必须在 0–1 范围内。
