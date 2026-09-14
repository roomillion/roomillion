# room-browser-v1 规范与“千万间浏览器”房间

## 1. 结论

`0.3.0-alpha.25` 开始，网页浏览可以由普通 `.room` 房间提供界面，并通过主工作台的 `window.room.browser` 接口使用真实网页运行时。“千万间浏览器”与台账、游戏等房间一样，可以安装、切换标签、拖到独立窗口、导出和分享；接收方需要 `0.3.0-alpha.25` 或更高版本工作台。

这不是把任意网站直接嵌进房间页面。普通房间继续运行在严格 CSP 和 Room SDK 沙箱中；网页由宿主单独创建 `WebContentsView`，使用按房间 ID 隔离的持久会话。网页不能获得 `window.room`、Node、Electron、AI Key、房间数据库或本机路径。

## 2. 权限合同

浏览器房间在 Manifest 中声明：

```json
{
  "permissions": {
    "database": "private",
    "browser": ["navigate", "download"],
    "network": []
  }
}
```

- `browser.navigate`：允许宿主网页视图访问任意 HTTP/HTTPS 地址。它是高风险权限，外部导入房间默认关闭。
- `browser.download`：允许网页请求下载，必须与 `navigate` 一起声明；每个文件均弹出系统保存窗口。
- `permissions.network`：仍用于已知精确源的业务 API。本浏览器不声明该权限，也不通过它代理网页。
- 主工作台“允许已授权房间联网”是第二道总开关。房间获权但总开关关闭时，导航、子资源、WebSocket 和下载均被宿主拦截；切换为关闭会销毁当前网页渲染视图、取消下载和临时网站授权，以终止既有长连接，但保留标签地址与标题供重新联网后刷新。

浏览器权限应只授予用户明确要做网页浏览的房间。AI Harness 检测到“浏览器、网页访问、地址栏”等需求后，会要求生成代码同时声明 `browser.navigate`、调用 `room.browser` 并上报网页显示区域；不再允许输出只有假地址栏、没有真实浏览能力的房间。

## 3. Room Browser API

`window.room.browser` 当前提供：

| 方法 | 用途 |
|---|---|
| `getState()` | 读取标签列表、活动标签、加载与前进后退状态、联网和权限状态 |
| `createTab(input?)` | 创建空白标签；可选传入网址或搜索文本 |
| `closeTab(tabId)` / `activateTab(tabId)` | 关闭或切换标签 |
| `navigate(tabId, input)` | 输入网址或搜索；无协议地址补全 HTTPS，普通文本使用百度搜索 |
| `goBack` / `goForward` / `reload` / `stop` | 基础浏览控制 |
| `setViewport(bounds)` | 把房间内用于显示网页的矩形区域报告给宿主 |
| `clearData(options?)` | 清理当前浏览器房间的 Cookie、站点存储和缓存 |
| `respondToPermission(requestId, allowed)` | 响应本次网站权限请求 |
| `onStateChanged` / `onDownload` / `onPermissionRequest` | 订阅标签、下载和网站权限事件；均返回取消订阅函数 |

`setViewport` 的坐标相对于房间内容左上角。房间应在启动、窗口大小改变、工具栏或侧栏显隐后重新上报；当前实现使用 `ResizeObserver`。宿主最多允许 12 个网页标签，拒绝非 HTTP/HTTPS 协议以及含用户名或密码的网址。

## 4. 安全与数据隔离

网页运行时固定使用：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- 不配置房间 preload，不暴露任何 Room SDK
- `window.open` 拒绝原生新窗口，并在限额内转成同一浏览器房间的受控标签

每个房间 ID 的浏览器分区不同。网站 A 不能读取另一个房间浏览器中的 Cookie 或站点存储，更不能读取工作台主界面和 AI 能力中心的会话。TLS 证书错误不会被忽略，`file:`、`data:`、自定义协议和带认证信息的网址不能导航。

摄像头/麦克风、位置、通知、剪贴板、MIDI、鼠标锁定和空闲检测默认拒绝。宿主只把受支持请求的来源与能力名称通知浏览器房间，由用户当次确认；请求 30 秒未处理即拒绝。网站授权只保留在当前运行期，清理数据、完全卸载或重启后不自动恢复。

## 5. 数据、导出与卸载

“千万间浏览器”把收藏夹和最近 200 条历史记录写入房间私有存储：

- 导出“仅应用”：不包含收藏和历史。
- 导出“应用和数据”：包含收藏和历史；可独立选择是否设置密码。
- Cookie、登录态、网页 localStorage、IndexedDB、Service Worker 和缓存始终不进入 `.room`，即使选择“应用和数据”也不导出，避免把网站身份凭据分享给他人。
- 卸载并保留数据：房间程序移除，房间数据和浏览会话保留，重装相同房间 ID 后继续使用。
- 卸载并同时删除数据：房间数据和浏览会话一并清理。

## 6. 当前示例能力

内置“千万间浏览器”已经提供：

- 多标签、活动标签切换、中键关闭和最多 12 标签提示；
- 地址/搜索合一、后退、前进、刷新、停止和新标签；
- 收藏夹、浏览历史、独立清理和打开已保存网页；
- 工作台联网状态提示、权限不足提示和加载错误提示；
- 网页下载进度反馈与系统保存位置确认；
- 网站敏感权限的来源展示、允许和拒绝；
- 清理当前房间 Cookie、站点存储与缓存；
- 主工作台标签切换、侧栏三态和独立窗口之间无刷新重挂网页视图。

它定位为轻量通用浏览器房间，不承诺 Chrome/Edge 的账号同步、密码管理器、扩展市场、开发者工具产品化、企业策略或 DRM 能力。

## 7. AI 生成浏览器房间的规则

AI 可以自由设计不同浏览器外观或业务流程，但必须遵守：

1. Manifest 声明 `browser.navigate`；确有下载需求时才声明 `browser.download`。
2. 使用 `room.browser.createTab` / `navigate` 和状态事件，不使用 `iframe`、`webview`、`window.open`、`location`、`fetch` 或 XHR。
3. 提供真实地址/搜索输入和最基本的加载、错误、联网关闭反馈。
4. 提供一个真实可测量的网页显示区域，并通过 `setViewport` 持续同步。
5. 网站权限必须显示请求来源，不能自动允许；网页和房间内容不得互相注入脚本或 HTML。
6. 收藏、历史等产品数据走 `room.storage` / `room.db`；不得试图读取网页 Cookie。

Harness 的静态检查会验证能力声明与调用是否一致；契约测试会对浏览器意图检查导航 API、视口上报和基础导航界面。最终安装仍经过普通房间的清单、CSP、权限和可移植性验证。

## 8. 验收

开发验证：

```powershell
npm test
npm run smoke -- --offline-audit
```

自动测试覆盖 URL 归一化、非法协议、联网总闸、浏览器权限、12 标签上限、网页视图边界、主/独立窗口重挂、网站权限响应、数据清理与权限撤销。Electron 冒烟使用本机回环 HTTP 服务加载真实页面，确认标题、URL、加载完成、受控 API、独立窗口重挂后页面状态不丢失；关闭普通互联网时离线审计应保持外部出站尝试为 `0`。
