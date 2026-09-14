# room-app@1 自由房间 Harness 实施记录

> 实施日期：2026-09-02
> 状态：第一版已完成；自动测试、Electron 离线运行和真实 MiMo v2.5 生成 3D 台球均通过

## 1. 为什么需要这次改造

原 Agent 已经能持续对话和调用工具，但最终只有 `room-spec@1` 与“收集、迷宫、跑酷”三个 3D 模板。模型遇到“3D 台球”时会正确发现模板不匹配，却只能拒绝或建议改成记分表。问题不在模型，而在 Harness 没有给它一个合规的自由实现通道。

本次采用“双通道”而不是无限扩张固定模板：

| 通道 | 适合 | 优点 |
|---|---|---|
| `room-spec@1` 声明式房间 | 办公、台账、看板、计算器 | 数据稳定、结构清晰、升级兼容性高 |
| `room-app@1` 自由房间 | 新游戏、新交互、新视觉、定制业务应用 | HTML/CSS/JavaScript 可自由组合，不受组件类型限制 |

选择原则是“能完整覆盖才走模板”。固定模板不匹配时，Agent 必须进入自由房间通道，不能拒绝，也不能偷换成另一个产品。

## 2. Harness 流程

```text
用户需求
  ↓
Pi Agent 理解需求并检查 27 个内置模块
  ↓
路由：room-spec / 现成 3D 模板 / room-app 自由房间
  ↓（自由房间）
draft_custom_room
  ├─ 格式、路径和文件完整性
  ├─ HTML/CSS/JS 静态安全检查
  └─ 内置模块与权限白名单
  ↓
test_custom_room
  ├─ 静态复检
  ├─ 可见 UI 与实际交互
  ├─ 游戏循环与输入
  └─ 3D 模块和渲染器契约
  ↓ 失败：模型读取问题，重写完整规格，再次草拟
install_custom_room
  ├─ 最终复检
  ├─ 生成 CSP 约束下的启动器
  ├─ 官方模块引用宿主公共层
  ├─ 打包并安装 .room
  └─ MinGit 修改前后检查点
```

三个阶段不能跳过。草稿不会直接安装，测试过的草稿在最终安装前还会再次检查，工具参数中的完整源码不会显示在前端步骤卡或诊断事件中。

## 3. room-app@1 格式

核心字段如下：

```json
{
  "formatVersion": "room-app@1",
  "kind": "custom",
  "name": "离线 3D 台球",
  "description": "鼠标瞄准和击球的三维台球游戏",
  "theme": "dark",
  "hostModules": ["graphics.three@1", "game.audio@1"],
  "capabilities": {
    "database": false,
    "files": [],
    "ai": false,
    "network": []
  },
  "files": {
    "html": "body 内部内容",
    "css": "完整离线样式",
    "javascript": "入口模块，可静态 import 其他模块",
    "modules/game.js": "业务模块",
    "views/hud.js": "界面模块",
    "styles/narrow.css": "附加样式"
  }
}
```

`html`、`css`、`javascript` 是兼容旧版的三个入口逻辑名，不是房间只能拥有三个文件。房间可以继续写入任意数量的安全相对路径文本文件；JavaScript/MJS 使用静态 `import/export` 组合模块，额外 CSS 会自动加载，JSON 等本地资源随包保存。编译产物包含 `app/index.html`、`styles.css`、`app.js`、`bootstrap.mjs`、全部扩展源码和 `room-app.json` 元数据。官方模块通过 `/_modules/<module-id>/...` 从工作台公共层加载，所以房间的 `embeddedDependencies` 为空；使用公共目录之外且许可证允许的纯 Web 依赖时，才按既有规则随房间打包。

## 4. 自由和安全边界

“自由”是房间沙箱中的界面、交互和业务逻辑自由，不是系统级任意代码执行。

当前静态检查拒绝：

- 未声明的外部 HTTP/HTTPS URL，以及 `fetch`、XHR、WebSocket、EventSource 和 Beacon；
- `require`、`process`、`Buffer`、Electron、Node 模块和系统命令；
- `eval`、`Function`、动态 import、Worker 和 Service Worker；
- 新窗口、页面导航、`javascript:` URL；
- `innerHTML`、`outerHTML`、`insertAdjacentHTML` 和 `document.write`；
- HTML 内联事件、脚本、样式、iframe/object/embed；
- CSS `@import`、外部资源和动态表达式；
- TODO、FIXME 和明显占位实现。

运行时继续使用 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，拒绝权限请求、外部导航和新窗口。CSP 不允许渲染页直接连接外网；Room SDK 只按 Manifest 权限暴露数据库、受控文件、超长文本、AI API 和受控网络能力。需要业务联网时，Agent 必须在 `capabilities.network` 写入精确源，并使用 `window.room.network.request()`；主工作台总开关、房间逐源授权和 Manifest 声明缺一不可。

