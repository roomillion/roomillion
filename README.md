# 千万间 Roomillion 项目文档

千万间 Roomillion 是一个离线优先、跨平台、面向非程序员的 Vibe Coding 工作台。AI 可以在统一房间规范内自由生成“小程序”：常见办公需求走稳定的声明式组件，新游戏和定制交互走受控 HTML/CSS/JavaScript，并由 Harness 检查、测试和安装。主页用卡片集中展示已安装房间；普通房间和“AI 创建房间”都作为工作区标签打开，也都可以拖出为独立窗口。房间还能导出和分享，接收方安装一次工作台后，即可在支持的平台上导入同一个房间文件使用。

本仓库同时包含项目文档基线、已经可以运行的 Windows x64 MVP，以及 `generic-linux-x64` 技术预览。它们用来验证“工作台 → 房间包 → 独立数据 → AI 受限生成 → 离线分享”闭环，不代表全部远期能力已经完成，也不代表已经认证所有 Linux 发行版。

## 许可证

除文件或组件另有明确声明外，本项目原创代码和文档采用 [Apache License 2.0](LICENSE)，版权署名为“2026 千万间 Roomillion 项目及贡献者”，范围见 [NOTICE](NOTICE)。第三方依赖、字体、Electron、Git 工具链及已有独立许可证的模块保留各自许可，不统一改为 Apache-2.0。

第三方材料见 [声明入口](THIRD-PARTY-NOTICES.md) 和 [逐包原文索引](resources/compliance/THIRD-PARTY-LICENSES.md)。发布前必须核对 [待处理事项](resources/compliance/LICENSE-REVIEW.md)，特别是实际分发组件的许可材料和 MinGit 源码交付事项。不是“全部合规已认证”。

## 立即体验 MVP

当前 Windows 开发版为 **0.3.0-alpha.42**，generic Linux x64 技术预览仍为 **0.3.0-alpha.36**，都不是稳定版。Windows 普通用户推荐安装版；安装到当前用户、不要求管理员权限，并注册 `.room` 文件关联。仍提供目录 ZIP 和单文件免安装版。构建产物采用统一命名：

```text
release/Roomillion-0.3.0-alpha.42-Setup.exe
release/Roomillion-0.3.0-alpha.42-Portable-Folder.zip
release/Roomillion-0.3.0-alpha.42-Portable.exe
release/linux/Roomillion-0.3.0-alpha.36-linux-x64.tar.xz
release/linux/Roomillion-0.3.0-alpha.36-x86_64.AppImage
```

发布时请从对应 Release 附件下载，核对随附 SHA-256，不使用历史报告中的校验值。源代码不包含本机 `release/` 目录；尚未公开发布的产物需自行构建。当前 Windows 产物未签名。

三种 Windows 交付都不要求目标电脑预装 Node、Git、SQLite 或 npm 包。安装版支持直接双击 `.room`，但仍显示解密、完整性、权限和风险预检，用户确认后才安装；便携版继续通过导入或拖入使用。**免安装不等于数据随 EXE 携带**：房间和数据库保存在当前用户的应用数据目录，可在“设置 → 外观 → 本机数据位置”查看。迁移请使用“房间更多 → 导出 → 应用＋数据”；API Key 由系统加密，换电脑后需重新配置。`.room` 统一支持仅应用/应用＋数据，以及可选密码。旧版 `.zroom` 仍可导入和双击打开，新导出统一使用 `.room`。房间还可内带图标；AI 默认生成图标，也可按用户明确要求采用最近上传的图片，规则见 [安装版与房间图标说明](docs/49-Windows安装版文件关联与房间图标.md)。

Linux x64 技术预览位于 `release/linux/`，包含解压目录版、`tar.xz` 和 AppImage。alpha.36 已在 WSL2 Ubuntu 24.04 普通用户、空 PATH、零网络尝试下通过自动冒烟；WSL 的 WebGL 被屏蔽时显式使用 SwiftShader。这项证据用于验证通用 Linux 构建链，不能替代指定统信 UOS 版本的真实 GPU、中文输入、拖放和文件选择验收。

macOS 尚无可发布成品：当前运行时只支持 `win32-x64` 与 `linux-x64`，还需要补齐 Intel/Apple Silicon Git 工具链、macOS 打包配置、应用图标、`.room` 文档关联、签名和公证。当前 Windows 主机不能完成可信的 macOS 签名发布；实施边界见 [alpha.36 Linux 交付与 macOS 发布计划](docs/50-alpha36-Linux交付与macOS发布计划.md)。

