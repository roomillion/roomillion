# Android 房间宿主（实验工程）

这是独立的 Android 宿主原型，不属于 0.4.1 桌面发行包，也不是已验收的手机正式版。Android 12（API 31）及以上可安装调试 APK。安卓原生宿主负责导入、运行和更新房间，AI 修改页面复用 Pi Agent 的浏览器核心；APK 不包含桌面 Electron 主进程。

## 已实现的范围

- 安卓和桌面均可作为房间联机主机或玩家，共用 `room.multiplayer` 接口；安卓提供手机热点入口，两端支持私密/公开消息与断线重连。用户需安装相同版本的房间并连接热点或可互通的局域网。详见[联机接口](LAN.md)；当前没有自动发现或 Wi-Fi Direct，实际热点人数、锁屏及厂商兼容性仍需真机验收。

- AI 设置提供可搜索的提供商和模型目录，选取后自动填写接口地址、模型名称及目录声明的输入能力；目录由桌面同一固定版本的 Pi 目录生成，随 APK 离线携带。当前列出可通过安卓聊天补全网关调用的提供商（例如 MiMo、通义 Token Plan、智谱 Coding、DeepSeek、Kimi 开放平台、OpenCode Go、OpenRouter），也可手动输入模型名称或选择自定义 HTTPS 接口。OAuth、Anthropic Messages、Gemini 原生、OpenAI Responses 等尚未接入安卓网关的协议不作为可用预设显示；目录声明不等于账号已开通模型，需用自己的密钥测试。已有手动配置保持自定义身份；切换提供商或修改接口地址后需重新填写密钥。
- 通过系统文件选择器导入桌面导出的纯程序或“应用＋数据” `.room` 包，包括密码保护的传输包。导入前核对清单、路径、大小与 SHA-256；数据包还验证 SQLite 完整性，并在失败时保留旧房间。加密包使用与桌面相同的 scrypt + AES-256-GCM 解锁，密码不交给房间。安卓原型限制纯程序包 50 MiB、普通传输包 256 MiB、加密包 64 MiB；更大的包会明确拒绝。兼容性预检会指出已知模块和接口缺口，但不能保证未声明或动态调用的功能可用。
- 房间列表可导出纯程序 `.room` 供他人安装，也可导出包含 SQLite 与房间附件的“应用＋数据”包；数据包可选明文或密码保护。保存位置由系统文件选择器决定。密码保护导出的压缩包限 45 MiB，导入封套限 64 MiB；密钥仅用于本次导出。
- 房间列表提供带确认的卸载入口，删除该房间程序、数据库与附件并清除原授权；重新导入同一房间不会继承已删除的授权。导出的副本不受卸载影响。
- 每个房间使用不同的本地 HTTPS 来源和独立 WebView。外部资源与导航被拦截；页面通过受控消息桥调用已获准的接口，无法直接取得 API 密钥或任意本地路径。Android 12 较旧的系统 WebView 若缺少页面启动脚本能力，宿主会先给本地 HTML 插入受信任桥脚本，仍要求安全消息桥和主页面来源校验。
- 房间 WebView 不接受 Cookie；工作台启动时会清理实验版早期可能遗留的 WebView Cookie 和网页存储。Android 12/16 手机与平板模拟器已验证旧 Cookie 清除及重开后不能写入持久 Cookie；Service Worker 注册探针在这些模拟环境中未成功，其他厂商 WebView 仍需真机复核。
- Room SDK 子集：`getInfo`、私有 `db.query/run`、`storage.get/set`、文本文件选择与导出、二进制文件选择/分块读取/导出，以及 `ai.listModels/generate/onModelsChanged`。`generate` 支持文本、直接提供的图片或音频数据与 `onChunk` 逐段回调；兼容字符串或分段文本形式的模型回答。图片/音频通过分块消息暂存并由宿主核验文件格式，单次请求媒体总量限 16 MiB。文件与 AI 能力须先由房间声明、再经用户按房间授权；视觉和音频调用还分别要求房间声明 `vision`、`audio` 角色。首次打开可选择暂不授权，之后可在房间列表中调整。文件操作还需要系统选择器；直接读取二进制文件限 32 MiB，分块令牌及导出暂存限 64 MiB。安卓工作台可配置多个模型、分别勾选图片/音频输入能力并指定默认模型；房间可通过配置 ID 选择其他模型，也可在房间保持打开时切换默认模型并收到 `onModelsChanged` 通知；模型设置可发送一次简短请求测试连接。密钥由 Android Keystore 加密；模型服务的原始错误正文不会转发给房间。文本模型已在模拟器以两套真实配置走通 AI 辩论；图片/音频真实服务、实体机与其他提供商仍待验收。
- 离开或切换房间时，宿主会取消该房间尚未完成的 AI 请求并断开连接，避免旧请求占用后续模型调用的线程。
- 数据库参数支持文本、数字、`null` 和 `Uint8Array`；BLOB 查询结果会返回 `Uint8Array`。安卓消息桥对单个 SQL 二进制参数或结果限 512 KiB，较大的文件应使用文件令牌或附件接口，不能把数据库当成任意大文件通道。
- `files.openBinary` 可指定 `maxBytes`：系统文件选择器返回文件后先核对已知大小，再在暂存复制过程中强制该上限；房间可在读取分块前拒绝不适合模型处理的大文件。公开音频分析室已使用这个接口，安卓上按单次 AI 媒体 16 MiB 上限提示。
- 房间私有 `room.blobs` 和 `room.artifacts` 支持列出、写入、分块读写及删除，沿用桌面 `blobs/index.json` 与 `.bin` 文件格式；“应用＋数据”导出后可在另一安卓宿主导入继续读取。底层桥接块限 256 KiB，`read` 可自动拼接至每次 8 MiB，新建单个 Blob 限 64 MiB。图片/音频 AI 可使用本房间 `{blobId}` 引用，单次模型请求仍限 16 MiB；`artifacts.exportToDirectory` 暂未接入。
- `room.documents.markdownToPdf` 在拥有私有数据权限的房间中生成可读取、导出的 PDF 制品。安卓使用系统 PDF 绘制，支持基本标题、段落、列表和分页；与桌面排版引擎的复杂表格、图片和样式效果尚未对齐。文档工作台已在三种模拟环境通过系统选择器打开 PDF、Markdown、Word、Excel 和 PPTX，预览/翻页、Word 转 Markdown 与 Markdown 转 PDF 保存均已验证；大文件和复杂排版仍需实机测试。
- `room.files.beginExport/writeExport/finishExport/abortExport` 与桌面一样可逐块写入文本或二进制内容；安卓每块限 256 KiB，总量限 64 MiB，在 `finishExport` 时由用户选择保存位置。返回的 `path` 仅是文件显示名称，不是系统路径；取消保存时返回 `null`。
- 桌面发布的公开示例中，物资台账与会议行动项已在 Android 12/API 31 和 Android 16/API 36 手机模拟器、Android 16 平板模拟器中完成页面、数据库、隔离和新增/删除交互测试。它们的 AI 按钮需要在安卓端配置兼容的 HTTPS 聊天补全接口。
- APK 离线携带并按房间声明提供首批 14 个官方浏览器模块：日期、精确小数、CSV、搜索、基础图表、HTML 清理、Markdown、ZIP、二维码、基础 XLSX 表格、PDF 阅读、Word 写入、Word 读取和 Word 预览。模拟器已验证二维码、XLSX 往返、Word 模块和 PDF 文字提取；未声明的模块资源不能访问。其余模块仍在兼容性预检中报告为缺口。
- 房间列表可在预览字段后导出诊断 JSON：只含 Android/WebView/应用版本、房间与文本模型数量，以及最多 100 条操作类别和成败状态，不记录房间名称、密钥、对话、文件内容、路径或网址。
- 安卓系统的云备份及设备间自动迁移不复制宿主私有数据；需要迁移房间时使用工作台的“应用＋数据”导出/导入，模型密钥在新设备上重新配置。

