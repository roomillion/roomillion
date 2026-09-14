# 办公文档模块与 ExcelJS 决策

> 实施日期：2026-08-31
>
> 状态：C 档办公增强已实现，并通过 Windows Electron 断网运行验收。

## 1. 当前结论

办公与通用能力层仍提供 22 个稳定能力 ID，其中 20 个可由 AI 直接选择，2 个是自动补齐的内部支撑能力。工作台另有 5 个 3D 游戏能力与 12 个 P0/P1/P2 扩展能力，当前总数为 39；分别见《23-离线3D游戏房间第一版》和《34-P0-P1-P2扩展模块实施记录》。

房间只在 hostModules 中记录能力 ID，不复制这些公共资源。模块源码包只在构建期使用；最终应用携带 resources/room-modules 中经过版本、许可证、大小和 SHA-256 校验的浏览器资源。

## 2. 本次新增的办公能力

| 能力 ID | 实现 | 主要用途 |
|---|---|---|
| archive.zip@1 | JSZip 3.10.1 | ZIP 读写，也是 Word 预览和 PPT 的共享依赖 |
| font.cjk@1 | Noto Sans CJK SC 2.004 | PDF 中文字体，OFL-1.1，内部自动依赖 |
| document.pdf.view@1 | PDF.js 6.3.289 | PDF 解析、渲染、搜索和预览 |
| document.pdf.fontkit@1 | @pdf-lib/fontkit 1.1.1 | PDF 自定义字体嵌入，内部自动依赖 |
| document.pdf.compose@1 | pdf-lib 1.17.1 | PDF 创建、合并、拆分、表单和修改 |
| document.pdf.report@1 | jsPDF 4.2.1 | 排版式 PDF 报告 |
| document.pdf.table@1 | jsPDF-AutoTable 5.0.8 | 分页 PDF 表格 |
| document.spreadsheet@1 | SheetJS 0.20.3 | XLSX/XLS/CSV 等通用导入、转换和导出 |
| document.spreadsheet.rich@1 | ExcelJS 4.4.0 | 样式、图片、合并单元格、验证和打印设置 |
| document.word.write@1 | docx 9.7.1 | 生成 DOCX |
| document.word.read@1 | Mammoth 1.12.2 | 提取 DOCX 文本和 HTML |
| document.word.preview@1 | docx-preview 0.4.0 | 接近 Word 版式的 DOCX 预览 |
| document.presentation.write@1 | PptxGenJS 4.0.1 | 生成 PPTX |
| media.html-image@1 | html-to-image 1.11.13 | 页面、卡片和图表转图片 |
| utility.qrcode@1 | qrcode 1.5.4 | 生成二维码 |

原有 7 个能力继续保留：日期、精确小数、CSV、模糊搜索、图表、安全 HTML 和 Markdown。

## 3. ExcelJS 还需要吗

需要，但不应把它当成 SheetJS 的替代品。

| 需求 | 默认选择 |
|---|---|
| 读取或导出普通 XLSX/XLS/CSV、表格与 JSON 互转 | SheetJS |
| 生成有样式的正式报表 | ExcelJS |
| 图片、合并单元格、数据验证、冻结窗格、页眉页脚、打印区域 | ExcelJS |
| 既要广泛格式兼容，又要输出复杂样式 | 同时使用 SheetJS 和 ExcelJS |

AI 的确定性兜底规则已按此分工实现：普通 Excel、XLSX、电子表格需求只选择 document.spreadsheet@1；只有同时出现样式、图片、合并单元格、验证、打印或模板等关键词时，才额外选择 document.spreadsheet.rich@1。

两者都不是完整的 Excel 公式计算引擎。它们可以保存公式或读取部分缓存结果，但不应承诺在工作台内重算任意 Excel 工作簿。

## 4. AI 自动选库

模型只能看到白名单中的用户能力，不能建议 npm install 或 CDN。模型返回后，本地规则会再次：

