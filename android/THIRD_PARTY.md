# Android 工程第三方依赖

本表记录 Android 工程直接声明的固定版本。Gradle 与 Android SDK 的传递依赖仍需在正式分发前逐包生成完整许可清单；本表不是最终合规确认。

| 用途 | 依赖与版本 | 许可来源 |
| --- | --- | --- |
| 应用构建 | Android Gradle Plugin 8.13.2 | [Android Open Source Project Apache-2.0](https://source.android.com/docs/setup/about/licenses) |
| Kotlin 编译 | Kotlin Gradle Plugin 2.2.21 | [Kotlin Apache-2.0](https://github.com/JetBrains/kotlin/blob/master/license/README.md) |
| 受控房间 WebView | AndroidX WebKit 1.16.0 | [AndroidX Apache-2.0](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/LICENSE.txt) |
| 桌面加密房间包的 scrypt 解锁 | Bouncy Castle bcprov-jdk18on 1.86 | [Bouncy Castle License](https://www.bouncycastle.org/licence/) |
| 单元测试 | JUnit 4.13.2 | [JUnit EPL-1.0](https://github.com/junit-team/junit4/blob/main/LICENSE-junit.txt) |
| 设备测试 | AndroidX Test JUnit 1.3.0、Espresso Core 3.7.0 | [AndroidX Apache-2.0](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/LICENSE.txt) |

Gradle Wrapper 使用 Gradle 8.13，发行 ZIP 通过 `gradle-wrapper.properties` 中的 SHA-256 固定。

APK 中的 14 个离线 Room 模块来自工作台固定版本的官方模块目录；构建脚本把每个模块的原版 `LICENSE.txt` 与资源一起收入应用。PDF 阅读模块在安卓构建时使用同版本 `pdfjs-dist` 的 legacy 代码，由项目已有的 esbuild 转换为 Android 12 WebView 可解析的语法，并增加缺失 JavaScript API 的适配前缀；原许可文件保留。具体包名与版本以 [`room-module-catalog.cjs`](../src/main/room-module-catalog.cjs) 为准。

APK 的离线 AI 提供商与模型目录取自桌面锁定的 `@earendil-works/pi-ai` 0.87.1（MIT）；构建时筛选安卓已经接入的聊天补全协议。APK 携带已登记的原版 Pi 许可证 `assets/compliance/pi-ai-LICENSE.txt`，版本以根目录 `package.json` 的固定依赖为准。

AI 修改页面还打包 `@earendil-works/pi-agent-core` 0.87.1 的浏览器 JavaScript 运行时，与房间 WebView 分开。`scripts/android-stage-agent.cjs` 根据实际打包图收入全部九个包的原版许可和版本索引至 `assets/compliance/agent/`：Pi Agent、Pi AI、Pi telemetry、chord、typebox、partial-json、yaml、ignore、diff。前六项和 ignore 为 MIT，yaml 为 ISC，diff 为 BSD-3-Clause；完整版本以 APK 中 `index.json` 为准。构建遇到缺失许可会失败。APK 不包含 Node.js 运行时。