目前**不支持**手机端从零 AI 创建房间、其余 25 个桌面官方模块、任意网络权限，以及其他尚未接入的 Room SDK 接口。安卓 AI 图片/音频输入支持直接提供字节或房间 Blob ID，尚不支持桌面的目录授权引用；较大的媒体文件仍需扩展模型请求传输。导入一个包不代表其中每项功能都能在 Android 上运行。签名安装包、双品牌真机和平板验收尚未完成。

八个公开示例及全部 39 个官方模块的当前状态见[兼容性记录](COMPATIBILITY.md)。

## 用 AI 修改已有房间

先在工作台配置支持工具调用的聊天补全模型。在房间列表或打开房间后的工具栏点击“AI 修改房间”，描述要改什么；无需重复澄清或确认旧方案。修改入口会关闭原房间，避免运行中的程序与更新互相干扰。首阶段支持修改已有房间，从零创建仍未接入。

开发页面复用桌面固定版本的 Pi Agent 核心，模型请求由安卓原生网关发送；APK 不需要 Node.js。可切换编程模型、设置自动重试、停止和继续对话，复制单段消息或导出完整记录。当前模型请求完整返回后显示结果，尚未逐字显示生成过程。对话、源码草稿和已完成的工具结果自动保存在本机，重新打开可继续。

