"use strict";

const ROOM_MODULE_CATALOG = Object.freeze([
  {
    id: "data.date@1",
    name: "日期与时间",
    description: "日期解析、格式化和计算",
    packageName: "dayjs",
    packageVersion: "1.11.23",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dayjs.min.js", publicName: "dayjs.min.js", type: "script", global: "dayjs" }]
  },
  {
    id: "data.decimal@1",
    name: "精确小数",
    description: "金额、费率和统计值的精确十进制运算",
    packageName: "decimal.js",
    packageVersion: "10.6.0",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENCE.md",
    requires: [],
    assets: [{ source: "decimal.js", publicName: "decimal.js", type: "script", global: "Decimal" }]
  },
  {
    id: "data.csv@1",
    name: "CSV 数据",
    description: "CSV 解析与导出，适合电子表格交换",
    packageName: "papaparse",
    packageVersion: "5.7.0",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "papaparse.min.js", publicName: "papaparse.min.js", type: "script", global: "Papa" }]
  },
  {
    id: "data.search@1",
    name: "模糊搜索",
    description: "面向本地记录的轻量模糊检索",
    packageName: "fuse.js",
    packageVersion: "7.5.0",
    declaredLicense: "Apache-2.0",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/fuse.min.mjs", publicName: "fuse.min.mjs", type: "module", export: "default" }]
  },
  {
    id: "ui.chart@1",
    name: "图表",
    description: "柱状图、折线图等常用可视化",
    packageName: "chart.js",
    packageVersion: "4.5.1",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE.md",
    requires: [],
    assets: [{ source: "dist/chart.umd.js", publicName: "chart.umd.js", type: "script", global: "Chart" }]
  },
  {
    id: "security.sanitize@1",
    name: "安全 HTML",
    description: "清理不可信 HTML，阻止脚本和危险标签",
    packageName: "dompurify",
    packageVersion: "3.4.14",
    declaredLicense: "(MPL-2.0 OR Apache-2.0)",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/purify.min.js", publicName: "purify.min.js", type: "script", global: "DOMPurify" }]
  },
  {
    id: "document.markdown@1",
    name: "Markdown",
    description: "Markdown 解析与安全预览",
    packageName: "marked",
    packageVersion: "18.0.11",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: ["security.sanitize@1"],
    assets: [{ source: "lib/marked.umd.js", publicName: "marked.umd.js", type: "script", global: "marked" }]
  },
  {
    id: "archive.zip@1",
    name: "ZIP 压缩",
    description: "为 Word、PPT 和通用归档提供离线 ZIP 读写",
    packageName: "jszip",
    packageVersion: "3.10.1",
    declaredLicense: "(MIT OR GPL-3.0-or-later)",
    selectedLicense: "MIT",
    licenseSource: "LICENSE.markdown",
    requires: [],
    assets: [{ source: "dist/jszip.min.js", publicName: "jszip.min.js", type: "script", global: "JSZip" }]
  },
  {
    id: "font.cjk@1",
    name: "简体中文文档字体",
    description: "PDF 等办公文档使用的完整思源黑体简体中文字体",
    packageName: "noto-cjk",
    packageVersion: "2.004",
    declaredLicense: "OFL-1.1",
    selectedLicense: "OFL-1.1",
    licenseSource: "LICENSE",
    sourceKind: "vendor",
    sourceRoot: "vendor/noto-cjk",
    metadataFile: "metadata.json",
    selectable: false,
    requires: [],
    assets: [{ source: "NotoSansCJKsc-Regular.otf", publicName: "NotoSansCJKsc-Regular.otf", type: "font" }]
  },
  {
    id: "document.pdf.view@1",
    name: "PDF 阅读与预览",
    description: "离线解析、渲染、检索和预览 PDF",
    packageName: "pdfjs-dist",
    packageVersion: "6.3.289",
    declaredLicense: "Apache-2.0",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    requires: [],
    assets: [
      { source: "build/pdf.min.mjs", publicName: "pdf.min.mjs", type: "module", export: "*" },
      { source: "build/pdf.worker.min.mjs", publicName: "pdf.worker.min.mjs", type: "module-worker" },
      { source: "cmaps", publicName: "cmaps", type: "resource", directory: true },
      { source: "standard_fonts", publicName: "standard_fonts", type: "resource", directory: true },
      { source: "wasm", publicName: "wasm", type: "resource", directory: true }
    ]
  },
  {
    id: "document.pdf.fontkit@1",
    name: "PDF 字体引擎",
    description: "为 PDF 写入提供自定义中文字体嵌入",
    packageName: "@pdf-lib/fontkit",
    packageVersion: "1.1.1",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    // Upstream npm package omits its full license. Do not borrow pdf-lib's copyright.
    licenseSource: "README.md",
    licenseEvidenceOnly: true,
    selectable: false,
    requires: [],
    assets: [{ source: "dist/fontkit.umd.min.js", publicName: "fontkit.umd.min.js", type: "script", global: "fontkit" }]
  },
  {
    id: "document.pdf.compose@1",
    name: "PDF 创建与编辑",
    description: "创建、合并、拆分、填写和修改 PDF，并支持中文字体",
    packageName: "pdf-lib",
    packageVersion: "1.17.1",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE.md",
    requires: ["font.cjk@1", "document.pdf.fontkit@1"],
    assets: [{ source: "dist/pdf-lib.min.js", publicName: "pdf-lib.min.js", type: "script", global: "PDFLib" }]
  },
  {
    id: "document.pdf.report@1",
    name: "PDF 报告",
    description: "从房间数据生成排版式 PDF 报告",
    packageName: "jspdf",
    packageVersion: "4.2.1",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: ["font.cjk@1"],
    assets: [{ source: "dist/jspdf.umd.min.js", publicName: "jspdf.umd.min.js", type: "script", global: "jspdf" }]
  },
  {
    id: "document.pdf.table@1",
    name: "PDF 表格报告",
    description: "在 PDF 报告中生成分页表格",
    packageName: "jspdf-autotable",
    packageVersion: "5.0.8",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE.txt",
    requires: ["document.pdf.report@1"],
    assets: [{ source: "dist/jspdf.plugin.autotable.min.js", publicName: "jspdf.plugin.autotable.min.js", type: "script", global: "autoTable" }]
  },
  {
    id: "document.spreadsheet@1",
    name: "电子表格",
    description: "Excel/XLSX/XLS/CSV 等表格的通用导入、处理与导出",
    packageName: "xlsx",
    packageVersion: "0.20.3",
    declaredLicense: "Apache-2.0",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/xlsx.full.min.js", publicName: "xlsx.full.min.js", type: "script", global: "XLSX" }]
  },
  {
    id: "document.spreadsheet.rich@1",
    name: "高级 Excel 报表",
    description: "带样式、图片、合并单元格、数据验证和打印设置的 XLSX 报表",
    packageName: "exceljs",
    packageVersion: "4.4.0",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/exceljs.min.js", publicName: "exceljs.min.js", type: "script", global: "ExcelJS" }]
  },
  {
    id: "document.word.write@1",
    name: "Word 文档生成",
    description: "离线生成带段落、表格、图片和样式的 DOCX 文档",
    packageName: "docx",
    packageVersion: "9.7.1",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/index.iife.js", publicName: "docx.iife.js", type: "script", global: "docx" }]
  },
  {
    id: "document.word.read@1",
    name: "Word 内容提取",
    description: "从 DOCX 提取文本和结构化 HTML，并进行安全清理",
    packageName: "mammoth",
    packageVersion: "1.12.2",
    declaredLicense: "BSD-2-Clause",
    selectedLicense: "BSD-2-Clause",
    licenseSource: "LICENSE",
    requires: ["security.sanitize@1"],
    assets: [{ source: "mammoth.browser.min.js", publicName: "mammoth.browser.min.js", type: "script", global: "mammoth" }]
  },
  {
    id: "document.word.preview@1",
    name: "Word 原样预览",
    description: "在房间内按接近 Word 的版式预览 DOCX",
    packageName: "docx-preview",
    packageVersion: "0.4.0",
    declaredLicense: "Apache-2.0",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    requires: ["archive.zip@1", "security.sanitize@1"],
    assets: [{
      source: "dist/docx-preview.min.js",
      publicName: "docx-preview.min.js",
      type: "script",
      global: "docxPreview",
      wrapGlobal: { capture: "docx", expose: "docxPreview" }
    }]
  },
  {
    id: "document.presentation.write@1",
    name: "PowerPoint 生成",
    description: "离线生成带文字、表格、图表和图片的 PPTX",
    packageName: "pptxgenjs",
    packageVersion: "4.0.1",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: ["archive.zip@1"],
    assets: [{ source: "dist/pptxgen.min.js", publicName: "pptxgen.min.js", type: "script", global: "PptxGenJS" }]
  },
  {
    id: "media.html-image@1",
    name: "页面转图片",
    description: "把房间中的报表、卡片和图表导出为 PNG/JPEG/SVG",
    packageName: "html-to-image",
    packageVersion: "1.11.13",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{
      source: "es/index.js",
      publicName: "html-to-image.min.js",
      type: "script",
      global: "htmlToImage",
      bundle: { globalName: "htmlToImage" }
    }]
  },
  {
    id: "utility.qrcode@1",
    name: "二维码",
    description: "离线生成二维码图片和 Data URL",
    packageName: "qrcode",
    packageVersion: "1.5.4",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "license",
    requires: [],
    assets: [{
      source: "lib/browser.js",
      publicName: "qrcode.min.js",
      type: "script",
      global: "QRCode",
      bundle: { globalName: "QRCode" }
    }]
  },
  {
    id: "ui.datagrid@1",
    name: "高级数据表格",
    description: "可编辑、排序、筛选、分页、分组和虚拟滚动的数据表格",
    packageName: "tabulator-tables",
    packageVersion: "6.5.2",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [
      { source: "dist/css/tabulator.min.css", publicName: "tabulator.min.css", type: "style" },
      { source: "dist/js/tabulator.min.js", publicName: "tabulator.min.js", type: "script", global: "Tabulator" }
    ]
  },
  {
    id: "ui.sortable@1",
    name: "拖拽排序",
    description: "列表、看板和卡片在桌面与触屏上的拖拽排序",
    packageName: "sortablejs",
    packageVersion: "1.15.7",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "Sortable.min.js", publicName: "sortable.min.js", type: "script", global: "Sortable" }]
  },
  {
    id: "diagram.mermaid@1",
    name: "Mermaid 图表",
    description: "离线生成流程图、时序图、甘特图、状态图和思维导图",
    packageName: "mermaid",
    packageVersion: "11.17.2",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: ["security.sanitize@1"],
    assets: [{ source: "dist/mermaid.min.js", publicName: "mermaid.min.js", type: "script", global: "mermaid" }]
  },
  {
    id: "ui.chart.advanced@1",
    name: "高级数据可视化",
    description: "复杂仪表盘、热力图、雷达图、桑基图、树图和组合图表",
    packageName: "echarts",
    packageVersion: "6.1.0",
    declaredLicense: "Apache-2.0",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    noticeSource: "NOTICE",
    requires: [],
    assets: [{ source: "dist/echarts.min.js", publicName: "echarts.min.js", type: "script", global: "echarts" }]
  },
  {
    id: "editor.richtext@1",
    name: "富文本编辑器",
    description: "带工具栏的所见即所得富文本编辑和 Delta 数据处理",
    packageName: "quill",
    packageVersion: "2.0.2",
    declaredLicense: "BSD-3-Clause",
    selectedLicense: "BSD-3-Clause",
    licenseSource: "LICENSE",
    requires: ["security.sanitize@1"],
    assets: [
      { source: "dist/quill.snow.css", publicName: "quill.snow.css", type: "style" },
      { source: "dist/quill.js", publicName: "quill.js", type: "script", global: "Quill" }
    ]
  },
  {
    id: "map.leaflet@1",
    name: "离线地图",
    description: "地图坐标、标记、矢量图层和本地瓦片展示",
    packageName: "leaflet",
    packageVersion: "1.9.4",
    declaredLicense: "BSD-2-Clause",
    selectedLicense: "BSD-2-Clause",
    licenseSource: "LICENSE",
    requires: [],
    assets: [
      { source: "dist/leaflet.css", publicName: "leaflet.css", type: "style" },
      { source: "dist/leaflet.js", publicName: "leaflet.js", type: "script", global: "L" },
      { source: "dist/images", publicName: "images", type: "resource", directory: true }
    ]
  },
  {
    id: "math.general@1",
    name: "通用数学计算",
    description: "矩阵、复数、单位换算、表达式和高级数学函数",
    packageName: "mathjs",
    packageVersion: "15.2.0",
    declaredLicense: "Apache-2.0",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    noticeSource: "NOTICE",
    requires: [],
    assets: [{ source: "lib/browser/math.js", publicName: "math.js", type: "script", global: "math" }]
  },
  {
    id: "stats.simple@1",
    name: "统计分析",
    description: "均值、中位数、分位数、标准差、回归、相关性和分类统计",
    packageName: "simple-statistics",
    packageVersion: "7.11.0",
    declaredLicense: "ISC",
    selectedLicense: "ISC",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/simple-statistics.min.js", publicName: "simple-statistics.min.js", type: "script", global: "ss" }]
  },
  {
    id: "media.cropper@1",
    name: "图片裁剪",
    description: "本地图片裁剪、缩放、旋转和选区处理",
    packageName: "cropperjs",
    packageVersion: "2.2.0",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/cropper.min.js", publicName: "cropper.min.js", type: "script", global: "Cropper", globalProperty: "default" }]
  },
  {
    id: "graphics.canvas@1",
    name: "交互式 Canvas",
    description: "白板、图片标注、图形编辑、拖拽缩放和二维画布交互",
    packageName: "konva",
    packageVersion: "10.3.3",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "konva.min.js", publicName: "konva.min.js", type: "script", global: "Konva" }]
  },
  {
    id: "visualization.d3@1",
    name: "D3 自定义可视化",
    description: "自定义 SVG、层次结构、力导向布局、地理投影和数据动画",
    packageName: "d3",
    packageVersion: "7.9.0",
    declaredLicense: "ISC",
    selectedLicense: "ISC",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/d3.min.js", publicName: "d3.min.js", type: "script", global: "d3" }]
  },
  {
    id: "visualization.graph@1",
    name: "关系网络图",
    description: "关系网络、知识图谱、拓扑图和节点边交互分析",
    packageName: "cytoscape",
    packageVersion: "3.34.2",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{ source: "dist/cytoscape.min.js", publicName: "cytoscape.min.js", type: "script", global: "cytoscape" }]
  },
  {
    id: "graphics.three@1",
    name: "Three.js 3D 渲染",
    description: "离线 WebGL 3D 场景、相机、光照、材质和动画",
    packageName: "three",
    packageVersion: "0.185.1",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{
      source: "build/three.module.min.js",
      publicName: "three.min.js",
      type: "script",
      global: "THREE",
      bundle: { globalName: "THREE" }
    }]
  },
  {
    id: "physics.rapier@1",
    name: "Rapier 3D 物理",
    description: "离线 WASM 刚体、碰撞、重力和角色运动",
    packageName: "@dimforge/rapier3d-compat",
    packageVersion: "0.20.0",
    declaredLicense: "Apache-2.0",
    selectedLicense: "Apache-2.0",
    licenseSource: "LICENSE",
    requires: [],
    assets: [{
      source: "dist/rapier.mjs",
      publicName: "rapier.min.js",
      type: "script",
      global: "RAPIER",
      bundle: { globalName: "RAPIER" }
    }]
  },
  {
    id: "game.input@1",
    name: "游戏输入",
    description: "键盘、方向键与触屏虚拟按键的统一离线输入",
    packageName: "@zhibian/game-input",
    packageVersion: "1.0.0",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    sourceKind: "vendor",
    sourceRoot: "vendor/zhibian-game",
    metadataFile: "metadata-input.json",
    requires: [],
    assets: [{ source: "input.js", publicName: "input.js", type: "script", global: "ZhibianInput" }]
  },
  {
    id: "game.audio@1",
    name: "游戏音效",
    description: "无需素材文件的 Web Audio 程序化提示音",
    packageName: "@zhibian/game-audio",
    packageVersion: "1.0.0",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    sourceKind: "vendor",
    sourceRoot: "vendor/zhibian-game",
    metadataFile: "metadata-audio.json",
    requires: [],
    assets: [{ source: "audio.js", publicName: "audio.js", type: "script", global: "ZhibianAudio" }]
  },
  {
    id: "game.assets@1",
    name: "程序化 3D 素材",
    description: "离线生成角色、障碍、收集物和基础材质，不依赖外部素材站",
    packageName: "@zhibian/game-assets",
    packageVersion: "1.0.0",
    declaredLicense: "MIT",
    selectedLicense: "MIT",
    licenseSource: "LICENSE",
    sourceKind: "vendor",
    sourceRoot: "vendor/zhibian-game",
    metadataFile: "metadata-assets.json",
    requires: ["graphics.three@1"],
    assets: [{ source: "assets.js", publicName: "assets.js", type: "script", global: "ZhibianGameAssets" }]
  }
].map((module) => Object.freeze({
  ...module,
  requires: Object.freeze([...module.requires]),
  assets: Object.freeze(module.assets.map((asset) => Object.freeze({
    ...asset,
    ...(asset.bundle ? { bundle: Object.freeze({ ...asset.bundle }) } : {}),
    ...(asset.wrapGlobal ? { wrapGlobal: Object.freeze({ ...asset.wrapGlobal }) } : {})
  })))
})));

