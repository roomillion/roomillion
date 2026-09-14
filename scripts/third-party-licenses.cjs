"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOM_MODULE_CATALOG } = require("../src/main/room-module-catalog.cjs");
const SUPPLEMENTAL_LICENSES = require("./license-evidence/sources.json");

const originalNotice = /^(?:licen[cs]e[s]?|copying|notice[s]?|copyright|authors)(?:[._-]|$)|^feel-free\.md$/i;
const legalText = /^(?:licen[cs]e[s]?|copying)(?:[._-]|$)/i;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const portablePath = value => value.split(path.sep).join("/");
const markdown = value => String(value ?? "").replace(/[\r\n|]/g, " ").replace(/</g, "&lt;");
const href = value => value.split("/").map(encodeURIComponent).join("/");

function inside(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("声明文件路径越界");
  return target;
}

async function noticeFiles(root, relative = "", { skipDist = false } = {}) {
  const files = [];
  for (const entry of (await fsp.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    // Never follow symlinks into a different dependency or the developer's machine.
    if (entry.isSymbolicLink()) continue;
    const item = path.join(relative, entry.name);
    if (entry.isDirectory() && !["node_modules", ".git", ".cache"].includes(entry.name) && !(skipDist && entry.name === "dist")) {
      files.push(...await noticeFiles(root, item, { skipDist }));
    } else if (entry.isFile() && originalNotice.test(entry.name)) files.push(item);
  }
  return files;
}

async function buildLicenseArchive({ projectRoot, outputRoot }) {
  let previous = null;
  try { previous = JSON.parse(await fsp.readFile(path.join(outputRoot, "license-inventory.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const sbom = JSON.parse(await fsp.readFile(path.join(outputRoot, "sbom.cdx.json"), "utf8"));
  const lock = JSON.parse(await fsp.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  const records = [], missing = [], distributions = [];
  const lockRoots = new Map();
  for (const [itemPath, item] of Object.entries(lock.packages)) {
    const name = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(itemPath)?.[1];
    if (!name || !item.version) continue;
    const ref = `${name}@${item.version}`;
    if (!lockRoots.has(ref) || itemPath.length < lockRoots.get(ref).length) lockRoots.set(ref, itemPath);
  }
  const copy = async (sourceRoot, relative, targetRelative) => {
    const bytes = await fsp.readFile(inside(sourceRoot, relative));
    const target = inside(outputRoot, targetRelative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes); // Preserve upstream bytes, not paraphrased license text.
    return { source: portablePath(path.relative(projectRoot, path.join(sourceRoot, relative))), path: portablePath(targetRelative), bytes: bytes.length, sha256: sha256(bytes) };
  };
  for (const component of sbom.components) {
    const ref = component["bom-ref"];
    const vendor = ROOM_MODULE_CATALOG.find(item => item.sourceKind === "vendor" && item.packageName === component.name && item.packageVersion === component.version);
    const sourceRelative = vendor?.sourceRoot ?? lockRoots.get(ref);
    if (!sourceRelative) throw new Error(`找不到 ${ref} 的本地许可证来源`);
    const sourceRoot = inside(projectRoot, sourceRelative);
    const destination = path.join("licenses", vendor ? "vendor" : "npm", ...component.name.split("/"), component.version);
    const files = await noticeFiles(sourceRoot, "", { skipDist: component.name === "electron" });
    const record = { component: ref, name: component.name, version: component.version, license: component.licenses.map(item => item.license?.id ?? item.expression).join(" AND "), selectedLicense: ROOM_MODULE_CATALOG.find(item => item.packageName === component.name)?.selectedLicense ?? null, sourceRoot: portablePath(sourceRelative), files: [], status: "original-files-collected" };
    for (const relative of files) record.files.push(await copy(sourceRoot, relative, path.join(destination, relative)));
    const supplemental = SUPPLEMENTAL_LICENSES[ref];
    if (supplemental) {
      const bytes = await fsp.readFile(inside(projectRoot, supplemental.file));
      if (sha256(bytes) !== supplemental.sha256) throw new Error(`${ref} 补充许可证证据哈希不匹配`);
      record.files.push(await copy(projectRoot, supplemental.file, path.join(destination, "upstream", path.basename(supplemental.file))));
      record.licenseEvidence = supplemental;
    }
    const packageFile = path.join(sourceRoot, "package.json");
    try {
      const metadata = JSON.parse(await fsp.readFile(packageFile, "utf8"));
      if (metadata.name !== component.name || metadata.version !== component.version) throw new Error(`${ref} 本地包版本不符`);
      record.attributionMetadata = { author: metadata.author ?? null, contributors: metadata.contributors ?? null, repository: metadata.repository ?? null, homepage: metadata.homepage ?? null };
      record.files.push(await copy(sourceRoot, "package.json", path.join(destination, "package.json")));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!supplemental && !files.some(item => legalText.test(path.basename(item)))) {
      record.status = "needs-original-license-review";
      // A README can contain attribution or license evidence, but is not assumed to be a complete license.
      for (const entry of await fsp.readdir(sourceRoot)) {
        if (/^readme(?:\.|$)/i.test(entry) && (await fsp.lstat(path.join(sourceRoot, entry))).isFile()) {
          record.files.push(await copy(sourceRoot, entry, path.join(destination, entry)));
        }
      }
      missing.push(ref);
    }
    records.push(record);
  }

  for (const name of ["mingit", "git-linux-x64"]) {
    const sourceRoot = path.join(projectRoot, "resources", "toolchains", name);
    try {
      const record = { component: `toolchain:${name}`, files: [] };
      for (const relative of await noticeFiles(sourceRoot)) record.files.push(await copy(sourceRoot, relative, path.join("licenses", "toolchains", name, relative)));
      distributions.push(record);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // PDF.js includes independently licensed fonts, CMaps and WASM components.
  const moduleRoot = path.join(projectRoot, "resources", "room-modules");
  const moduleRecord = { component: "official-room-resource-notices", files: [] };
  for (const relative of await noticeFiles(moduleRoot)) moduleRecord.files.push(await copy(moduleRoot, relative, path.join("licenses", "room-resources", relative)));
  distributions.push(moduleRecord);
  const electronRecord = { component: "electron-runtime", files: [] };
  for (const filename of ["LICENSE", "LICENSES.chromium.html"]) {
    electronRecord.files.push(await copy(path.join(projectRoot, "node_modules", "electron", "dist"), filename, path.join("licenses", "electron-runtime", filename)));
  }
  distributions.push(electronRecord);
  for (const filename of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"]) {
    if (filename === "THIRD-PARTY-NOTICES.md") {
      const projectNotice = await fsp.readFile(path.join(projectRoot, filename), "utf8");
      await fsp.writeFile(path.join(outputRoot, "PROJECT-THIRD-PARTY-NOTICES.md"), projectNotice.replaceAll("](resources/compliance/", "]("));
    } else await copy(projectRoot, filename, filename);
  }

  const inventory = { formatVersion: 1, projectVersion: sbom.metadata.component.version, projectLicense: "Apache-2.0", records, distributions, missingOriginalLicenseFiles: missing };
  const currentFiles = new Set([...records, ...distributions].flatMap(item => item.files.map(file => file.path)));
  for (const oldFile of [...(previous?.records ?? []), ...(previous?.distributions ?? [])].flatMap(item => item.files ?? [])) {
    if (currentFiles.has(oldFile.path)) continue;
    if (!oldFile.path.startsWith("licenses/")) throw new Error("旧许可索引包含不受管理的路径");
    const target = inside(path.join(outputRoot, "licenses"), oldFile.path.slice("licenses/".length));
    try {
      if (sha256(await fsp.readFile(target)) !== oldFile.sha256) throw new Error("旧声明已被手工修改，请先核对：" + oldFile.path);
      await fsp.unlink(target); // Only a previously indexed generated file, with ownership hash verified.
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await fsp.writeFile(path.join(outputRoot, "license-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  const links = files => files.map(file => `[${markdown(path.basename(file.path))}](${href(file.path)})`).join(" · ") || "未发现独立原文，见待核对报告";
  const rows = records.map(item => `| ${markdown(item.component)} | ${markdown(item.license)}${item.selectedLicense ? `；模块选择 ${markdown(item.selectedLicense)}` : ""} | ${links(item.files)} | ${item.status === "needs-original-license-review" ? "需核对原文" : "已收集原文（非法律认证）"} |`);
  const text = `# 第三方逐包许可证与版权原文\n\n对应工作台 ${inventory.projectVersion}。以下 ${records.length} 项包含应用运行依赖、官方资源来源与传递依赖及 Electron；这是保守的构建来源清单，不代表每个源码包都完整分发。各包原始版权/许可内容在链接文件内保留，不以统一版权行替代。作者与来源元数据、每份原文的 SHA-256 见 [license-inventory.json](license-inventory.json)。\n\n本索引中的“已收集”仅表示找到了原始文件，不证明条款完整性或所有法律义务均已履行。\n\n| 组件与版本 | 许可元数据 | 原文与归属材料 | 状态 |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n## 工具链、字体、WASM 及 Electron 运行时的附加声明\n\n${distributions.map(item => `### ${item.component}\n\n${item.files.map(file => `- [${markdown(file.source)}](${href(file.path)})`).join("\n") || "未发现材料；发行前需核对。"}`).join("\n\n")}\n\n## 分发范围\n\n本目录原文副本不修改各自许可证。Git 工具链对应源码提供、缺失原文等待核对事项见 [LICENSE-REVIEW.md](LICENSE-REVIEW.md)。主项目范围见 [NOTICE](NOTICE)；第三方包与单独许可的 vendor 模块不被改为 Apache-2.0。\n`;
  await fsp.writeFile(path.join(outputRoot, "THIRD-PARTY-LICENSES.md"), text);
  const review = `# 发布前许可证材料待核对事项\n\n工作台 ${inventory.projectVersion}；自动构建生成。主项目许可证已确定为 Apache-2.0，第三方许可保持原样。\n\n## 未发现独立 LICENSE/COPYING 文件的来源包\n\n${missing.length ? missing.map(ref => `- ${ref}：已保留能找到的 README/元数据，不把许可名称当作完整授权文本。需核对精确版本上游源码或其发布者许可。`).join("\n") : "当前索引均发现 LICENSE/COPYING 文件；仍需核对文件是否完整、署名与适用范围。"}\n\n## 仍需人工处理\n\n- buffers@0.1.1 目前的 MIT 元数据来自已有 Debian 人工来源记录，不代表已取得完整上游许可原文。见 SBOM 属性，不伪造作者或补写通用 MIT 文本冒充上游许可。\n- MinGit/Git 二进制分发：随包声明已保留；仍需为实际版本及随带组件落实适用的完整对应源码、构建材料及分发方式。本项目尚未创建源码交付包或作出已履行源码义务的承诺。元数据中的上游发行链接仅为来源记录。\n- Linux Git 材料属于仓库中的另一平台工具链，不能据此宣称 Windows/Linux 二进制及各组件分发义务相同或已全部完成。\n- 逐项检查许可原文内容、适用的 NOTICE 与被修改上游文件的修改标记；某文件名为 LICENSE 不等于已证明许可完整。\n- 若替换、升级或新增依赖，应重新运行构建并核对实际发行物。\n\n上述问题未完成前，不应将当前包标注为“全部合规已认证”。\n`;
  await fsp.writeFile(path.join(outputRoot, "LICENSE-REVIEW.md"), review);
  return { components: records.length, files: [...records, ...distributions].reduce((total, item) => total + item.files.length, 0), missing };
}

module.exports = { buildLicenseArchive, noticeFiles, inside };