AI 可以查看安卓能力与当前房间源码，读取、写入和替换文件，运行隔离测试、应用更新以及恢复上一版。源码修改发生在开发副本中，不会读取房间业务数据库、附件或模型密钥。测试在独立安卓进程、临时房间和空白数据中运行，包含启动、按钮等业务动作、结果断言及重开检查；文件和 AI 操作只能使用明确提供的模拟响应，不代表真实模型效果已经验证。

只有当前草稿通过测试后才能应用更新；程序版本自动递增，原房间数据保留，并备份上一版程序。通常可由 AI 直接应用；改变权限声明时，需点击“应用更新”确认，重开房间再选择授权。恢复上一版仅恢复程序，不撤回对话或用户数据。其他导入操作更新同一房间时，旧草稿会拒绝覆盖新程序；可先导出对话，再点击“新会话”确认重建，旧草稿会在应用私有空间留存。卸载房间会一并删除其开发草稿和对话，导出的副本由用户保管。

## 构建和验证

安装 APK 后，文件管理器的“打开方式”可以选择“千万间”来打开 `.room` 文件。工作台会预检文件，点“导入并打开”后安装并进入房间；密码包须先解锁，首次使用文件或 AI 能力仍按房间授权。程序已启动时也支持打开新文件，更新前会关闭旧房间，纯程序更新保留房间数据。“应用＋数据”包会明确提示替换数据。

该入口使用文件管理器提供的 `content://` 文件授权，不申请全部文件权限。兼容常见二进制、ZIP 及 Roomillion 专用 MIME 类型；文件管理器未正确提供类型或授权时，可使用工作台内的“导入 .room 房间包”。

准备 JDK 17、Android SDK Platform 36、Build Tools 35/36、Platform Tools，以及 API 31 手机、API 36 手机和平板模拟器。Gradle 由仓库的 Wrapper 固定为 8.13。先在仓库根目录生成公开示例包，再进入本目录，分别连接模拟器运行测试：

```text
npm run build:resources
cd android
gradlew.bat :app:assembleDebug
gradlew.bat :app:connectedDebugAndroidTest
```

调试 APK 在 `android/app/build/outputs/apk/debug/app-debug.apk`。APK 内置六个已覆盖安卓宿主能力的公开示例：物资台账、会议行动项、AI 辩论场、AI 模型能力测试、音频分析室、文档浏览与转换。首页点击“安装内置示例房间”即可选择；房间不会自动安装，安装前会显示兼容性预检。桌面浏览器和离线 3D 示例目前不在安卓 APK 中。测试 APK 另外带入 `resources/examples/` 下的八个公开示例作为兼容性测试素材。调试包只能用于内测，不能当作正式发布包分享。真实模型烟测需在当前 PowerShell 进程设置中国区 MiMo Token Plan 的 `MIMO_API_KEY`，再在专用 `roomillion-test-*` 模拟器上运行 `scripts/android-real-ai-smoke.ps1`。默认验证 AI 辩论场的双模型调用；传入 `-TestMethod realAiButtonsWorkInInventoryAndMeetingRoomsWhenCredentialIsStaged` 可验证物资台账与会议行动项的 AI 按钮。脚本只把凭据临时写入应用私有目录，测试结束会删除。这两项不属于无凭据的常规设备测试。

