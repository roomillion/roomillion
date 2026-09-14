# 千万间 Roomillion阶段三：UOS/Linux x64 技术验证计划

> 计划版本：`0.3-alpha`
>
> 启动日期：`2026-08-29`
>
> 当前实施主机：Windows x64
>
> 阶段目标：验证同一房间和数据备份可在 Windows x64 与一款指定 UOS/Linux x64 环境之间迁移，并形成不依赖系统 Git 的 Linux 自包含发行路径。

## 1. 为什么第三阶段只做这一件事

阶段二已经完成 Windows `0.2.0` 的本机发行闭环。原始需求中尚未被验证、且最影响“分享房间”的问题，是接收方使用统信 UOS/Linux 时能否直接打开同一个房间。

因此第三阶段选择“指定 UOS/Linux x64 技术验证”为唯一主目标。AI 能力扩展、房间市场、任意后端、多人协作和自动更新不在本阶段并行展开。

## 2. 阶段承诺与非承诺

### 2.1 完成后可以承诺

- `.room 0.1` 与 `.zdata 0.1` 不携带操作系统专属路径或本机原生二进制。
- Windows x64 和已认证的 UOS/Linux x64 工作台使用相同房间包、Room SDK 和业务数据格式。
- Linux 发行物使用包内固定 Git，不查找 `/usr/bin/git`，不调用 apt、yum 或其他包管理器。
- 提供 Linux 解压目录版；设备条件满足时同时提供 AppImage。
- 运行和验证不要求 root 权限或公网。

### 2.2 本阶段不承诺

- 不承诺兼容所有 Linux 发行版、ARM64、龙芯或其他 CPU。
- 不把 Windows 可执行文件直接拿到 Linux 运行；工作台按平台分别构建。
- 不在缺少 Linux Git 工具链时静默退回系统 Git。
- 不因 AppImage 的 FUSE 或沙箱失败而静默添加 `--no-sandbox`。
- 不在尚未取得设备证据时把“可构建”写成“已认证”。

## 3. 目标矩阵与当前状态

| 对象 | Windows x64 | 指定 UOS/Linux x64 | 当前状态 |
|---|---|---|---|
| `.room 0.1` | 导入、导出、运行 | 导入、导出、运行 | 跨平台合同与 Linux 冒烟已通过；UOS 实机待验 |
| `.zdata 0.1` | 加密备份、恢复 | 加密备份、恢复 | Windows↔generic Linux 实包往返已通过；UOS 往返待验 |
| 本地版本历史 | 包内 MinGit | 包内 Linux Git | 两个平台均已完成；UOS 工具链重制与认证待验 |
| 目录发行物 | 解包目录/便携 EXE | 解压目录包 | generic Linux x64 已生成并通过离线冒烟 |
| 单文件发行物 | Portable EXE | AppImage | generic AppImage 已生成；FUSE 2 缺失时支持临时解包回退 |

首个认证目标必须从真实设备清单中锁定到“发行版名称、版本、补丁级别、桌面环境、CPU 架构”。在这份信息确认前，代码和构建产物统一标记为 `generic-linux-x64 / 未认证`。

## 4. 技术方案

### 4.1 平台运行时描述

主进程不再直接拼接 `mingit/cmd/git.exe`，而是通过平台运行时描述解析：

- Windows x64：`resources/toolchains/mingit/cmd/git.exe`。
- Linux x64：`resources/toolchains/git-linux-x64/bin/git`。
- 每个描述固定可执行文件、内部 PATH、空设备、库目录和平台标签。
- 未支持的平台或架构在启动/构建前明确失败。

Git 服务继续隔离 HOME、全局配置、hooks、凭据助手和网络协议。Linux 环境使用 `/dev/null` 和 `:` 路径分隔符，Windows 使用 `NUL` 和 `;`。

### 4.2 跨平台房间合同

房间导入和打包增加可移植性检查：

- 包内路径统一使用 `/`。
- 拒绝仅大小写或 Unicode 规范化不同的重名路径。
- 拒绝 `.exe`、`.dll`、`.node`、ELF、Mach-O 等平台原生载荷。
- 保留图片、字体、JSON、JavaScript 和 WebAssembly 等平台中立资源。
- 完整性检查结果中记录可移植性结论，供导入预检和自动验收使用。

这意味着当前房间通过 Room SDK 使用数据库、文件选择和 AI 网关，而不是把操作系统专属后端塞进 `.room`。

### 4.3 Linux 发行物

Linux 构建使用独立配置，只携带 Linux Git，不把 MinGit 放入 Linux 包。提供两个入口：

1. `dir`：优先完成，用于无 FUSE 环境和技术验证。
2. `AppImage`：在 Linux 构建机上生成并验证 Chromium 沙箱与 FUSE 条件。

构建前置检查必须确认 Linux Git 的文件布局、版本元数据和哈希；缺失时阻断构建。首个 Linux Git 二进制需要在目标 UOS 或兼容基线环境构建/归档，并补充许可证与 SBOM。

## 5. 实施批次

### 批次 E：平台合同与构建骨架

- `P3-E01` 新增平台运行时描述和受支持目标矩阵。
- `P3-E02` 将 GitService 改为 Windows/Linux 描述驱动。
- `P3-E03` 增加 Linux Git 布局、元数据和构建前置检查。
- `P3-E04` 增加 Linux `dir` 与 `AppImage` 独立构建配置。
- `P3-E05` 保持 Windows MinGit 回归测试通过。

