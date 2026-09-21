# 千万间 Roomillion 第三方组件说明

本文件对应千万间 Roomillion `0.3.0-alpha.55`。完整传递依赖清单见同目录 `sbom.cdx.json`；当前清单记录 111 个应用运行依赖组件、317 个官方房间资源来源及其传递组件，另记录 Electron 桌面运行时。模块源码包只在构建期使用，安装包携带的是下方经过哈希校验的离线浏览器资源。

主项目原创代码采用 Apache-2.0，见同目录 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。第三方组件仍适用各自许可证，其版权归原作者或权利人所有。逐包原始许可、版权及 NOTICE 副本见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)；文件哈希与元数据见 [license-inventory.json](license-inventory.json)。缺失原文及源码提供待办见 [LICENSE-REVIEW.md](LICENSE-REVIEW.md)。

## 工作台核心直接运行依赖

| 组件 | 固定版本 | 许可证 | 用途 |
|---|---:|---|---|
| `@earendil-works/pi-agent-core` | 0.85.1 | MIT | 有状态 Agent 工具循环、流式事件与会话编排 |
| `@earendil-works/pi-ai` | 0.85.1 | MIT | 多模型 Provider 与 AI 调用适配 |
| `iconv-lite` | 0.7.3 | MIT | 超长文本流式编码识别与解码 |
| `sql.js` | 1.14.2 | MIT | 每房间 SQLite 数据库 |
| `yauzl` | 3.4.0 | MIT | 安全读取 .room ZIP |
| `yazl` | 3.3.1 | MIT | 生成 .room ZIP |
| `Electron` | 44.0.0 | MIT | Windows/Linux 桌面外壳与沙箱渲染 |

## 官方房间模块目录

房间使用稳定能力 ID，不直接依赖 npm 包名。以下资源随安装包离线提供，只有在房间 `manifest.json` 中声明后才能加载；许可原文（或明确标记的待核对证据）及资源 SHA-256 位于 `resources/room-modules/`。fontkit 当前仅有上游 README 证据，不再借用 pdf-lib 的版权声明。

