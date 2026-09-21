"use strict";

const path = require("node:path");

const EXAMPLE_CATALOG = Object.freeze([
  Object.freeze({
    id: "inventory",
    roomId: "cn.zhibian.example.inventory",
    name: "物资台账",
    icon: "资",
    description: "登记库存、读取文本、导出 CSV，并可让 AI 分析需要关注的物资。",
    capabilities: Object.freeze(["私有数据库", "文件读写", "AI 分析"]),
    packageName: "inventory.room"
  }),
  Object.freeze({
    id: "browser",
    roomId: "cn.zhibian.example.browser",
    name: "千万间浏览器",
    icon: "览",
    description: "像普通浏览器一样使用多标签、地址搜索、收藏、历史和下载，并由工作台隔离网页与管理权限。",
    capabilities: Object.freeze(["任意网站浏览", "多标签", "收藏与历史", "受控下载"]),
    packageName: "browser.room"
  }),
  Object.freeze({
    id: "meeting-actions",
    roomId: "cn.zhibian.example.meeting-actions",
    name: "会议行动项",
    icon: "会",
    description: "把会议决定落实到负责人和截止日期，筛选进度并生成 AI 简报。",
    capabilities: Object.freeze(["私有数据库", "导出 CSV", "AI 简报"]),
    packageName: "meeting-actions.room"
  }),
  Object.freeze({
    id: "ai-debate",
    roomId: "cn.zhibian.example.ai-debate",
    name: "AI 辩论场",
    icon: "辩",
    description: "从主工作台选择正方、反方和裁判模型，支持 AI/人类混合辩论、评分与记录导出。",
    capabilities: Object.freeze(["主工作台多模型", "AI / 人类辩手", "裁判评分", "历史记录"]),
    packageName: "ai-debate.room"
  }),
  Object.freeze({
    id: "ai-model-benchmark",
    roomId: "cn.zhibian.example.ai-model-benchmark",
    name: "AI模型能力测试",
    icon: "测",
    description: "用贴合房间生成 Harness 的聊天与图片题集评测工作台模型，并在私有数据库中生成可筛选排行榜。",
    capabilities: Object.freeze(["主工作台多模型", "聊天能力评测", "图片识别评测", "数据库排行榜"]),
    packageName: "ai-model-benchmark.room"
  }),
  Object.freeze({
    id: "offline-3d-collector",
    roomId: "cn.zhibian.example.offline-3d-collector",
    name: "离线 3D 晶体挑战",
    icon: "游",
    description: "使用内置 Three.js、Rapier 和程序化素材运行的完整离线 3D 收集游戏。",
    capabilities: Object.freeze(["3D 渲染", "物理碰撞", "键盘与触屏", "程序化音效"]),
    packageName: "offline-3d-collector.room",
    template: "game3d"
  }),
  Object.freeze({
    id: "document-workbench",
    roomId: "cn.zhibian.example.document-workbench",
    name: "文档浏览与转换",
    icon: "文",
    description: "离线浏览 Markdown、Word、Excel、PPTX 和 PDF，并在 Markdown、Word、PDF 之间转换。",
    capabilities: Object.freeze(["多格式浏览", "Markdown / Word / PDF 转换", "离线处理", "中文 PDF 导出"]),
    packageName: "document-workbench.room"
  })
]);

function publicExample(example) {
  const { packageName: _packageName, template: _template, ...result } = example;
  return { ...result, capabilities: [...example.capabilities] };
}

function resolveExamplePackages({ isPackaged, resourcesPath, appPath }) {
  const packageRoot = isPackaged
    ? path.join(resourcesPath, "examples")
    : path.join(appPath, "resources", "examples");
  return EXAMPLE_CATALOG.map((example) => ({
    ...publicExample(example),
    packagePath: path.join(packageRoot, example.packageName)
  }));
}

module.exports = { EXAMPLE_CATALOG, publicExample, resolveExamplePackages };
