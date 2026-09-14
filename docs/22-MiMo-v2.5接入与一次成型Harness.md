# MiMo v2.5 接入与一次成型 Harness

## 1. 当前结论

千万间 Roomillion已经能够通过 Pi AI 适配层连接小米 MiMo Token Plan，并使用普通 `mimo-v2.5` 创建、校验、打包和安装 room-spec@1 组合房间。

当前认证配置为：

- API 地址：`https://token-plan-cn.xiaomimimo.com/v1`
- 模型：`mimo-v2.5`
- 协议：OpenAI-compatible Chat Completions
- 密钥：只从 AI 能力中心或进程环境读取，不写入房间、Git、普通 Provider 配置和烟测输出

模型名称、能力说明见 [MiMo v2.5 模型页](https://mimo.mi.com/models/en-US/mimo-v2.5)，Token Plan 的 Codex 接入地址见 [XiaomiMiMo 官方接入指南](https://github.com/XiaomiMiMo/awesome-mimo-agent/blob/main/docs/codex.md)。

## 2. 怎样在工作台中使用

1. 打开“AI 能力中心”。
2. 在“AI 提供商”中选择推荐项“MiMo Token Plan（中国）”。
3. 地址和协议由 Pi 内置 Provider 自动配置，不需要填写。
4. 粘贴 Token Plan API Key。
5. 从 Pi 模型目录选择 `mimo-v2.5` 或 `mimo-v2.5-pro`，点击“连接并使用”。
6. 点击“AI 创建房间”，完整描述页面、数据、操作、视图、计算和导出要求。

只有选择“自定义 / 内网 OpenAI-compatible”时，界面才会展开显示名称、API 地址和模型名称。从 alpha.19 起，选择器直接同步 `@earendil-works/pi-ai` 的全部 40 个原生 Provider，另提供一个自定义入口；模型 ID、模型专属端点、协议、上下文长度、图片与推理能力均读取 Pi 的内置目录，不再由工作台维护缩减白名单。

Kimi 有两个必须分开的入口：“Kimi Code / Token Plan”使用 `https://api.kimi.com/coding` 和 `k3`、`k3-256k`、`kimi-for-coding` 等模型 ID；“Kimi 开放平台（中国）”使用 `https://api.moonshot.cn/v1` 和 `kimi-k2.5`、`kimi-k3` 等开放平台模型。两类 Key 不应交叉使用。

便携版建议默认不勾选“记住密钥”。在受控个人电脑上需要跨重启使用时，可以选择系统安全存储；密钥会由 Electron 的系统安全存储加密，不进入 `provider.json`。已经通过聊天、截图或工单暴露过的密钥应当轮换。

一个适合验收的提示词是：

> 创建一个项目问题跟踪房间：记录问题标题、责任人、发现日期、优先级、预计损失金额、处理状态和详细说明；支持搜索筛选、统计图表，并能导出 Excel。界面和字段要适合普通办公室人员直接使用。

## 3. “一次成型”的准确含义

“一次成型”指用户只提交一次需求，工作台负责完成以下闭环：

1. 以严格结构化提示调用模型。
2. 要求模型返回 JSON Object，不接受任意代码。
3. 校验规格版本、页面、数据源、组件、动作、字段引用和受控表达式。
4. 本地补齐用户明确要求的搜索、图表、统计和导出组件。
5. 根据最终组件和字段确定性选择日期、金额精度、搜索、图表、Excel 等内置模块。
6. 根据原始需求执行结构与功能质量门禁。
7. 首次结果不合格时，在同一次用户操作内最多自动修复一次。
8. 只有最终定义合格时才生成、打包和安装 `.room`；两次都不合格则终止，不留下半成品。

因此，一次用户操作通常只调用一次模型；模型输出格式或字段质量不合格时最多调用两次。界面会明确显示“`一次生成并通过质量检查`”或“`自动修复后通过质量检查`”，不会把额外调用伪装成单次 API 请求。

## 4. MiMo 兼容层

MiMo Token Plan 的普通模型在通用流式适配器下需要显式关闭思考输出，否则响应正文可能为空。工作台只对识别出的 MiMo Provider 注入：

```json
{
  "thinking": { "type": "disabled" }
}
```

创建或修改房间时还会请求：

```json
{
  "response_format": { "type": "json_object" }
}
```

这些参数通过 Pi AI 的请求载荷扩展点在内存中加入，不改变普通 OpenAI-compatible 或内网 Provider 的请求。连接测试与普通问答不强制 JSON Object。

## 5. 当前受控房间格式

当前普通房间 Harness 使用 room-spec@1，不再是固定台账模板：

- 1～6 个页面，支持堆叠和网格布局。
- 可组合 hero、text、stats、form、table、cards、board、chart、calculator、export。
- 0～4 个数据源；字段支持 text、textarea、number、date、select、boolean。
- 动作只允许 set-field、toggle、delete。
- 计算表达式只允许输入引用和 add、subtract、multiply、divide、percent、min、max。
- 工作台按组件确定性选择内置模块；AI 不输出包名，不能触发 npm 安装或公网下载。
- 每个房间会编译出自己的页面结构，但共用经过审计的受控运行时；AI 文本不会被当作 JavaScript 执行。

旧 window.ROOM_DEFINITION 台账仍可加载和修改；新建普通房间默认写入 window.ROOM_SPEC。完整合同与实施证据见《24-room-spec-v1组合房间改造实施记录》。

## 6. 本地质量门禁

质量门禁目前检查用户明确要求的房间形态：

- 规格具有可用组件结构。
- 仪表盘需求包含 stats、chart 或 board。
- 图表、计算器、看板、录入、搜索和导出要求分别映射到实际组件。
- 多页面要求确实生成多个页面。
- 组件引用的数据源、字段和动作全部存在。
- select 选项、统计字段、图表聚合和表达式树满足类型边界。

模型第一次输出不合格时，修复提示会携带原始需求、质量错误和候选 JSON；第二次仍失败则终止安装。

## 7. 开发与真实烟测

离线回归：

```powershell
npm test
```

MiMo 真实烟测只从当前进程的 `MIMO_API_KEY` 读取密钥：

```powershell
$env:MIMO_API_KEY = "<仅在当前终端临时填写测试密钥>"
npm run smoke:mimo-room
Remove-Item Env:MIMO_API_KEY
```

不要把真实密钥写入脚本、`.env`、Markdown、截图或提交记录。烟测会在系统临时目录创建独立数据根，完成连接测试、房间创建、安装、入口检查和质量评估后删除临时目录；输出不包含密钥。

截至 2026-09-01 的真实结果：工作台通过 Pi 内置 `xiaomi-token-plan-cn` Provider 使用普通 `mimo-v2.5`，一次生成 room-spec@1“项目问题跟踪中心”：2 个页面、7 个字段、hero/stats/chart/form/table/export 组件，自动绑定 6 个内置模块，无修复、无额外依赖、网络权限为空。此前 `maze` 类型“霓虹迷宫”验收也继续通过。该阶段回归为 `84/84`；截至 2026-09-04 的 alpha.3 主线为 `101/101`，并增加 Pi Agent 图片附件与自由房间回归。

## 8. 后续增强顺序

1. 建立 30～50 条办公需求金标评测集，统计首次通过率、自动修复率和组件/行为遗漏率。
2. 增加文件导入、超长文本和 PDF/Word/PPT 等受控组件。
3. 增加多数据源关联、筛选器和审批工作流动作。
4. 增加 Provider 能力探测，避免仅通过厂商或模型名称判断兼容参数。
5. 在干净 Windows、UOS 和完全断公网环境分别执行 UI 端到端验收。