两家手机厂商和实体平板的验收步骤见[设备验收说明](DEVICE_ACCEPTANCE.md)。在未安装安卓宿主的专用设备上，可用 `scripts/android-device-acceptance.ps1 -Serial <adb序列号>` 构建并运行完整设备测试；本地报告写入忽略目录 `release/android-device-acceptance/`，其中含设备序列号。脚本不会覆盖已有安装，模拟器自测须显式使用 `-AllowEmulator`。

准备侧载内测包时，需由发布者在本机保管签名文件，并设置 `ROOMILLION_ANDROID_KEYSTORE`、`ROOMILLION_ANDROID_STORE_PASSWORD`、`ROOMILLION_ANDROID_KEY_ALIAS`、`ROOMILLION_ANDROID_KEY_PASSWORD` 四个环境变量，再运行 `gradlew.bat :app:assembleRelease`。缺少任一签名参数会拒绝正式构建。签名文件与密码不得提交仓库；构建成功后还需用 Android SDK `apksigner verify` 核对签名并在真机验收。升级时可用 Gradle 属性 `roomillionAndroidVersionCode` 和 `roomillionAndroidVersionName` 指定新版本，`versionCode` 必须递增。一次性测试签名下的 Release 构建、v2 签名校验及 API 31 模拟器安装启动已通过；包内携带 14 个离线模块及许可。当前仍没有可分享的正式签名包。

签名校验也覆盖 `gradlew.bat :app:assemble`、`:app:build` 和 `:app:bundleRelease` 等会生成 Release 产物的任务；只有 `:app:assembleDebug` 这样的纯调试构建可不提供签名。不能把本机调试密钥当作长期发布签名。

拿到正式长期签名包后，在仓库根目录运行 `.\scripts\android-verify-release.ps1 -Apk <APK路径> -ExpectedSignerSha256 <正式证书SHA256指纹> -ExpectedVersionCode <整数> -ExpectedVersionName <版本名>`。脚本只读取 APK，核对有效 v2/v3 签名、单一签名者、预期证书指纹、包名与版本，并输出 APK SHA-256；它不能替代真机新装、升级和数据保留测试。现有一次性测试 APK 已通过该校验脚本的正向与错误参数检查，但它们不能作为正式包分发。

最新源码还在 API 36 平板模拟器以一次性测试签名安装、启动并显示隐私入口；该测试包也已清除。

可运行 `scripts/android-test-signed-upgrade-build.ps1` 在本机生成一次性签名的 0.1.0/0.1.1 测试 APK，输出位于 Git 忽略的 `release/android-upgrade-smoke/`，脚本会删除测试密钥。这些 APK 不能分发。API 36 模拟器已验证：v1 导入物资台账并写入记录，安装同签名且递增版本号的 v2 后，房间与记录仍在；旧版回装被系统拒绝。正式签名和实体设备的升级仍待验收。

安卓宿主依赖 AndroidX WebKit 和 Bouncy Castle；依赖版本和许可来源记录在 [THIRD_PARTY.md](THIRD_PARTY.md)。
AI 修改的真实模型双轮烟测可运行 `scripts/android-real-ai-smoke.ps1 -Serial <专用模拟器序列号> -TestMethod realAiModifiesAndRevisesRoomWhenCredentialIsStaged`；凭据要求和其他真实烟测相同。无凭据回归使用明确的假响应，另外覆盖中断恢复、连续三轮调整、失败重试、隔离交互、测试失效、回滚、权限与数据保留。
内测版的数据保存、AI 请求、诊断导出与删除方式见[隐私与数据说明](PRIVACY.md)，应用首页也提供摘要入口。
