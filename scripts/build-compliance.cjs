"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { ROOM_MODULE_CATALOG } = require("../src/main/room-module-catalog.cjs");
const { buildLicenseArchive } = require("./third-party-licenses.cjs");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));
const packageLock = require(path.join(projectRoot, "package-lock.json"));
const outputRoot = path.join(projectRoot, "resources", "compliance");
const MANUAL_LICENSE_RESOLUTIONS = Object.freeze({
  "buffers@0.1.1": Object.freeze({
    license: "MIT",
    evidence: "https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/",
    reason: "npm tarball predates the license metadata field; Debian reviewed the upstream source as MIT"
  }),
  "khroma@2.1.0": Object.freeze({
    license: "MIT",
    evidence: "npm package file: node_modules/khroma/license",
    reason: "package.json omits the license field; the npm package includes the complete MIT license text",
    localFile: "node_modules/khroma/license",
    sha256: "66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49"
  })
});

function npmNameFromPath(packagePath) {
  const match = packagePath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  return match?.[1] ?? null;
}

function purl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function integrityHash(integrity) {
  if (typeof integrity !== "string") return [];
  const match = integrity.match(/^sha512-(.+)$/);
  if (!match) return [];
  return [{ alg: "SHA-512", content: Buffer.from(match[1], "base64").toString("hex") }];
}

function licenseRecord(license) {
  if (!license) return [];
  if (/^[A-Za-z0-9-.+]+$/.test(license)) return [{ license: { id: license } }];
  return [{ expression: license }];
}

