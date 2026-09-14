# Pi 升级与 OpenCode Go 接入修复

工作台版本：0.3.0-alpha.30；日期：2026-09-12。

## 升级范围

- `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core` 从 0.84.3 升至 npm 官方 latest 0.85.1，固定精确版本并更新锁文件。
- 保留 Pi 原生提供商、模型目录与各自协议；当前目录为 40 个提供商，OpenCode Go 为 27 个模型。
- 更新 SBOM、逐包声明及 Pi 0.85.1 上游许可证副本（含新传递依赖 chord）。原有配置和加密密钥格式不变。

## OpenCode Go 故障与修复

旧版批量保存 23 个模型成功，但只测试第一个 MiniMax-M3。实际 API 返回 HTTP 400 / MissingSessionID，指出缺少 `x-opencode-session`。改变测试输出 Token 限额不能解决该错误。

按 [OpenCode Go 客户端接入要求](https://opencode.ai/docs/go/#where-can-i-use-it)，工作台通过 Pi 的请求选项传递：

- 自有身份 `User-Agent: roomillion/<工作台版本>`。
- `x-opencode-session`：Agent 使用自身持久会话 ID，多轮请求保持一致；无会话参数的 Agent runtime 使用该 runtime 固定的随机 ID。独立的单次生成/连接测试默认产生独立 ID，内部调用方可显式传入 `sessionId`。

只对原生 OpenCode / OpenCode Go 提供商附加上述专用请求头，保留其他提供商设置以及调用方的其他请求头。连接失败提示明确说明已保存模型数量、实际测试的模型及其他模型尚未测试，避免将连通性失败描述成全部导入失败。

Go 的使用范围仍以服务商规则为准；客户端标识不改变订阅用途或模型访问权限。

## 验证

- 完整自动测试：164 项通过。
- 新增真实 HTTP 边界回归：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三条 Pi 适配路径均携带正确身份及会话头；验证同会话稳定、不同会话分离、fallback 稳定、其他调用方请求头保留。
- 正式 AiService 真实 API 请求：MiniMax-M3（16、1024 最大输出 Token）及 MiMo-V2.5（128）均 HTTP 200，并回复 OK。未使用诊断请求头覆盖，也没有逐一测试全部模型。
- 打包后的 Windows x64 程序隔离冒烟：PASS，报告在 `release/Roomillion-0.3.0-alpha.30-Packaged-Smoke.json`。
- 许可证原文与索引测试通过；仍存的材料待核对项见自动生成的 `resources/compliance/LICENSE-REVIEW.md`。

便携版文件名沿用递增版本规则：`Roomillion-0.3.0-alpha.30-Portable.exe`。API Key 不写入本记录、源码、测试或提交。