发布前请执行 [GitHub 发布检查清单](docs/47-GitHub发布检查清单.md)。安全问题见 [SECURITY.md](SECURITY.md)，开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

从源码运行：

```powershell
npm ci --cache .npm-cache
npm start
```

## 内置示例房间

工作台现在内置六个示例：物资台账、会议行动项、离线 3D 晶体挑战、AI 辩论场、AI模型能力测试和千万间浏览器。点击左侧“示例房间”即可查看用途与权限后安装；除“千万间浏览器”外均保持普通互联网离线，“千万间浏览器”只有在用户授权并打开工作台联网总开关后才访问网页。它们覆盖数据库、文件导入导出、AI 简报、Three.js/Rapier 3D 游戏、主工作台多模型编排、多模态评测、受控网页浏览和最小权限等不同组合。详细说明见 [17-内置示例房间库](docs/17-内置示例房间库.md)，浏览器能力边界见 [37-room-browser-v1规范与浏览器房间](docs/37-room-browser-v1规范与浏览器房间.md)。

## 官方房间模块

AI 现在可以按需求从 39 个固定版本、许可证已登记的官方模块中自动选型：除日期、Office 文档、搜索、图表、Markdown 和 3D 游戏外，已加入 Tabulator、SortableJS、Mermaid、ECharts、Quill、Leaflet、mathjs、simple-statistics、Cropper.js、Konva、D3.js 与 Cytoscape.js。模块由工作台统一离线提供，多个房间共用一份只读资源；房间不能运行时安装 npm 包，也不能加载未在清单中声明的模块。基础机制见 [18-官方房间模块目录与AI自动选型](docs/18-官方房间模块目录与AI自动选型.md)，办公增强见 [20-办公文档模块与ExcelJS决策](docs/20-办公文档模块与ExcelJS决策.md)，3D 游戏能力见 [23-离线3D游戏房间第一版](docs/23-离线3D游戏房间第一版.md)，本次扩展的分级、大小、API 与安全边界见 [34-P0-P1-P2扩展模块实施记录](docs/34-P0-P1-P2扩展模块实施记录.md)。

房间打包采用“公共层优先”：已经由工作台提供的包只记录官方模块能力，不复制进 `.room`；目录外依赖必须连同实际使用的纯 Web 资源、精确版本和许可证进入房间 `embedded/`。完整规则和 v1.0 冻结策略见 [19-v1房间依赖打包策略](docs/19-v1房间依赖打包策略.md)。

验证和构建：

```powershell
npm test
npm run smoke
npm run smoke -- --offline-audit
npm run smoke:safe-storage
npm run smoke:mimo-agent
# 正式发布：先自动递增版本，再重建资源、测试并输出标准文件名
npm run release:portable
npm run build:portable-folder
npm run pilot:kit
npm run verify:linux-toolchain
# 补齐并核验 Linux Git 后，在 Linux/UOS 构建机执行底层构建：
npm run dist:linux:dir
npm run dist:linux:archive
npm run dist:linux:appimage
```

### 版本与打包规则

- 正式 Windows 便携版统一执行 `npm run release:portable`，不要手工给产物增加功能名、日期或“fixed”等临时后缀。
- 预发布版本按 `0.3.0-alpha.1 → 0.3.0-alpha.2` 递增；稳定版本按补丁号 `1.0.0 → 1.0.1` 递增。
- 产物始终写入 `release/Roomillion-<version>-Portable.exe`，版本同时写入 `package.json`、`package-lock.json`、应用界面和重新生成的 SBOM。
- `npm run build:portable` 只用于重建当前版本，不递增版本；日常代码验证使用 `npm test` 和 `npm run smoke`，不产生新发行号。
- `npm run build:portable-folder` 为当前版本生成自包含 ZIP 目录便携版，不再次递增版本；在单文件壳尚未完成代码签名或误报处理时优先交付该格式。

推荐使用无需管理员权限、带固定 Node 与项目内缓存的 Linux 预览构建链：

