# alpha.36 Linux 交付与 macOS 发布计划

日期：2026-09-12。

## 已完成：generic Linux x64

alpha.36 已生成以下 Linux 桌面产物：

- `release/linux/linux-unpacked/`：解压目录版。
- `release/linux/Roomillion-0.3.0-alpha.36-linux-x64.tar.xz`：目录便携归档，116,932,932 字节，SHA-256 `366f81f05f0b3bde25807ee71f980f30a65ead1575cf333ca32801314df10c62`。
- `release/linux/Roomillion-0.3.0-alpha.36-x86_64.AppImage`：单文件 AppImage，174,215,295 字节，SHA-256 `1cc4a1fa2ce607e855ada17ff143ddab5bcc04ef24a7256a5ba4460cf9f29bfd`。

构建前在 Linux 目标环境重新生成房间模块、示例包、许可证清单与 SBOM，避免把 Windows 专属可选依赖误写进 Linux 发行物。Linux 与 Windows 均执行 177 项测试并全部通过。目录版和 AppImage 又分别执行打包后冒烟：普通用户、空 PATH、出站网络尝试 0，结果均为 PASS；AppImage 在没有 FUSE 2 时按设计临时解包运行。

WSL2 的 WebGL2 被系统屏蔽，本次自动冒烟显式使用 SwiftShader，只证明软件渲染路径。它不能替代指定 Linux/UOS 设备上的真实 GPU、中文输入法、高 DPI、拖放、原生文件选择器和桌面文件关联验收。当前 Linux 构建也仍使用 Electron 默认应用图标；正式发布前必须替换为千万间 Roomillion 的多尺寸 PNG 图标。AppImage 和目录便携版不会像 Windows 安装程序一样无条件注册 `.room`，需要后续增加 Linux MIME/desktop 集成或提供 `.deb` 安装包。

## 尚未完成：macOS

当前源码会主动拒绝 `darwin-x64` 和 `darwin-arm64`，因此不能把一个仅能生成 `.app` 外壳的构建称为 macOS 版。可发布版本至少需要：

1. 增加 Intel 与 Apple Silicon 两个运行时描述，并分别准备可再分发、带许可证和哈希的内置 Git 工具链；不能假定用户已安装 Homebrew、Xcode Command Line Tools 或可用的系统 Git。
2. 增加 macOS electron-builder 配置，首批分别输出 `x64` 和 `arm64` 的 DMG 与 ZIP；稳定后再评估 universal 包，避免两套 Git 工具链无条件重复进入同一包。
3. 制作 `.icns` 应用图标和 `.room` 文档图标，并通过 `CFBundleDocumentTypes` 注册房间文件；现有主进程已经监听 macOS `open-file`，仍需在真实 Finder 中验证冷启动和单实例转发。
4. 在真实 macOS 或 GitHub Actions macOS runner 上验证 Keychain/safeStorage、中文输入、拖放、文件对话框、独立窗口、WebGL/WASM、数据库锁与主工作台 AI API。
5. 配置 Developer ID Application 证书、Hardened Runtime、最小 entitlement、Apple 公证和 stapling。未签名构建只能作为开发测试包，不能作为面向普通用户的正式下载。

macOS 最终产物必须在 macOS 环境构建和签名。推荐建立独立的 macOS CI 作业并从 GitHub Secrets 注入证书与公证凭据；这些凭据不能写入仓库。完成上述运行时和工具链工作前，不启用自动发布，避免 CI 产生无法启动的附件。
