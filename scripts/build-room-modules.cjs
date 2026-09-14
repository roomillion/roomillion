"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const esbuild = require("esbuild");
const { ROOM_MODULE_CATALOG } = require("../src/main/room-module-catalog.cjs");

const projectRoot = path.resolve(__dirname, "..");
const outputRoot = path.join(projectRoot, "resources", "room-modules");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function packageRoot(packageName) {
  return path.join(projectRoot, "node_modules", ...packageName.split("/"));
}

function sourceRootFor(module) {
  if (module.sourceKind === "vendor") return path.join(projectRoot, ...module.sourceRoot.split("/"));
  return packageRoot(module.packageName);
}

async function validateSource(module, sourceRoot) {
  if (module.sourceKind === "vendor") {
    const metadata = JSON.parse(await fsp.readFile(path.join(sourceRoot, module.metadataFile), "utf8"));
    if (metadata.packageName !== module.packageName || metadata.version !== module.packageVersion) {
      throw new Error(`${module.id} 供应链元数据与目录不匹配`);
    }
    if (metadata.declaredLicense !== module.declaredLicense) {
      throw new Error(`${module.id} 许可证声明变化：需要 ${module.declaredLicense}，实际 ${metadata.declaredLicense}`);
    }
    return metadata;
  }
  const packageJson = JSON.parse(await fsp.readFile(path.join(sourceRoot, "package.json"), "utf8"));
  if (packageJson.version !== module.packageVersion) {
    throw new Error(`${module.id} 版本不匹配：需要 ${module.packageVersion}，实际 ${packageJson.version}`);
  }
  if (packageJson.license !== module.declaredLicense) {
    throw new Error(`${module.id} 许可证声明变化：需要 ${module.declaredLicense}，实际 ${packageJson.license}`);
  }
  return null;
}

async function listFiles(root) {
  const result = [];
  const visit = async (current, prefix = "") => {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
      else if (entry.isFile()) result.push(relative);
    }
  };
  await visit(root);
  return result;
}

async function bundledAssetBuffer(entryPath, bundle) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    minify: true,
    legalComments: "inline",
    format: "iife",
    globalName: bundle.globalName,
    platform: "browser",
    target: ["chrome120"],
    logLevel: "silent"
  });
  if (result.outputFiles.length !== 1) throw new Error(`浏览器模块构建结果异常：${entryPath}`);
  return Buffer.from(result.outputFiles[0].contents);
}

async function copyAsset({ module, asset, sourceRoot, moduleRoot, metadata }) {
  const copyOne = async (sourcePath, publicName, buffer = null) => {
    const content = buffer ?? await fsp.readFile(sourcePath);
    const targetPath = path.join(moduleRoot, ...publicName.split("/"));
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, content);
    return {
      path: `${module.id}/${publicName}`,
      bytes: content.length,
      sha256: sha256(content),
      type: asset.type
    };
  };

  const sourcePath = path.join(sourceRoot, ...asset.source.split("/"));
  if (asset.directory) {
    const files = await listFiles(sourcePath);
    const records = [];
    for (const relative of files) {
      records.push(await copyOne(
        path.join(sourcePath, ...relative.split("/")),
        `${asset.publicName}/${relative}`
      ));
    }
    return records;
  }

  let buffer = asset.bundle
    ? await bundledAssetBuffer(sourcePath, asset.bundle)
    : await fsp.readFile(sourcePath);
  if (asset.wrapGlobal) {
    const { capture, expose } = asset.wrapGlobal;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(capture) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expose)) {
      throw new Error(module.id + " 全局变量包装配置无效");
    }
    buffer = Buffer.from(
      "(function(){const previous=globalThis." + capture + ";\n" +
      buffer.toString("utf8") +
      "\nconst exported=globalThis." + capture + ";" +
      "if(previous===undefined)delete globalThis." + capture + ";else globalThis." + capture + "=previous;" +
      "globalThis." + expose + "=exported;}).call(globalThis);\n",
      "utf8"
    );
  }
  if (asset.globalProperty) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(asset.global) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(asset.globalProperty)) {
      throw new Error(module.id + " 全局属性导出配置无效");
    }
    buffer = Buffer.concat([buffer, Buffer.from(
      `\nglobalThis.${asset.global}=globalThis.${asset.global}[${JSON.stringify(asset.globalProperty)}];\n`,
      "utf8"
    )]);
  }
  if (metadata?.file === asset.source) {
    if (buffer.length !== metadata.bytes || sha256(buffer) !== metadata.sha256) {
      throw new Error(`${module.id} 供应链文件哈希或大小不匹配`);
    }
  }
  return [await copyOne(sourcePath, asset.publicName, buffer)];
}

async function build() {
  await fsp.rm(outputRoot, { recursive: true, force: true });
  await fsp.mkdir(outputRoot, { recursive: true });
  const records = [];

  for (const module of ROOM_MODULE_CATALOG) {
    const sourceRoot = sourceRootFor(module);
    const metadata = await validateSource(module, sourceRoot);

    const moduleRoot = path.join(outputRoot, module.id);
    await fsp.mkdir(moduleRoot, { recursive: true });
    const licenseBuffer = await fsp.readFile(path.join(sourceRoot, ...module.licenseSource.split("/")));
    const licenseFile = module.licenseEvidenceOnly ? "LICENSE-EVIDENCE.md" : "LICENSE.txt";
    await fsp.writeFile(path.join(moduleRoot, licenseFile), licenseBuffer);
    if (module.licenseEvidenceOnly) {
      await fsp.writeFile(path.join(moduleRoot, "NOTICE.txt"), `${module.packageName}@${module.packageVersion}\nDeclared license: ${module.declaredLicense}\nThe source package omits a standalone full license. LICENSE-EVIDENCE.md is the upstream README, not a replacement license. See resources/compliance/LICENSE-REVIEW.md before public redistribution. The unrelated pdf-lib copyright notice must not be substituted for this component.\n`);
    }
    if (module.noticeSource) {
      const noticeBuffer = await fsp.readFile(path.join(sourceRoot, ...module.noticeSource.split("/")));
      await fsp.writeFile(path.join(moduleRoot, "NOTICE.txt"), noticeBuffer);
    }
    const assets = [];
    for (const asset of module.assets) {
      assets.push(...await copyAsset({ module, asset, sourceRoot, moduleRoot, metadata }));
    }
    records.push({
      id: module.id,
      name: module.name,
      package: module.packageName,
      version: module.packageVersion,
      declaredLicense: module.declaredLicense,
      selectedLicense: module.selectedLicense,
      licenseFile,
      licenseReviewRequired: Boolean(module.licenseEvidenceOnly),
      licenseSha256: sha256(licenseBuffer),
      sourceKind: module.sourceKind ?? "npm",
      selectable: module.selectable !== false,
      requires: [...module.requires],
      assets
    });
  }

  const manifest = {
    formatVersion: "1",
    policy: "fixed-version-license-inventoried-offline-only",
    moduleCount: records.length,
    packageCount: new Set(records.map((record) => record.package)).size,
    modules: records
  };
  await fsp.writeFile(path.join(outputRoot, "catalog.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`ROOM_MODULES_OK ${records.length} modules, ${manifest.packageCount} packages`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