```sh
sh scripts/linux/prepare-git-toolchain.sh --output .linux-build/git-linux-x64
sh scripts/linux/build-generic-preview.sh --toolchain .linux-build/git-linux-x64 --appimage
sh scripts/linux/build-generic-preview.sh --toolchain .linux-build/git-linux-x64 --offline --appimage
sh scripts/linux/verify-pilot.sh release/linux/linux-unpacked/roomillion
sh scripts/linux/verify-pilot.sh release/linux/Roomillion-0.3.0-alpha.1-x86_64.AppImage
```

生成 Windows→Linux→Windows 迁移样本与 UOS 验收包：

```powershell
npm run migration:create-source
wsl.exe -d Ubuntu -- sh /mnt/d/path/to/roomillion/scripts/linux/build-uos-acceptance-kit.sh
```

目标 UOS 执行验收包内的 `sh run-uos-acceptance.sh`，再把生成的结果目录复制回 Windows：

```powershell
npm run migration:verify-return -- --input "结果目录\migration-return" --report "结果目录\windows-return-report.json" --label win32-x64
```

完整的操作、演示、数据位置和限制见 [10-MVP运行与验收指南](docs/10-MVP运行与验收指南.md)。

## 文档导航

| 文档 | 回答的问题 | 主要使用者 |
|---|---|---|
| [00-项目章程与决策摘要](docs/00-项目章程与决策摘要.md) | 为什么做、为谁做、当前已决定什么 | 发起人、决策者、项目负责人 |
| [01-产品需求文档-PRD](docs/01-产品需求文档-PRD.md) | 产品具体要解决什么、用户如何使用、如何验收 | 产品、设计、研发、测试 |
| [02-总体技术架构](docs/02-总体技术架构.md) | 工作台、Pi、Bun、Git、房间如何协作 | 架构师、研发、安全人员 |
| [03-房间包与运行时规范](docs/03-房间包与运行时规范.md) | `.room` 是什么、允许做什么、怎样兼容和隔离 | 房间 SDK、编译器、运行时研发 |
| [04-离线分发与跨平台方案](docs/04-离线分发与跨平台方案.md) | 如何做到免管理员、便携、自包含和内网分发 | 发布、运维、桌面端研发 |
| [05-实施路线图与里程碑](docs/05-实施路线图与里程碑.md) | 先做什么、何时进入下一阶段、何时应该停下来修正 | 项目负责人、团队负责人 |
| [06-MVP任务清单](docs/06-MVP任务清单.md) | 第一版具体有哪些任务、依赖和完成标准 | 研发、测试、项目管理 |
| [07-风险与决策记录](docs/07-风险与决策记录.md) | 有哪些重大风险、哪些结论仍待验证、如何防止方案漂移 | 决策者、架构师、项目负责人 |
| [08-参考资料与外部依据](docs/08-参考资料与外部依据.md) | 关键技术判断依据什么、后续到哪里复核 | 架构师、研发、评审人员 |
| [09-Windows-MVP实施计划](docs/09-Windows-MVP实施计划.md) | 当前 Windows 系统上具体怎样实现首个可运行版本 | 当前实施团队 |
| [10-MVP运行与验收指南](docs/10-MVP运行与验收指南.md) | 怎样运行、演示、验证和继续开发当前 MVP | 试用者、研发、测试 |
| [11-阶段二-Windows试点版开发计划](docs/11-阶段二-Windows试点版开发计划.md) | 如何把 0.1 MVP 推进为可供首批内网用户使用的 0.2 试点版 | 项目负责人、研发、测试、安全 |
| [12-zdata数据备份规范](docs/12-zdata数据备份规范.md) | 加密数据备份怎样生成、验证、恢复和兼容 | 研发、测试、安全 |
| [13-0.2阶段二实施记录](docs/13-0.2阶段二实施记录.md) | 阶段二哪些已实现、证据是什么、还缺哪些外部关卡 | 项目负责人、研发、测试 |
| [14-0.2干净机试点验收手册](docs/14-0.2干净机试点验收手册.md) | 第二台电脑和首批用户如何验收并回填结果 | 试点用户、测试、项目负责人 |
| [15-阶段三-UOS-Linux-x64技术验证计划](docs/15-阶段三-UOS-Linux-x64技术验证计划.md) | 如何验证同一房间和数据在 Windows 与指定 UOS/Linux x64 间迁移 | 项目负责人、桌面端研发、测试、发布 |
| [16-0.3阶段三实施记录](docs/16-0.3阶段三实施记录.md) | 阶段三当前已实现什么、证据和外部关卡分别是什么 | 项目负责人、研发、测试、发布 |
| [17-内置示例房间库](docs/17-内置示例房间库.md) | 有哪些内置示例、权限如何分配、怎样使用和继续扩展 | 试用者、房间开发者、测试 |
| [18-官方房间模块目录与AI自动选型](docs/18-官方房间模块目录与AI自动选型.md) | 默认有多少包、房间能用哪些模块、AI 如何选型和怎样做许可证审计 | 产品、房间开发者、安全、发布 |
| [19-v1房间依赖打包策略](docs/19-v1房间依赖打包策略.md) | 哪些依赖只引用工作台、哪些必须随房间打包，以及 v1 如何保持兼容 | 架构、房间编译器、AI Harness、安全、发布 |
| [20-办公文档模块与ExcelJS决策](docs/20-办公文档模块与ExcelJS决策.md) | PDF、Word、Excel、PPT 等模块如何分工，ExcelJS 是否需要，以及真实断网验收结果 | 产品、房间开发者、安全、发布 |
| [21-超长文本流式处理设计与使用指南](docs/21-超长文本流式处理设计与使用指南.md) | 1 GB 以上文本怎样分块读取、搜索、隔离和继续扩展 | 产品、房间开发者、安全、测试 |
| [22-MiMo-v2.5接入与一次成型Harness](docs/22-MiMo-v2.5接入与一次成型Harness.md) | 怎样配置 MiMo Token Plan，以及严格 JSON、自动修复和质量门禁怎样工作 | 产品、房间开发者、测试、安全 |
| [23-离线3D游戏房间第一版](docs/23-离线3D游戏房间第一版.md) | 普通互联网不可用但 Token API 可用时，怎样生成、分享和运行受控 3D 游戏 | 产品、房间开发者、测试、安全 |
| [24-room-spec-v1组合房间改造实施记录](docs/24-room-spec-v1组合房间改造实施记录.md) | AI 怎样生成真正不同的多页面、组件化房间，以及当前 DSL、兼容和安全边界 | 产品、架构、房间编译器、测试、安全 |
| [25-Pi-Agent房间开发工作区实施与使用指南](docs/25-Pi-Agent房间开发工作区实施与使用指南.md) | 怎样使用持续聊天、工具时间线、连续修改和会话恢复，以及 Pi Agent 的安全边界 | 用户、产品、架构、AI Harness、测试、安全 |
| [51-alpha39完整房间Agent-Harness](docs/51-alpha39完整房间Agent-Harness.md) | Slash 指令、子 Agent、持久语义压缩、缺失用量兼容和体验优先原则如何组成完整闭环 | 用户、产品、架构、AI Harness、测试 |
| [26-room-app-v1自由房间Harness实施记录](docs/26-room-app-v1自由房间Harness实施记录.md) | AI 怎样在不受固定模板限制的同时，通过草拟、测试、复检和沙箱约束生成自由房间 | 用户、产品、架构、AI Harness、测试、安全 |
| [27-房间独立窗口与标签拖出实施记录](docs/27-房间独立窗口与标签拖出实施记录.md) | 怎样把房间无刷新拖到独立窗口、保留状态、关闭归位并支持多显示器 | 用户、产品、桌面端研发、测试、安全 |
| [28-0.3.0-alpha.3发布基线与阶段门](docs/28-0.3.0-alpha.3发布基线与阶段门.md) | alpha.3 已交付能力、验证证据、打包规则和仍需外部条件完成的事项 | 项目负责人、研发、测试、发布 |
| [29-多模型中心与房间AI选择接口](docs/29-多模型中心与房间AI选择接口.md) | 怎样保存和切换多套模型，以及房间如何在不接触 Key 的情况下列举、选择和调用模型 | 用户、房间开发者、架构、AI Harness、安全 |
| [30-AI辩论场与主工作台模型编排](docs/30-AI辩论场与主工作台模型编排.md) | AI 辩论场怎样让正反方和裁判分别使用主工作台模型，以及如何操作、验证和扩展 | 用户、产品、房间开发者、测试、安全 |
| [31-工作台联网控制与房间网络接口](docs/31-工作台联网控制与房间网络接口.md) | AI API 与房间业务联网怎样分开管理，以及房间如何声明、授权并调用受控 HTTP/HTTPS 接口 | 用户、房间开发者、架构、AI Harness、安全 |
| [32-AI模型能力测试房间](docs/32-AI模型能力测试房间.md) | 怎样测试聊天和图片能力、查看逐题原问答，并按同一试卷比较模型成绩 | 用户、产品、AI Harness、测试 |
| [33-自定义模型评测题目规则](docs/33-自定义模型评测题目规则.md) | 怎样编写聊天题、图片题和无需执行代码的确定性评分断言 | 用户、题库设计者、AI Harness、测试、安全 |
| [34-P0-P1-P2扩展模块实施记录](docs/34-P0-P1-P2扩展模块实施记录.md) | 新增的表格、拖拽、图表、富文本、地图、计算和可视化库怎样选用、占多大及如何离线验收 | 产品、房间开发者、AI Harness、安全、发布 |
| [35-主页与AI创建工作区实施记录](docs/35-主页与AI创建工作区实施记录.md) | 主页卡片、AI 一级标签和独立窗口怎样使用、同步与验收 | 用户、产品、桌面端研发、测试 |
| [36-工作台八套主题实施记录](docs/36-工作台八套主题实施记录.md) | 四套日间和四套夜间主题怎样切换、同步、持久化与验收 | 用户、产品、设计、桌面端研发、测试 |
| [37-room-browser-v1规范与浏览器房间](docs/37-room-browser-v1规范与浏览器房间.md) | 普通房间怎样提供真实网页浏览，以及权限、隔离、数据、导出和 AI 生成合同是什么 | 用户、产品、房间开发者、桌面端研发、安全、测试 |

