# 千万间 Roomillion移动端可行性调研与未来支持计划

> 文档状态：已完成调研，暂缓实施  
> 决策日期：2026-09-06  
> 适用项目：千万间 Roomillion / `.room` 房间运行时
> 当前决策：继续优先完善桌面端，本文件仅作为未来启动 Android、iOS 支持时的技术依据，不代表当前版本已经支持移动设备。

## 1. 结论摘要

千万间 Roomillion可以支持 Android 和 iOS，并且可以把“同一个 `.room` 文件在多个平台打开”作为核心产品能力。

但当前桌面程序不能直接重新打包成 APK 或 IPA。现有宿主基于 Electron 和 Node.js，Electron 官方目标平台为 Windows、macOS 和 Linux；Bun 官方提供的可执行目标同样不包括 Android、iOS。未来需要在保留房间格式、网页代码、内置模块和 AiService 协议的基础上，开发独立的移动端宿主。

推荐的产品形态是：

```text
一套房间标准和公共 SDK
        │
        ├── Electron 桌面宿主
        │     ├── Windows
        │     ├── Linux
        │     └── macOS
        │
        └── 移动宿主
              ├── Android
              └── iOS
```

桌面版继续承载完整能力；移动版重点承载房间查看、数据录入、AI 交互、图片输入、文件分享、轻量编辑和中等复杂度的办公及 3D 场景。

## 2. 与“小程序”模式的关系

智变房间的运行模式与微信小程序相似：一个主应用承载多个小程序式应用，房间只能通过宿主提供的统一 SDK 使用 AI、文件、数据库、网络和系统能力。

两者的主要区别是：

| 方面 | 常见小程序平台 | 智变房间 |
| --- | --- | --- |
| 分发方式 | 通过中心平台发布 | `.room` 文件导入、分享，也可建设组织房间仓库 |
| 网络要求 | 通常依赖平台服务 | 默认支持离线运行，只在需要时调用 Token API |
| 开发方式 | 开发者编写和发布 | AI Harness 根据自然语言生成并校验 |
| 数据位置 | 平台生态和云端为主 | 默认保存在用户设备或组织内网 |
| 系统能力 | 平台提供固定 API | 由千万间 Roomillion提供跨平台能力代理 |
| 目标平台 | 依赖所属超级应用 | 桌面、移动端和内网终端 |

因此，对外可以将其描述为“类似小程序的使用体验”，更准确的产品定义是：

> 千万间 Roomillion 是面向桌面、移动端和内网环境，由 AI 创建的本地化小程序平台；房间是可以离线分享的 AI 小程序。

## 3. 当前项目的移动端约束

当前桌面宿主使用 Electron 主进程、预加载桥接、BrowserWindow/WebContentsView、Node.js 文件接口、安全存储、进程调用和桌面窗口管理。这些代码不能原样运行在 Android 或 iOS。

需要替换的主要部分包括：

- Electron 主进程和 IPC 桥接；
- 桌面文件路径、目录遍历和打开/保存对话框；
- BrowserWindow 独立窗口机制；
- MinGit 和子进程调用；
- Electron safeStorage；
- 桌面协议、安装、更新与文件关联；
- 面向桌面键鼠和宽屏设计的部分界面。

可以大量复用的部分包括：

- `.room` 包格式和 manifest 思想；
- HTML、CSS、JavaScript 房间代码；
- 纯浏览器 JavaScript/WASM 模块；
- 房间权限声明和宿主能力模型；
- AiService 的提供商、模型选择和流式响应概念；
- 房间生成 Harness、静态检查和评测体系；
- 大部分主界面视觉体系，但需要移动响应式改造。

## 4. 单一 `.room` 跨平台目标

### 4.1 基本原则

跨平台 `.room` 应当只包含平台无关内容：

```text
example.room
├── manifest.json
├── index.html
├── scripts/
├── styles/
├── assets/
├── modules.lock
├── migrations/
└── signature.json
```

全平台房间不得携带或依赖：

- Electron、Node.js 或 Bun 运行时；
- Windows EXE、DLL；
- Android DEX、JAR、`.so`；
- Apple 平台原生二进制；
- Git Bash、MinGit；
- 未经宿主代理的任意系统命令和本地路径访问。

工作台已经内置的公共模块不重复打包。房间只在 `modules.lock` 中声明模块和兼容版本；工作台之外的纯 JavaScript/WASM 依赖可以随房间打包，但必须经过许可、体积、安全和平台兼容检查。

### 4.2 建议的兼容等级

- `portable@1`：支持 Windows、Linux、macOS、Android、iOS。
- `desktop@1`：面向桌面平台，可以使用桌面增强能力。
- `mobile@1`：专门面向手机和平板。
- 精确平台声明：用于只支持部分系统的特殊房间。