阶段门：模拟 Linux 环境时不会出现 `git.exe`、`NUL`、分号 PATH 或 Windows 环境变量；Linux 工具链缺失会给出明确错误。

### 批次 F：房间和数据可移植性

- `P3-F01` 检查 ZIP 路径大小写和 Unicode 碰撞。
- `P3-F02` 检查原生二进制和平台专属载荷。
- `P3-F03` 将可移植性结论纳入房间包检查结果。
- `P3-F04` 在两套独立数据根之间回归 `.room/.zdata` 安装与恢复。
- `P3-F05` 建立 Windows 生成 → generic Linux 合同验证 → Windows 重装的自动测试。

阶段门：相同测试向量在 Windows 与 Linux 文件系统语义下得到相同结论；不兼容包在写入正式房间目录前被拒绝。

### 批次 G：Linux 试点包与离线验收

- `P3-G01` 入库经核验的 Linux x64 Git 工具链及许可证。
- `P3-G02` 在 Linux 构建机生成解压目录版和 AppImage。
- `P3-G03` 提供 SHA-256、离线冒烟脚本、SBOM 和第三方声明。
- `P3-G04` 在最小 PATH、无系统 Git、无公网、普通用户下运行完整冒烟。
- `P3-G05` 用 Windows 生成的 `.room/.zdata` 完成迁入迁出。

阶段门：目录版必须通过；AppImage 若因目标环境 FUSE 不可用，可以记录环境限制，但不得影响目录版验收。

当前进度：`P3-G01`～`P3-G05` 已在 WSL2 Ubuntu 24.04 通用基线上完成。Windows 生成的 `.room/.zdata` 由打包后的 Linux ELF 在空 PATH 下恢复并写入第二条记录，随后回到 Windows 重新安装和恢复；房间包 SHA-256 保持一致，数据摘要和两条记录均通过。该结论只叫 `generic-linux-x64 技术预览`；同一流程在指定 UOS 实机上的复验和整个批次 H 仍未完成。

### 批次 H：指定 UOS 设备认证

- `P3-H01` 锁定设备版本和补丁基线。
- `P3-H02` 验证中文输入法、字体、高 DPI、拖放和文件选择。
- `P3-H03` 验证 Chromium 沙箱、SQLite 锁、目录权限和磁盘不足行为。
- `P3-H04` 验证内网 AI Provider、私有 CA 和完全离线模式。
- `P3-H05` 归档日志、截图、哈希、失败项和复测结论。

阶段门：仅通过 H 的精确系统版本进入“已认证”列表；其他 Linux 仍标记为未验证。

## 6. 验收指标

- Windows 现有自动测试与打包后冒烟无回归。
- 平台运行时和房间可移植性新增测试全部通过。
- Linux 包不包含 MinGit，Windows 包不包含 Linux Git。
- 在目标 UOS 普通用户下，首次启动不要求 root、Node、Bun、Git 或公网。
- 示例房间、备份恢复、版本历史和离线审计均通过。
- Windows 与 UOS 间往返迁移后，业务数据查询结果一致。
- 任一原生载荷、路径碰撞、工具链缺失或出站网络尝试均使验收失败。

## 7. 当前系统上怎样执行

当前 Windows 主机可通过 WSL2 复现 generic Linux 构建；在原生 Linux/UOS 上使用相同脚本：

```sh
sh scripts/linux/collect-system-profile.sh system-profile.json
sh scripts/linux/smoke-toolchain-preparation.sh
sh scripts/linux/prepare-git-toolchain.sh --output .linux-build/git-linux-x64
sh scripts/linux/build-generic-preview.sh --toolchain .linux-build/git-linux-x64 --appimage
sh scripts/linux/build-generic-preview.sh --toolchain .linux-build/git-linux-x64 --offline --appimage
sh scripts/linux/verify-pilot.sh release/linux/linux-unpacked/roomillion
sh scripts/linux/verify-pilot.sh release/linux/Roomillion-0.3.0-alpha.1-x86_64.AppImage
```

首次在线构建把固定 Node、npm 依赖、Electron 和 electron-builder 二进制缓存到项目内 `.linux-build/`；第二次 `--offline` 会启用 npm 离线模式，并把 Electron 镜像指向不可达的 `127.0.0.1:9`，用失败即停止的方式证明缓存闭环。工具链准备脚本本身不联网、不安装系统包、不要求 root。

进入目标 UOS 时，应先收集匿名系统画像，再在该系统重制 Git 工具链并执行相同两轮构建和冒烟。AppImage 若没有 `libfuse.so.2`，验收脚本会临时解包后直接运行内置程序，不会添加 `--no-sandbox`。

### 7.1 推荐的 UOS 离线验收包流程

Windows 先运行 `npm run migration:create-source` 生成公开测试用迁移源；Linux 构建完成后运行：

```sh
sh scripts/linux/build-uos-acceptance-kit.sh
```

把生成的 `Roomillion-0.3.0-alpha.1-UOS-x64-Acceptance-Kit.tar.xz` 带到目标机。包内 `run-uos-acceptance.sh` 会依次执行：全包 SHA-256、匿名画像、目录版离线冒烟、AppImage 离线冒烟、Windows 源迁入与 Linux 回传；结果全部写入独立目录，不修改验收包。测试人员随后完成 H02～H04 人工清单，并将回传目录交给 Windows 执行 `migration:verify-return`。

第三阶段代码完成不等于 UOS 认证完成。发布决策必须同时检查自动证据和实机证据。