## 应该怎样使用这套文档

### 立项推荐

按以下顺序阅读和展示：

1. 用“00 项目章程”说明痛点、目标人群和差异化价值。
2. 用“01 PRD”的核心用户旅程演示产品不是普通代码编辑器。
3. 用“05 路线图”说明项目会先做技术验证，再投入完整 MVP。
4. 用“07 风险与决策记录”主动说明安全、Linux 兼容和第三方依赖风险已有处理机制。

立项阶段不要把所有远期能力都承诺为 MVP。立项应批准的是“房间标准 + 工作台运行时 + 受限 AI 生成闭环”的验证。

### 开始研发

1. 先完成“05 路线图”的阶段 0，不直接开发完整界面。
2. 将“06 MVP 任务清单”导入任务管理工具，每项保留原有编号。
3. 架构变更先更新“07 风险与决策记录”，再修改代码。
4. 修改房间格式、权限或 SDK 时，同时更新“03 房间规范”和对应测试。
5. 每个里程碑按文档中的退出条件评审，未满足则不得只凭“看起来能用”进入下一阶段。

### 对外沟通

建议统一使用以下一句话：

> 千万间 Roomillion不是让 AI 随意生成任意技术栈，而是让 AI 在一个离线、可分享、可审计的房间标准内生成实用工具。