AI 创建房间时默认以 `portable@1` 为目标。只有用户明确要求超大文件、Git、系统命令、目录批处理等功能时，才切换到桌面配置并提前说明限制。

### 4.3 manifest 扩展草案

未来启动移动端工作时，建议为房间清单增加以下字段：

```json
{
  "format": "zroom@1",
  "runtimeProfile": "portable@1",
  "platforms": ["windows", "linux", "macos", "android", "ios"],
  "capabilities": [
    "ai.chat",
    "ai.vision",
    "database",
    "file.open",
    "file.save"
  ],
  "modules": {
    "echarts": "builtin",
    "dayjs": "builtin",
    "sql": "host"
  },
  "layout": {
    "phone": true,
    "tablet": true,
    "desktop": true
  },
  "resourceBudget": {
    "packageMB": 100,
    "workingMemoryMB": 256
  },
  "inputMethods": ["touch", "keyboard", "mouse"]
}
```

安装和启动前，宿主必须检查房间格式、目标平台、内置模块版本、能力缺口、权限授权、资源预算、包完整性和签名。

## 5. 跨平台宿主接口

房间不得直接调用 Electron、Node、Kotlin 或 Swift API。公共 SDK 应提供稳定的、可版本化的接口，例如：

```javascript
Workbench.AI.chat(...)
Workbench.AI.vision(...)
Workbench.Database.query(...)
Workbench.Files.open(...)
Workbench.Files.save(...)
Workbench.Network.fetch(...)
Workbench.Share.file(...)
Workbench.Media.pickImage(...)
Workbench.Permissions.request(...)
```

各平台分别实现接口：

| 公共能力 | 桌面端实现 | Android 实现 | iOS 实现 |
| --- | --- | --- | --- |
| 数据库 | 现有宿主数据库层 | SQLite | SQLite |
| 文件选择 | Electron 对话框 | Storage Access Framework | Document Picker |
| 密钥保存 | safeStorage | Android 安全存储 | Keychain |
| AI/网络 | 桌面网络代理 | 原生 HTTPS 客户端 | URLSession |
| 分享 | 桌面保存/导出 | Android Share Sheet | iOS Share Sheet |
| 窗口 | BrowserWindow | 页面/Activity，平板可增强 | 页面/Scene，iPad 可增强 |

运行数据与房间程序应分离：

- `.room`：可重复安装和分享的程序包；
- 设备数据目录：本机运行数据；
- `.room-backup`：可选的数据备份和跨设备迁移包；
- `seed-data`：房间包内可选的只读初始数据。

## 6. 移动宿主技术选择

### 6.1 推荐第一选择：Capacitor

Capacitor 适合现有项目的 Web 技术基础，可以把 HTML/CSS/JavaScript 界面运行在 Android/iOS，并使用 Kotlin、Swift 编写文件、数据库、安全存储等原生插件。

优势：

- 现有渲染层复用率较高；
- Android/iOS 工具链和插件模式清晰；
- 适合快速建设第一个 Android 原型；
- 文件、分享和网络等基础能力已有官方接口。

注意：不能简单地把所有房间放入拥有完整 Capacitor 权限的主 WebView。AI 生成或用户导入的房间必须运行在隔离 WebView 中，通过受限消息代理请求能力。

### 6.2 长期备选：Tauri 2

Tauri 2 支持桌面和移动平台，可以使用 Rust 编写核心宿主，并通过 Kotlin、Swift 扩展移动能力。它提供移动端文件关联、SQL 和多窗口相关方案。

它更适合希望长期统一部分宿主核心、并愿意增加 Rust/原生开发投入的路线，但相对于当前 Electron 项目，初始改造成本和技术迁移风险高于 Capacitor。

### 6.3 当前建议

未来启动时先使用“Capacitor 外壳＋独立房间 WebView＋权限能力代理”完成 Android 技术验证。验证房间兼容率、隔离安全和性能后，再决定正式移动宿主继续使用 Capacitor，还是转向 Tauri 2/更原生的架构。

## 7. 安全与权限模型

每个活动房间应运行在独立的受控 WebView 中，只加载经过验证的本地资源。不得向任意房间 JavaScript 暴露完整原生桥接。

建议的调用链：

```text
房间提出请求
    ↓
能力代理验证房间 ID、会话令牌和参数
    ↓
检查 manifest 声明及用户授权
    ↓
移动宿主执行最小范围的系统操作
    ↓
只返回必要结果
```

主要安全规则：

