# 第三方软件与资源声明

千万间 Roomillion原创代码采用 Apache-2.0；第三方组件不因此变更许可证。各组件版权归原作者或权利人所有，本项目不声称拥有这些组件的版权。

## 逐项声明与原文

- [第三方组件目录](resources/compliance/THIRD-PARTY-NOTICES.md)：核心运行依赖、39 个官方房间模块及工具链用途、版本与许可。
- [逐包许可原文索引](resources/compliance/THIRD-PARTY-LICENSES.md)：运行依赖及房间资源来源/传递依赖的原始 LICENSE、COPYING、NOTICE、版权文件及 SHA-256。
- [完整组件清单（SBOM）](resources/compliance/sbom.cdx.json)：构建所用依赖版本和来源，不代替许可证文本。
- [待核对事项](resources/compliance/LICENSE-REVIEW.md)：缺少独立许可原文、人工来源判断、工具链源码提供等事项。不得将清单存在解释为所有公开分发义务均已履行。

原文副本在 `resources/compliance/licenses/`。官方模块还保留各自目录中的 `LICENSE.txt`、适用的 `NOTICE.txt` 以及字体/WASM 子组件声明。发行包在 `resources/compliance/` 提供相同材料，不需要联网查看。

## 许可范围

- MIT、BSD、ISC 等组件：保留上游版权、许可和免责声明。
- Apache-2.0 组件：保留许可与适用的上游 NOTICE、版权和归属信息；修改上游代码时按条款标示修改。
- 双许可组件按官方模块目录记录的选择分发；原文可以保留完整双许可内容，保留原文不代表将项目改为另一许可证。
- Noto CJK 等字体适用 OFL 等各自许可；PDF.js 随带的字体、CMap 与 WASM 库分别保留其原始声明。
- `vendor/zhibian-game` 中已有明确 MIT 声明的本项目模块继续采用 MIT；不以根目录 Apache-2.0 覆盖。
- Electron 本体采用 MIT，Chromium 与其组件许可见 Electron 发行目录的 `LICENSE.electron.txt`、`LICENSES.chromium.html`（不同平台名称可能不同）。
- Git/MinGit 以 GPL-2.0 等实际组件许可为准，随带组件可能适用不同条款。本项目通过独立进程调用 Git，不重新授权 Git、DLL 或工具链。二进制公开分发前，必须落实适用的完整对应源码提供方式；单纯列出下载链接或 SBOM 不代表已履行此义务。
- 用户数据、密钥、导入的房间和用户生成内容，不因安装或使用本工作台而自动采用 Apache-2.0。房间携带额外依赖时，其分发者也应保留对应许可证。

## 维护方式

安装锁定依赖后执行 `npm run build:compliance`，重新生成目录、原文副本索引和缺失材料报告。该步骤读取本地依赖，不在线猜测或生成第三方作者的版权声明。

以上是对材料位置与分发范围的说明，不修改任何许可证条款，也不代替针对最终发行物的法律合规复核。