function installedTree({ omitDev = true } = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("请通过 npm run build:compliance 执行，以便定位当前 npm CLI");
  const args = [npmCli, "ls", "--all", "--json"];
  if (omitDev) args.splice(2, 0, "--omit=dev");
  const result = childProcess.spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`无法读取生产依赖树：${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function collectTree(tree, directNames) {
  const components = new Map();
  const dependencyGraph = new Map();
  const directRefs = [];
  const visit = (name, item) => {
    if (!item?.version) return null;
    const ref = `${name}@${item.version}`;
    components.set(ref, { name, version: item.version });
    const children = [];
    for (const [childName, child] of Object.entries(item.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"))) {
      const childRef = visit(childName, child);
      if (childRef) children.push(childRef);
    }
    dependencyGraph.set(ref, [...new Set(children)].sort((a, b) => a.localeCompare(b, "en")));
    return ref;
  };
  for (const name of [...new Set(directNames)].sort((a, b) => a.localeCompare(b, "en"))) {
    const ref = visit(name, tree.dependencies?.[name]);
    if (ref) directRefs.push(ref);
  }
  dependencyGraph.set(`roomillion@${packageJson.version}`, [...new Set(directRefs)].sort((a, b) => a.localeCompare(b, "en")));
  return { components, dependencyGraph };
}

function mergeCollected(target, source) {
  for (const [ref, component] of source.components) target.components.set(ref, component);
  for (const [ref, children] of source.dependencyGraph) {
    target.dependencyGraph.set(ref, [...new Set([
      ...(target.dependencyGraph.get(ref) ?? []),
      ...children
    ])].sort((a, b) => a.localeCompare(b, "en")));
  }
}

async function buildSbom() {
  const runtimeCollected = collectTree(installedTree(), Object.keys(packageJson.dependencies));
  const roomModulePackageNames = ROOM_MODULE_CATALOG
    .filter((module) => module.sourceKind !== "vendor")
    .map((module) => module.packageName);
  const roomModuleCollected = collectTree(installedTree({ omitDev: false }), roomModulePackageNames);
  const roomAssetComponentRefs = new Set(roomModuleCollected.components.keys());
  const collected = { components: new Map(), dependencyGraph: new Map() };
  mergeCollected(collected, runtimeCollected);
  mergeCollected(collected, roomModuleCollected);
  const { components, dependencyGraph } = collected;
  const rootRef = `roomillion@${packageJson.version}`;

  for (const [ref, resolution] of Object.entries(MANUAL_LICENSE_RESOLUTIONS)) {
    if (!resolution.localFile) continue;
    const licenseBytes = await fsp.readFile(path.join(projectRoot, ...resolution.localFile.split("/")));
    const actualHash = crypto.createHash("sha256").update(licenseBytes).digest("hex");
    if (actualHash !== resolution.sha256) {
      throw new Error(`${ref} 的人工许可证证据哈希不匹配`);
    }
  }

  for (const module of ROOM_MODULE_CATALOG.filter((item) => item.sourceKind === "vendor")) {
    const ref = `${module.packageName}@${module.packageVersion}`;
    const metadata = JSON.parse(await fsp.readFile(
      path.join(projectRoot, ...module.sourceRoot.split("/"), module.metadataFile),
      "utf8"
    ));
    components.set(ref, {
      name: module.packageName,
      version: module.packageVersion,
      vendor: true,
      license: module.selectedLicense,
      distribution: metadata.source,
      hash: metadata.sha256
    });
    roomAssetComponentRefs.add(ref);
    dependencyGraph.set(ref, []);
    dependencyGraph.set(rootRef, [...new Set([...(dependencyGraph.get(rootRef) ?? []), ref])].sort((a, b) => a.localeCompare(b, "en")));
  }
  const lockEntries = new Map();
  for (const [packagePath, item] of Object.entries(packageLock.packages)) {
    const name = npmNameFromPath(packagePath);
    if (!name || !item.version) continue;
    const ref = `${name}@${item.version}`;
    if (!lockEntries.has(ref) || packagePath.split("node_modules").length < lockEntries.get(ref).packagePath.split("node_modules").length) {
      lockEntries.set(ref, { ...item, packagePath });
    }
  }

  const electronPackage = JSON.parse(await fsp.readFile(path.join(projectRoot, "node_modules", "electron", "package.json"), "utf8"));
  const electronRef = `electron@${electronPackage.version}`;
  components.set(electronRef, { name: "electron", version: electronPackage.version, electron: true });
  dependencyGraph.get(rootRef).push(electronRef);
  dependencyGraph.set(electronRef, []);

  const componentRecords = [...components.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([ref, component]) => {
    const lock = lockEntries.get(ref) ?? {};
    const manualLicense = MANUAL_LICENSE_RESOLUTIONS[ref];
    const license = component.electron
      ? electronPackage.license
      : component.license ?? lock.license ?? manualLicense?.license;
    const record = {
      "bom-ref": ref,
      type: "library",
      name: component.name,
      version: component.version,
      scope: "required",
      purl: component.vendor
        ? `pkg:generic/${encodeURIComponent(component.name)}@${encodeURIComponent(component.version)}`
        : purl(component.name, component.version),
      licenses: licenseRecord(license)
    };
    const distribution = component.distribution ?? lock.resolved;
    if (distribution) record.externalReferences = [{ type: "distribution", url: distribution }];
    const hashes = component.hash
      ? [{ alg: "SHA-256", content: component.hash }]
      : integrityHash(lock.integrity);
    if (hashes.length) record.hashes = hashes;
    if (manualLicense) {
      record.properties = [
        { name: "cn.zhibian:manual-license-evidence", value: manualLicense.evidence },
        { name: "cn.zhibian:manual-license-reason", value: manualLicense.reason }
      ];
    }
    return record;
  });

  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ lockfileVersion: packageLock.lockfileVersion, components: [...components.keys()].sort() }))
    .digest("hex");
  const serial = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-5${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
  const sbom = {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      lifecycles: [{ phase: "build" }],
      tools: [{ vendor: "千万间 Roomillion", name: "build-compliance.cjs", version: "1" }],
      component: {
        "bom-ref": rootRef,
        type: "application",
        name: packageJson.name,
        version: packageJson.version,
        author: packageJson.author,
        description: packageJson.description,
        licenses: licenseRecord(packageJson.license),
        purl: purl(packageJson.name, packageJson.version)
      },
      properties: [
        { name: "cn.zhibian:production-component-count", value: String(runtimeCollected.components.size) },
        { name: "cn.zhibian:official-room-module-count", value: String(ROOM_MODULE_CATALOG.length) },
        { name: "cn.zhibian:official-room-source-component-count", value: String(roomAssetComponentRefs.size) },
        { name: "cn.zhibian:packaged-third-party-component-count", value: String(componentRecords.length) }
      ]
    },
    components: componentRecords,
    dependencies: [...dependencyGraph.entries()]
      .filter(([ref]) => ref === rootRef || components.has(ref))
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([ref, dependsOn]) => ({ ref, dependsOn: [...new Set(dependsOn)].filter((item) => components.has(item)).sort((a, b) => a.localeCompare(b, "en")) }))
  };
  await fsp.writeFile(path.join(outputRoot, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  return {
    productionPackages: runtimeCollected.components.size,
    roomAssetPackages: roomAssetComponentRefs.size,
    totalComponents: componentRecords.length
  };
}

async function buildNotices(counts) {
  const purposes = {
    "@earendil-works/pi-agent-core": "有状态 Agent 工具循环、流式事件与会话编排",
    "@earendil-works/pi-ai": "多模型 Provider 与 AI 调用适配",
    "iconv-lite": "超长文本流式编码识别与解码",
    "sql.js": "每房间 SQLite 数据库",
    "yauzl": "安全读取 .room ZIP",
    "yazl": "生成 .room ZIP"
  };
  const coreRows = Object.keys(purposes).map((name) => {
    const version = packageJson.dependencies[name];
    const lock = packageLock.packages[`node_modules/${name}`];
    return `| \`${name}\` | ${version} | ${lock.license} | ${purposes[name]} |`;
  });
  const moduleRows = ROOM_MODULE_CATALOG.map((module) => {
    const licenseName = module.declaredLicense === module.selectedLicense
      ? module.selectedLicense
      : `${module.selectedLicense}（从 ${module.declaredLicense} 双许可中选择）`;
    const license = module.licenseEvidenceOnly ? `${licenseName}（原文待核对，仅保留上游证据）` : licenseName;
    return `| \`${module.id}\` | \`${module.packageName}\` | ${module.packageVersion} | ${license} | ${module.description} |`;
  });
  const text = `# 千万间 Roomillion 第三方组件说明

本文件对应千万间 Roomillion \`${packageJson.version}\`。完整传递依赖清单见同目录 \`sbom.cdx.json\`；当前清单记录 ${counts.productionPackages} 个应用运行依赖组件、${counts.roomAssetPackages} 个官方房间资源来源及其传递组件，另记录 Electron 桌面运行时。模块源码包只在构建期使用，安装包携带的是下方经过哈希校验的离线浏览器资源。

主项目原创代码采用 Apache-2.0，见同目录 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。第三方组件仍适用各自许可证，其版权归原作者或权利人所有。逐包原始许可、版权及 NOTICE 副本见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)；文件哈希与元数据见 [license-inventory.json](license-inventory.json)。缺失原文及源码提供待办见 [LICENSE-REVIEW.md](LICENSE-REVIEW.md)。

## 工作台核心直接运行依赖

| 组件 | 固定版本 | 许可证 | 用途 |
|---|---:|---|---|
${coreRows.join("\n")}
| \`Electron\` | ${packageJson.devDependencies.electron} | MIT | Windows/Linux 桌面外壳与沙箱渲染 |

## 官方房间模块目录

房间使用稳定能力 ID，不直接依赖 npm 包名。以下资源随安装包离线提供，只有在房间 \`manifest.json\` 中声明后才能加载；许可原文（或明确标记的待核对证据）及资源 SHA-256 位于 \`resources/room-modules/\`。fontkit 当前仅有上游 README 证据，不再借用 pdf-lib 的版权声明。

| 能力 ID | 内部实现 | 固定版本 | 许可证 | 用途 |
|---|---|---:|---|---|
${moduleRows.join("\n")}

## 人工许可证解析

- buffers@0.1.1：npm 压缩包发布年代较早，未包含许可证字段或单独文本；依据 Debian 对同一上游源码的审核记录，按 MIT 处理，证据地址为 https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/ 。该解析同时写入 SBOM 组件属性，正式公开发行前应由法务再次确认。
- khroma@2.1.0：\`package.json\` 漏写许可证字段，但 npm 包内的 \`license\` 文件是完整 MIT 文本；构建会校验该文件 SHA-256 为 \`66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49\`，防止证据被静默替换。

许可类型登记和文件哈希校验不是法律认证。原文收集不等于所有传递依赖的分发义务均已完成；正式公开发行前应依据逐包原文及待核对报告复核。

## 内置 Git 工具链

- Windows：Git for Windows MinGit \`2.55.0.windows.3\` x64；官方发行来源和 SHA-256 见 \`toolchains/mingit-metadata.json\`。
- Linux：发行时只打入针对目标 Linux x64 基线准备的便携 Git，并随附该工具链的元数据与许可证。
- Git 只由工作台结构化版本服务调用，不向房间暴露命令行，也不使用用户系统 Git、全局 Git 配置或 PATH。
`;
  await fsp.writeFile(path.join(outputRoot, "THIRD-PARTY-NOTICES.md"), text, "utf8");
}

async function build() {
  await fsp.mkdir(outputRoot, { recursive: true });
  const counts = await buildSbom();
  await buildNotices(counts);
  const licenses = await buildLicenseArchive({ projectRoot, outputRoot });
  console.log(`LICENSES_OK ${licenses.components} components, ${licenses.files} original files; ${licenses.missing.length} components need original-license review`);
  console.log(`COMPLIANCE_OK ${counts.productionPackages} runtime packages + ${counts.roomAssetPackages} room asset packages + Electron, ${ROOM_MODULE_CATALOG.length} room modules`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