- 每次能力调用都带房间身份和短期会话令牌；
- 文件访问必须来自用户选择或明确授权的沙箱目录；
- 网络访问经过主工作台网关，校验协议、域名、重定向和响应体积；
- API Key 永远不进入房间，仅由主工作台 AiService 持有；
- 房间之间隔离存储、数据库和缓存；
- 禁止动态加载原生可执行代码；
- 导入时执行签名、哈希、依赖、权限和恶意模式检查；
- 房间设置中展示全部所需权限、已授权权限和最近调用记录。

## 8. AI 与内网使用

移动版可以继续提供主工作台统一 AI 能力：

- 配置多个提供商和模型；
- 房间获取可用模型的名称、能力和标识，但不能读取密钥；
- 通过 `AiService.chat()` 和 `AiService.vision()` 调用聊天及图片模型；
- 由主工作台处理流式响应、联网开关、用量统计和错误标准化；
- 可以按房间授权聊天、图片、联网和特定模型；
- 没有普通互联网但能够访问 Token API 时，仍能使用 AI 功能。

内网部署优先使用组织可信的 HTTPS 证书。Android/iOS 对纯 HTTP 和不受信任证书有额外限制；如必须连接特殊内网服务，应通过受控网络配置解决，而不是允许房间自行绕过证书校验。

## 9. 预计功能兼容程度

以下为基于当前架构的初步工程判断，不是已经完成的真机测试结果。

| 房间类型或能力 | 预计移动端程度 | 备注 |
| --- | --- | --- |
| 表单、台账、习惯追踪、看板 | 高 | 主要工作是触控和响应式布局 |
| AI 聊天、图片识别、模型评测 | 高 | 通过主工作台 AiService |
| 图表、数据分析、轻量数据库 | 高 | 浏览器图表库和 SQLite 均可实现 |
| PDF、Word、Excel、PPT | 中高 | 大文档、字体、Worker 和导出内存需要专项适配 |
| Three.js、Rapier 3D 房间 | 中 | 受设备 GPU、WebView、触控方式和发热影响 |
| 地图、富文本编辑器 | 中高 | 需要检查移动交互和离线资源 |
| 1GB 以上文本 | 低 | 必须原生分块处理，不适合作为普通手机体验 |
| 任意目录和系统路径 | 低 | 移动系统沙箱不允许桌面式自由访问 |
| MinGit、系统命令和子进程 | 不建议支持 | 用房间快照、差异和版本历史代替 |
| 桌面独立窗口 | 手机上不等价 | 手机使用导航/标签，平板可探索多窗口 |

## 10. Android 与 iOS 差异

### Android

技术可行性较高，适合作为首个移动目标。Google Play 不允许应用从外部下载 DEX、JAR、`.so` 等可执行代码。JavaScript/WebView 内容存在有限空间，但不能用来绕过平台政策，因此 `.room` 必须限制为经过校验的 HTML/CSS/JavaScript/WASM 和声明式资源，并严格隔离原生桥接。

### iOS

技术上可以使用 WKWebView 运行本地 HTML/JavaScript 房间，也可以注册 `.room` 文件类型。主要风险来自 App Store 审核：Apple 对下载或执行改变应用功能的代码有限制，同时对 HTML5/JavaScript 小程序、小游戏、聊天机器人和插件提供了附带条件的路径。

未来公共商店版建议先支持声明式房间和受控内置模块组合。更自由的用户导入 HTML/JavaScript 房间，需要通过 TestFlight 和真实审核验证边界，并准备内容管理、权限同意、隐私、索引和年龄分级等机制。

企业内部使用可以另外评估 Apple Custom Apps 或符合资格的企业分发，但不能把它们当作面向公众的通用替代渠道。

## 11. 未来分阶段实施计划

### 阶段 0：启动前准备

启动条件：桌面端房间规范和 Host SDK 基本稳定，已有一组可持续回归的代表性房间。

工作内容：

- 冻结 `portable@1` 规范；
- 建立内置模块跨平台兼容表；
- 清除房间对 Electron/Node 的直接依赖；
- 抽离 Room Core 和 AiService 公共协议；
- 增加移动兼容静态检查和打包检查；
- 建立移动端测试房间集合。

### 阶段 1：Android 可行性原型

目标不是发布，而是验证架构。

验收范围：

- 展示主页和房间卡片；
- 从系统文件选择器导入一个 `.room`；
- 校验、安装和隔离运行房间；
- 提供 SQLite、文件打开/保存、分享；
- 使用主工作台配置的 Token API 聊天和识图；
- 展示房间权限并逐项授权；
- 验证至少一个表单房间、一个 AI 房间、一个办公文档房间和一个 Three.js 房间。

### 阶段 2：Android 内测版

- 补齐房间生命周期、升级、卸载、数据备份与恢复；
- 完善权限代理、网络网关、签名和诊断；
- 优化触控、手机窄屏和平板布局；
- 建立兼容性测试矩阵和性能预算；
- 验证内网 HTTPS、Token API 和离线安装；
- 明确 Google Play 与企业侧载两种发行策略。

