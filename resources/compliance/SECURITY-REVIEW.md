# 官方房间模块安全审查记录

审查日期：2026-09-05

审查命令：npm audit --registry=https://registry.npmjs.org --json

## 结果摘要

- 严重：0
- 高危：2 个 npm 报告节点（PptxGenJS 及其 image-size 原因节点）
- 中危：2 个 npm 报告节点（ExcelJS 及其 uuid 原因节点）
- 低危：0

npm 会同时报告根包和原因依赖，因此这里实际对应两项公告路径，不是四项独立漏洞。

## 本轮新增模块审查

- P0、P1、P2 新增的 12 个官方模块均为固定版本纯 Web 资源，不执行安装脚本，也不在房间运行时下载依赖。
- 初选 Quill 2.0.3 时，npm audit 命中一项适用于该版本的低危 XSS 公告；本轮改为固定 Quill 2.0.2 后该公告消失，最终审计仍只有下述两条历史路径。
- Mermaid 的间接依赖 khroma 2.1.0 在 package.json 中漏写 license 字段，但 npm 包自带完整 MIT license 文件。合规构建对该证据文件执行固定 SHA-256 校验，哈希不一致会直接失败。
- ECharts 与 mathjs 的上游 NOTICE 文件随对应离线模块一起分发。

## ExcelJS → uuid

- 固定版本：ExcelJS 4.4.0 → uuid 8.3.2。
- 公告：GHSA-w5hq-g745-h8pq。
- 公告影响：uuid v3/v5/v6 在调用者传入缓冲区时缺少边界检查。
- 实际调用：ExcelJS 源码只在条件格式扩展中导入 uuidv4，不调用 v3/v5/v6，也不向房间暴露 uuid API。
- 分发状态：ExcelJS 官方预构建浏览器文件仍包含 uuid 内部代码，因此不能简单标记为“不在产物中”。
- 当前处置：开发版接受中危残余风险；保持 ExcelJS 只用于受控的工作簿生成/读取，不向房间暴露底层 uuid；v1.0 前重新检查 ExcelJS 新版本，若上游仍未修复则评估可复现的安全重打包或替代库。

## PptxGenJS → image-size

- 固定版本：PptxGenJS 4.0.1 → image-size 1.2.1。
- 公告：GHSA-w3rx-r6r6-pgpr、GHSA-5p2g-fcmc-qvqq。
- 公告影响：image-size 的部分 ICNS/JXL/HEIF 解析路径可因恶意输入进入无限循环。
- 浏览器构建事实：PptxGenJS package.json 的 browser 映射把 image-size 设置为 false；工作台分发的是 dist/pptxgen.min.js，而不是 Node 入口。
- 产物检查：最终房间资源中不存在 image-size 包标识和 ICNS/HEIF 解析器；断网 Electron 生成 PPTX 已通过。
- 当前处置：判定该高危公告不适用于最终浏览器资源，但保留在完整来源 SBOM 中，避免隐藏构建来源风险；每次升级 PptxGenJS 后重新验证 browser 映射与最终产物。

## 发行门槛

1. 每次更新 package-lock.json 后重新执行官方 npm registry 审计。
2. 严重漏洞不得带入发行候选版。
3. 高危漏洞必须证明代码不在最终资源或完成升级/替换。
4. 中危残余风险必须有调用路径分析、隔离措施和负责人接受记录。
5. 正式 v1.0 发布前由安全团队复核本文件；本记录不等同于第三方安全认证。