## 5. 用户怎样使用

1. 在“AI 能力中心”选择 Provider，输入 API Key。
2. 点击“AI 创建房间”。
3. 直接描述真正想要的产品，不需要先了解技术选型。例如：“创建一个真正能玩的离线 3D 台球游戏，鼠标瞄准和控制力度，有碰撞、摩擦、入袋、回合、得分和重开。”
4. 观察时间线。自由房间会显示“编写自由房间”“检查自由房间”“安装自由房间”。
5. 成果卡出现后打开。继续在同一对话说明修改，会读取完整 `room-app@1` 并原位升级同一房间。

生成阶段只需要能访问用户配置的 Token API，不访问 npm、GitHub、CDN 或普通互联网。生成后的离线房间在没有 Token API 时也能运行；调用 `window.room.ai` 的功能需要主工作台中有可用模型。如果用户明确要求房间连接业务 API，Agent 可以生成受控联网房间，但不得用联网能力下载运行代码或补装依赖。

## 6. 已实现代码

- `src/main/custom-room.cjs`：格式归一化、静态检查、权限推导、启动器、离线编译、安装和已有房间重载。
- `src/main/room-agent-service.cjs`：双通道路由提示、三阶段工具、草稿持久状态、需求契约测试和连续修改上下文。
- `src/main/skills/room-builder/SKILL.md`：不因模板限制拒绝、自由房间代码规范和内置模块 API 指南。
- `src/renderer/`：自由房间说明、3D 台球建议、三阶段时间线和成果卡。
- `test/custom-room.test.cjs`、`test/room-agent-service.test.cjs`：安全逃逸阻断、编译/升级和 Agent 三阶段端到端测试。
- `scripts/smoke-mimo-custom-room.cjs`：使用真实 MiMo Token Plan 的重复验收脚本。

## 7. 验收结果

### 7.1 自动测试

- 该阶段 Windows 自动测试为 89/89；截至 2026-09-04 的 alpha.3 主线为 101/101。
- 新增测试覆盖：`room-app@1` 规范化、HTML/CSS/JS 安全规则、官方模块共享、包内零重复依赖、加载已有源码、原位升级，以及 3D 台球请求完整走三阶段 Harness。

### 7.2 Electron 离线运行

本阶段源码运行报告：`release/free-room-harness-smoke.json`。当前便携包已经继续加入房间独立窗口，最新复验见 `release/portable-detached-room-window-smoke.json` 和文档 27。

- 自由房间在真实 Electron `WebContentsView` 沙箱中加载；
- 内置 `THREE` 可用并创建 WebGL canvas；
- 交互按钮实际生效；
- `roomReady` 正常落定，运行错误监听保留；
- 房间关闭后视图和 WebContents 正确释放；
- 默认关闭房间联网时，离线审计普通互联网出站尝试为 0；
- 原七个示例、27 个官方模块、组合房间、权限撤销、备份和 MinGit 验收继续通过。

当前便携包为 `release/Roomillion-0.3.0-alpha.3-Portable.exe`，大小 `142,187,656` 字节，SHA-256 为 `B921C9B8C9FEC0503D3E169FA495794FDB64D13236B02BA60E40DB7F8B1E27CF`；自由房间与独立窗口继续由 Electron 冒烟覆盖。

### 7.3 真实 MiMo v2.5

报告：`release/mimo-custom-room-smoke.json`。

MiMo Token Plan 的普通 `mimo-v2.5` 接收完整 3D 台球请求后，自主调用：

1. `inspect_room_capabilities`；
2. `draft_custom_room`；
3. `test_custom_room`；
4. `install_custom_room`。

最终生成名为“3D 台球”的 `room-app@1` 房间，JavaScript 约 22,972 字符，复用了 `graphics.three@1` 和 `game.audio@1`，没有额外随房间依赖，网络权限为空。静态安全、有效 UI、有效逻辑、游戏循环与输入、重开、离线 Three.js、渲染器七项契约全部通过。

测试报告与仓库均不含 API Key。密钥若曾粘贴到聊天、工单或其他外部系统，仍应在提供商后台轮换。

## 8. 仍需继续增强

- 当前“测试”以静态和契约检查为主，Electron 冒烟使用确定性自由房间夹具；下一阶段应增加生成后自动启动的隔离预览、截图/DOM 断言、控制台错误收集和有限时长游戏仿真。
- 静态正则是纵深防御的一层，不等同于完整 JavaScript 语义证明；应继续引入 AST 级规则和更细粒度的 Room SDK 能力令牌。
- 模型一次生成复杂游戏可能耗时约数分钟，应增加分阶段进度、上下文压缩、草稿版本和失败恢复。
- `room-app@1` 当前是开发期格式；v1.0 前需要冻结字段、文件上限、兼容策略、签名策略和跨 Windows/UOS 实机测试矩阵。