1. 删除不存在的能力 ID。
2. 根据日期、金额、Excel、PDF、Word、PPT、ZIP、图片和二维码关键词补齐能力。
3. 自动展开共享依赖，例如 PDF 中文写入会补齐 font.cjk@1 和 document.pdf.fontkit@1。
4. 普通 Excel 优先 SheetJS，复杂样式才启用 ExcelJS。
5. Markdown、Word HTML 提取和 Word 预览自动补齐安全 HTML 清理。

## 5. 二进制 Room SDK

办公文件不能用文本接口交付，因此 Room SDK 现已提供：

- room.files.pickBinary(options)：通过系统选择窗口读取最多 50 MB 的办公文件。
- room.files.exportBinary(name, data)：通过系统保存窗口导出 ArrayBuffer 或 Uint8Array，最多 50 MB。

它们复用 files.pick 和 files.export 权限。房间不能获得任意路径或文件夹权限，也不能静默读写文件。需要导入 PDF、Excel 或 Word 的 AI 房间会申请 pick；纯生成型房间只申请 export。AI 修改旧房间新增读取需求时只更新权限声明，不会静默授予新增权限。

结构化生成模板已经实际使用 SheetJS/ExcelJS：普通表格导出 XLSX，复杂报表导出带表头样式、冻结首行和列宽设置的 XLSX。

## 6. 验收证据

当前全项目自动测试为 79/79 通过。Electron 断网冒烟在 networkAttempts=0 的情况下实际完成：

- 39 个模块全部加载，其中本节 22 个办公与通用模块保持原有验收；
- SheetJS 生成 XLSX；
- ExcelJS 生成带样式 XLSX；
- pdf-lib + fontkit + 完整思源黑体生成中文 PDF；
- jsPDF-AutoTable 生成分页表格 PDF；
- docx 生成 DOCX，Mammoth 再读取出中文 HTML；
- PptxGenJS 生成 PPTX；
- JSZip 生成 ZIP；
- qrcode 生成 PNG Data URL；
- PDF.js 模块、CMap、WASM/字体资源路径可离线访问；
- Word 生成与预览两个全局对象互不覆盖；
- 二进制 Room SDK 在沙箱中存在。

## 7. 合规与安全边界

开源包仍然有著作权，不能表述为“没有版权问题”。当前选用 MIT、Apache-2.0、BSD-2-Clause 和 OFL-1.1 等允许分发的许可路径；JSZip 从双许可中选择 MIT，DOMPurify 选择 Apache-2.0。许可证原文、资源哈希、SBOM 和第三方声明随应用分发。

当前 SBOM 分开记录 99 个应用运行依赖组件和 317 个官方房间资源来源及其传递组件，避免为了构建模块而把整个 npm 源码树重复装进安装包。

npm 安全公告仍有两项需要跟踪：ExcelJS 预构建文件包含 uuid 8.3.2，但 ExcelJS 实际只调用不受该公告影响的 v4 路径；PptxGenJS 的 Node 依赖 image-size 有高危公告，但 package 的 browser 映射明确排除 image-size，最终分发的 pptxgen.min.js 不包含该 Node 解析器。详细审查见 resources/compliance/SECURITY-REVIEW.md。它们是开发版的已知残余风险，v1.0 冻结前必须重新审计并优先升级或替换。

## 8. 当前限制

- 完成的是库、共享加载、AI 选型、二进制文件桥和基础生成模板，不是完整 Office 编辑器。
- PDF.js 提供阅读能力，Word 预览只负责显示，PPT 当前以生成为主。
- 中文 PDF 已验证 pdf-lib 路径；使用 jsPDF 时，房间仍需显式加载并注册内置中文字体。
- Linux/UOS 需要在新资源层基础上重新构建发行物并做实机复验。
- 公开发行前仍需组织法务和安全团队复核许可证、字体分发义务、安全公告及商用场景。