避免在早期宣传“兼容所有 Linux”“绝对安全”“任何程序都能生成”或“一个安装包支持所有 CPU”。同一个房间跨平台是目标；工作台仍需针对操作系统和 CPU 分别构建并认证。

## 当前状态

- 文档版本：`0.1-mvp`
- 当前阶段：Windows x64 `0.3.0-alpha.42` 与 generic Linux x64 `0.3.0-alpha.36` 技术预览；指定 UOS 实机认证和 macOS 运行时仍待执行
- 产品名称：千万间 Roomillion
- 房间包统一扩展名：`.room`；内容和密码保护状态由包内格式安全识别
- 版本号以 `package.json` 为准；二进制的大小、校验值和测试结果必须对应该版本，不沿用旧版本数字。
- 历史人工评审报告未包含在公开仓库中；公开的修复及验证说明见 [alpha.33 修复记录](docs/46-alpha33验收问题修复.md)。小样本 AI 分数不是房间生成成功率保证。
- 剩余阶段门：按“14 验收手册”完成 Windows 干净机与内部用户试点；按“15 技术验证计划”锁定并认证一个精确的统信 UOS x64 版本。

## 文档维护规则

- PRD 描述“用户需要什么”，架构文档描述“系统如何实现”，任务清单描述“接下来做什么”，不要互相替代。
- 每次阶段评审更新文档版本、日期、负责人和结论。
- 已接受的关键架构决定记录为 ADR；改变决定时新增 ADR，不覆盖历史理由。
- 文档中的密钥、内网地址、证书和真实用户数据一律使用示例值。