### 阶段 3：iOS 技术验证与 TestFlight

- 配置 macOS、Xcode 和签名环境；
- 适配 WKWebView、Document Picker、Keychain 和 Share Sheet；
- 验证自定义 `.room` 文件类型；
- 处理 WebKit、字体、Worker、WASM 和内存差异；
- 以受控房间模式进行 TestFlight 测试；
- 根据 Apple 审核反馈决定公共版房间自由度。

### 阶段 4：正式跨平台能力

- AI 创建房间时支持“桌面”“全平台”“移动端”目标选择；
- 桌面打包器提供移动兼容报告；
- 同一个 `.room` 在所有声明支持的平台通过自动测试；
- 建立可信房间签名、组织仓库和兼容版本管理；
- 发布 Android，并在合规验证后决定 iOS 公共发布范围。

## 12. 建议的首批跨平台验收房间

- 报销登记：表单、SQLite、Excel/PDF 导出；
- 习惯追踪：本地数据、图表和提醒的降级策略；
- AI 辩论场：多模型选择、流式输出和主工作台 AiService；
- AI 模型能力测试：聊天、图片输入、数据库排行榜；
- 文档查看/生成房间：PDF、Word、Excel；
- Three.js 小型游戏：触控、横屏、性能和资源预算；
- 一个纯离线房间：验证无普通互联网环境下的完整安装和运行。

## 13. 当前暂缓事项

在项目重新明确启动移动端开发之前，暂不进行以下工作：

- 不创建 Android/iOS 工程；
- 不安装 Android Studio、Xcode、Capacitor 或 Tauri 移动工具链；
- 不修改现有桌面打包流程；
- 不承诺当前 `.room` 已经可以在移动端运行；
- 不为当前房间逐个实施移动适配；
- 不提交 Google Play、TestFlight 或 App Store 审核。

当前桌面端开发可以优先做两项低成本、对未来有帮助的准备，但也不因本文件自动进入实施：

1. 新增房间平台与能力声明；
2. 禁止新房间直接依赖 Electron/Node，统一通过 Workbench SDK 使用宿主能力。

## 14. 未来重新启动时的决策清单

重新启动移动端项目前，需要确认：

- 首发目标是 Android 企业内网、Google Play，还是两者同时；
- iOS 是公共 App Store、Custom Apps，还是企业内部使用；
- 是否允许用户导入任意来源房间，还是只允许可信签名房间；
- iOS 第一版采用声明式房间还是允许受控 JavaScript 房间；
- 移动端允许的最大房间体积、内存和单文件大小；
- 是否要求完全离线创建房间，还是仅要求离线运行和 Token API 可达；
- 移动宿主最终选择 Capacitor、Tauri 2，还是更原生的实现；
- 哪些桌面能力明确不进入移动端。

## 15. 官方资料

- [Electron 官方文档](https://www.electronjs.org/docs/latest/)
- [Electron 安装与支持平台](https://www.electronjs.org/docs/latest/tutorial/installation)
- [Bun 安装与支持平台](https://bun.sh/docs/installation)
- [Bun 可执行文件目标](https://bun.sh/docs/bundler/executables)
- [Capacitor 官方文档](https://capacitorjs.com/docs)
- [Capacitor Filesystem](https://capacitorjs.com/docs/apis/filesystem)
- [Capacitor Share](https://capacitorjs.com/docs/apis/share)
- [Capacitor HTTP](https://capacitorjs.com/docs/apis/http)
- [Tauri 2 官方文档](https://v2.tauri.app/start/)
- [Tauri 移动开发前置条件](https://v2.tauri.app/start/prerequisites/)
- [Tauri 移动文件关联](https://v2.tauri.app/learn/mobile-file-associations/)
- [Tauri 移动多窗口](https://v2.tauri.app/learn/mobile-multiwindow/)
- [Android WebView 文档](https://developer.android.com/develop/ui/views/layout/webapps/webview)
- [Android Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)
- [Google Play 设备和网络滥用政策](https://support.google.com/googleplay/android-developer/answer/16559646?hl=en)
- [Google Play WebView JavaScript 接口要求](https://support.google.com/googleplay/android-developer/answer/10768383?hl=en)
- [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple Mini Apps Partner Program](https://developer.apple.com/programs/mini-apps-partner/)
- [Apple 自定义文件类型](https://developer.apple.com/documentation/uniformtypeidentifiers/defining-file-and-data-types-for-your-app)
- [Apple TestFlight](https://developer.apple.com/testflight/)
- [Apple Custom Apps](https://developer.apple.com/support/volume-purchase-and-custom-apps/)