const MODULE_BY_ID = new Map(ROOM_MODULE_CATALOG.map((module) => [module.id, module]));

function getRoomModule(moduleId) {
  return MODULE_BY_ID.get(moduleId) ?? null;
}

function expandHostModules(moduleIds = []) {
  const selected = new Set();
  const visit = (moduleId) => {
    const module = getRoomModule(moduleId);
    if (!module) throw new Error(`不支持的宿主模块：${moduleId}`);
    if (selected.has(moduleId)) return;
    for (const dependency of module.requires) visit(dependency);
    selected.add(moduleId);
  };
  for (const moduleId of moduleIds) visit(moduleId);
  return ROOM_MODULE_CATALOG.filter((module) => selected.has(module.id)).map((module) => module.id);
}

function getPublicRoomModuleCatalog() {
  return ROOM_MODULE_CATALOG.map((module) => ({
    id: module.id,
    name: module.name,
    description: module.description,
    version: module.packageVersion,
    license: module.selectedLicense,
    selectable: module.selectable !== false,
    requires: [...module.requires],
    globals: module.assets.flatMap((asset) => asset.global ? [asset.global] : [])
  }));
}

function getSelectableRoomModuleCatalog() {
  return ROOM_MODULE_CATALOG.filter((module) => module.selectable !== false);
}