| 能力 ID | 内部实现 | 固定版本 | 许可证 | 用途 |
|---|---|---:|---|---|
| `data.date@1` | `dayjs` | 1.11.23 | MIT | 日期解析、格式化和计算 |
| `data.decimal@1` | `decimal.js` | 10.6.0 | MIT | 金额、费率和统计值的精确十进制运算 |
| `data.csv@1` | `papaparse` | 5.7.0 | MIT | CSV 解析与导出，适合电子表格交换 |
| `data.search@1` | `fuse.js` | 7.5.0 | Apache-2.0 | 面向本地记录的轻量模糊检索 |
| `ui.chart@1` | `chart.js` | 4.5.1 | MIT | 柱状图、折线图等常用可视化 |
| `security.sanitize@1` | `dompurify` | 3.4.14 | Apache-2.0（从 (MPL-2.0 OR Apache-2.0) 双许可中选择） | 清理不可信 HTML，阻止脚本和危险标签 |
| `document.markdown@1` | `marked` | 18.0.11 | MIT | Markdown 解析与安全预览 |
| `archive.zip@1` | `jszip` | 3.10.1 | MIT（从 (MIT OR GPL-3.0-or-later) 双许可中选择） | 为 Word、PPT 和通用归档提供离线 ZIP 读写 |
| `font.cjk@1` | `noto-cjk` | 2.004 | OFL-1.1 | PDF 等办公文档使用的完整思源黑体简体中文字体 |
| `document.pdf.view@1` | `pdfjs-dist` | 6.3.289 | Apache-2.0 | 离线解析、渲染、检索和预览 PDF |
| `document.pdf.fontkit@1` | `@pdf-lib/fontkit` | 1.1.1 | MIT（原文待核对，仅保留上游证据） | 为 PDF 写入提供自定义中文字体嵌入 |
| `document.pdf.compose@1` | `pdf-lib` | 1.17.1 | MIT | 创建、合并、拆分、填写和修改 PDF，并支持中文字体 |
| `document.pdf.report@1` | `jspdf` | 4.2.1 | MIT | 从房间数据生成排版式 PDF 报告 |
| `document.pdf.table@1` | `jspdf-autotable` | 5.0.8 | MIT | 在 PDF 报告中生成分页表格 |
| `document.spreadsheet@1` | `xlsx` | 0.20.3 | Apache-2.0 | Excel/XLSX/XLS/CSV 等表格的通用导入、处理与导出 |
| `document.spreadsheet.rich@1` | `exceljs` | 4.4.0 | MIT | 带样式、图片、合并单元格、数据验证和打印设置的 XLSX 报表 |
| `document.word.write@1` | `docx` | 9.7.1 | MIT | 离线生成带段落、表格、图片和样式的 DOCX 文档 |
| `document.word.read@1` | `mammoth` | 1.12.2 | BSD-2-Clause | 从 DOCX 提取文本和结构化 HTML，并进行安全清理 |
| `document.word.preview@1` | `docx-preview` | 0.4.0 | Apache-2.0 | 在房间内按接近 Word 的版式预览 DOCX |
| `document.presentation.write@1` | `pptxgenjs` | 4.0.1 | MIT | 离线生成带文字、表格、图表和图片的 PPTX |
| `media.html-image@1` | `html-to-image` | 1.11.13 | MIT | 把房间中的报表、卡片和图表导出为 PNG/JPEG/SVG |
| `utility.qrcode@1` | `qrcode` | 1.5.4 | MIT | 离线生成二维码图片和 Data URL |
| `ui.datagrid@1` | `tabulator-tables` | 6.5.2 | MIT | 可编辑、排序、筛选、分页、分组和虚拟滚动的数据表格 |
| `ui.sortable@1` | `sortablejs` | 1.15.7 | MIT | 列表、看板和卡片在桌面与触屏上的拖拽排序 |
| `diagram.mermaid@1` | `mermaid` | 11.17.2 | MIT | 离线生成流程图、时序图、甘特图、状态图和思维导图 |
| `ui.chart.advanced@1` | `echarts` | 6.1.0 | Apache-2.0 | 复杂仪表盘、热力图、雷达图、桑基图、树图和组合图表 |
| `editor.richtext@1` | `quill` | 2.0.2 | BSD-3-Clause | 带工具栏的所见即所得富文本编辑和 Delta 数据处理 |
| `map.leaflet@1` | `leaflet` | 1.9.4 | BSD-2-Clause | 地图坐标、标记、矢量图层和本地瓦片展示 |
| `math.general@1` | `mathjs` | 15.2.0 | Apache-2.0 | 矩阵、复数、单位换算、表达式和高级数学函数 |
| `stats.simple@1` | `simple-statistics` | 7.11.0 | ISC | 均值、中位数、分位数、标准差、回归、相关性和分类统计 |
| `media.cropper@1` | `cropperjs` | 2.2.0 | MIT | 本地图片裁剪、缩放、旋转和选区处理 |
| `graphics.canvas@1` | `konva` | 10.3.3 | MIT | 白板、图片标注、图形编辑、拖拽缩放和二维画布交互 |
| `visualization.d3@1` | `d3` | 7.9.0 | ISC | 自定义 SVG、层次结构、力导向布局、地理投影和数据动画 |
| `visualization.graph@1` | `cytoscape` | 3.34.2 | MIT | 关系网络、知识图谱、拓扑图和节点边交互分析 |
| `graphics.three@1` | `three` | 0.185.1 | MIT | 离线 WebGL 3D 场景、相机、光照、材质和动画 |
| `physics.rapier@1` | `@dimforge/rapier3d-compat` | 0.20.0 | Apache-2.0 | 离线 WASM 刚体、碰撞、重力和角色运动 |
| `game.input@1` | `@zhibian/game-input` | 1.0.0 | MIT | 键盘、方向键与触屏虚拟按键的统一离线输入 |
| `game.audio@1` | `@zhibian/game-audio` | 1.0.0 | MIT | 无需素材文件的 Web Audio 程序化提示音 |
| `game.assets@1` | `@zhibian/game-assets` | 1.0.0 | MIT | 离线生成角色、障碍、收集物和基础材质，不依赖外部素材站 |

## 人工许可证解析

- buffers@0.1.1：npm 压缩包发布年代较早，未包含许可证字段或单独文本；依据 Debian 对同一上游源码的审核记录，按 MIT 处理，证据地址为 https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/ 。该解析同时写入 SBOM 组件属性，正式公开发行前应由法务再次确认。
- khroma@2.1.0：`package.json` 漏写许可证字段，但 npm 包内的 `license` 文件是完整 MIT 文本；构建会校验该文件 SHA-256 为 `66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49`，防止证据被静默替换。

许可类型登记和文件哈希校验不是法律认证。原文收集不等于所有传递依赖的分发义务均已完成；正式公开发行前应依据逐包原文及待核对报告复核。

## 内置 Git 工具链

- Windows：Git for Windows MinGit `2.55.0.windows.3` x64；官方发行来源和 SHA-256 见 `toolchains/mingit-metadata.json`。
- Linux：发行时只打入针对目标 Linux x64 基线准备的便携 Git，并随附该工具链的元数据与许可证。
- Git 只由工作台结构化版本服务调用，不向房间暴露命令行，也不使用用户系统 Git、全局 Git 配置或 PATH。
