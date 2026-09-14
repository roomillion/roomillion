# Apache-2.0 许可与第三方声明落地

日期：2026-09-09。用户已明确选择 Apache-2.0。本记录承接第 40 号文档，原来“等待选择根 LICENSE”的事项已完成。

## 已完成

- 根目录 `LICENSE`：Apache-2.0 标准完整文本，原文来源规范见 https://www.apache.org/licenses/LICENSE-2.0.txt 。附录中的方括号是标准文本的示例，不是遗漏的项目署名。
- 根目录 `NOTICE`：沿用现有项目署名，写明“Copyright 2026 千万间 Roomillion 项目及贡献者”；该名称不暗示注册法人身份。项目所有者如需使用个人或公司法定名称，可随后调整署名。
- 根目录 `THIRD-PARTY-NOTICES.md`：主项目、第三方、字体、工具链、独立许可模块与用户内容的许可范围。
- `package.json`、锁文件根记录、SBOM 应用记录均标为 `Apache-2.0`。没有重写第三方包或原有 MIT 模块的许可证。
- Windows/Linux 打包白名单纳入根许可证文件；`resources/compliance/` 提供可在安装包外部直接阅读的副本和完整索引。
- `npm run build:compliance` 自动按锁定版本收集逐包许可、版权、NOTICE、上游作者/来源元数据与 SHA-256；原文按字节保留，Git 属性防止换行转换破坏证据哈希。清理旧文件只针对上次索引记录且哈希未被手工改变的生成副本。

## 第三方核对结果

当前逐包索引记录 414 个去重组件，包含运行依赖、官方房间资源来源/传递依赖及 Electron。另保留字体、WASM、工具链和 Electron/Chromium 的附加声明。939 份索引材料中也包含上游 package.json/README 归属证据，因此不应表述成“939 个完整许可证”。这是一份保守的构建来源清单，不等于每个包都完整进入发行物。

Pi 0.84.3 原 npm 包没有附完整许可，本次从对应上游标签补回 MIT 原文（Mario Zechner 的版权声明）；saxes 5.0.1 和 Canvas 1.0.8 同样补回固定标签原文。来源和哈希固定在 `scripts/license-evidence/sources.json`，后续构建不依赖联网。6 个包的完整 MIT 文本实际位于 README，已经人工识别并固定文件哈希，而不是仅看到“MIT”三个字便认定完整。

发现并纠正 `@pdf-lib/fontkit` 借用 `pdf-lib/LICENSE.md` 的旧配置。它现在仅保留自己的 README 作为 `LICENSE-EVIDENCE.md`，附明确的待核对 NOTICE；没有虚构许可原文，也没有删除运行功能。

## 还不能宣称全部分发义务已完成

目前 10 个来源包仍缺少已确认的完整许可原文：3 个 AWS SDK 内部包、fontkit、binary、buffers、chainsaw、dingbat-to-unicode、https、javascript-natural-sort。逐项版本及现有证据见 `resources/compliance/LICENSE-REVIEW.md`。下一步需要联系发布者、取得对应源码版本的许可，或确认最终发行物不包含相关代码；不能直接拿同类型许可证或相邻包的版权行替代。

MinGit/Git 对应源码与随带组件分发材料仍需落实；Canvas 原生模块引用 Skia/ICU 等组件时，也要按最终打包范围核对附加声明。当前不是法律认证或已满足所有源码交付义务的承诺。

## 验证与使用

本次新增测试检查：主项目许可与打包白名单、逐包索引覆盖、原文逐字节一致性与哈希、固定上游证据、缺失材料明确报告，以及 fontkit 不再使用无关版权文件。

验证结果：151/151 项回归通过，`git diff --check` 通过。移除的是 fontkit 生成目录中误借用的许可副本，未删除功能代码；原跟踪文件仍可从 Git 历史恢复。

本轮不重新生成应用 ZIP、不递增应用版本、不上传 GitHub。原 alpha.26 ZIP 是历史产物，尚不包含本次材料。以后通过已有递增版本流程重新构建，才会将此次声明装入新的发行物。公开发布前应先处理待核对事项，再检查最终 ZIP 中的文件，而不只是检查源码目录。