function recommendRoomModules(requirements) {
  const text = String(requirements || "")
    .replace(/(?:不需要|不要|无需|取消|移除|删除|去掉)[^，。；;\n]*/g, " ");
  const selected = new Set();
  const select = (pattern, moduleId) => { if (pattern.test(text)) selected.add(moduleId); };
  select(/(?:tabulator|data[ -]?grid|数据网格|高级表格|可编辑表格|分页表格|表格.*(?:行内编辑|冻结列|虚拟滚动|分组))/i, "ui.datagrid@1");
  select(/(?:sortable|拖拽排序|拖放排序|卡片拖拽|看板拖拽|拖拽看板|拖动调整顺序)/i, "ui.sortable@1");
  select(/(?:mermaid|流程图|时序图|序列图|甘特图|思维导图|状态图|架构图)/i, "diagram.mermaid@1");
  select(/(?:echarts|热力图|雷达图|桑基图|树图|旭日图|漏斗图|仪表盘图|复杂组合图)/i, "ui.chart.advanced@1");
  select(/(?:quill|富文本(?:编辑)?|所见即所得|wysiwyg|文字格式工具栏)/i, "editor.richtext@1");
  select(/(?:leaflet|gis|地图|地理坐标|经纬度|园区点位|设备点位|轨迹回放)/i, "map.leaflet@1");
  select(/(?:mathjs|科学计算|矩阵|复数|单位换算|方程求解|高级公式)/i, "math.general@1");
  select(/(?:simple-statistics|统计分析|均值|中位数|分位数|标准差|(?:线性)?回归|相关系数|相关性分析)/i, "stats.simple@1");
  select(/(?:cropper|图片裁剪|照片裁剪|图像裁切|图片旋转|头像裁剪)/i, "media.cropper@1");
  select(/(?:konva|交互式画布|图片标注|白板|二维画布编辑|canvas 编辑)/i, "graphics.canvas@1");
  select(/(?:d3(?:\.js)?|自定义 svg|数据驱动 svg|层次可视化|力导向布局)/i, "visualization.d3@1");
  select(/(?:cytoscape|知识图谱|关系网络|网络拓扑|节点边分析|拓扑图)/i, "visualization.graph@1");
  return expandHostModules([...selected]);
}

module.exports = {
  ROOM_MODULE_CATALOG,
  expandHostModules,
  getPublicRoomModuleCatalog,
  getSelectableRoomModuleCatalog,
  recommendRoomModules,
  getRoomModule
};
