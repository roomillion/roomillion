"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { expandHostModules } = require("./room-module-catalog.cjs");
const { classifyRoomDependency } = require("./room-dependency-policy.cjs");
const { validateManifest, validateRelativePackagePath, VERSION_PATTERN } = require("./manifest.cjs");

function dependencyIdForPackage(packageName) {
  const normalized = String(packageName || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9.-]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 56);
  if (!normalized) throw new Error("额外依赖包名无效");
  return `npm.${normalized}`;
}

function resolveInside(root, relativePath, field) {
  validateRelativePackagePath(relativePath, field);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`${field} 路径越界`);
  return target;
}

async function readManifest(roomSourceRoot) {
  const manifestPath = path.join(roomSourceRoot, "manifest.json");
  return { manifestPath, manifest: JSON.parse(await fsp.readFile(manifestPath, "utf8")) };
}

async function writeManifest(manifestPath, manifest) {
  const validated = validateManifest(manifest);
  const temporaryPath = `${manifestPath}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await fsp.rename(temporaryPath, manifestPath);
  return validated;
}

async function assertPlainFile(filePath, label) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件`);
}

async function bundleRoomDependency({
  roomSourceRoot,
  packageName,
  packageVersion,
  license,
  source,
  packageRoot,
  licenseSource,
  assets = []
}) {
  const resolvedRoomRoot = path.resolve(roomSourceRoot);
  const { manifestPath, manifest } = await readManifest(resolvedRoomRoot);
  const classification = classifyRoomDependency({ packageName, license });
  const embeddedDependencies = manifest.embeddedDependencies ?? [];

  if (classification.kind === "host-module") {
    if (embeddedDependencies.some((dependency) => dependency.package === packageName)) {
      throw new Error(`${packageName} 已作为额外依赖存在，不能自动删除已有文件`);
    }
    manifest.hostModules = expandHostModules([...(manifest.hostModules ?? []), classification.hostModule]);
    const updated = await writeManifest(manifestPath, manifest);
    return { ...classification, manifest: updated, copiedFiles: [] };
  }

  if (!VERSION_PATTERN.test(String(packageVersion || ""))) throw new Error("额外依赖必须使用精确语义化版本");
  if (typeof license !== "string" || !license.trim()) throw new Error("额外依赖必须声明许可证");
  if (typeof source !== "string" || !source.trim()) throw new Error("额外依赖必须声明来源");
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("额外依赖至少需要一个浏览器入口资源");

  const dependencyId = dependencyIdForPackage(packageName);
  if (embeddedDependencies.some((dependency) => dependency.id === dependencyId || dependency.package === packageName)) {
    throw new Error(`房间已经包含额外依赖 ${packageName}`);
  }
  const resolvedPackageRoot = path.resolve(packageRoot);
  const embeddedRoot = path.join(resolvedRoomRoot, "embedded");
  const finalRoot = path.join(embeddedRoot, dependencyId);
  try {
    await fsp.access(finalRoot);
    throw new Error(`额外依赖目录已存在：embedded/${dependencyId}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fsp.mkdir(embeddedRoot, { recursive: true });
  const stagingRoot = await fsp.mkdtemp(path.join(embeddedRoot, ".dependency-"));
  const copiedFiles = [];
  try {
    const licensePath = resolveInside(resolvedPackageRoot, licenseSource, "licenseSource");
    await assertPlainFile(licensePath, "许可证来源");
    await fsp.copyFile(licensePath, path.join(stagingRoot, "LICENSE.txt"));
    copiedFiles.push(`embedded/${dependencyId}/LICENSE.txt`);

    const entrypoints = [];
    const targets = new Set(["LICENSE.txt"]);
    for (const [index, asset] of assets.entries()) {
      if (!asset || typeof asset !== "object") throw new Error(`assets[${index}] 无效`);
      const sourcePath = resolveInside(resolvedPackageRoot, asset.source, `assets[${index}].source`);
      const target = validateRelativePackagePath(asset.target, `assets[${index}].target`);
      if (target.split("/").some((segment) => segment.toLowerCase() === "node_modules")) {
        throw new Error("额外依赖目标不得包含 node_modules");
      }
      if (targets.has(target)) throw new Error(`额外依赖目标重复：${target}`);
      targets.add(target);
      await assertPlainFile(sourcePath, `assets[${index}].source`);
      const stagedTarget = resolveInside(stagingRoot, target, `assets[${index}].target`);
      await fsp.mkdir(path.dirname(stagedTarget), { recursive: true });
      await fsp.copyFile(sourcePath, stagedTarget);
      const packagedPath = `embedded/${dependencyId}/${target}`;
      copiedFiles.push(packagedPath);
      if (asset.entrypoint !== false) entrypoints.push(packagedPath);
    }
    if (!entrypoints.length) throw new Error("额外依赖至少需要一个入口资源");

    await fsp.rename(stagingRoot, finalRoot);
    const dependency = {
      id: dependencyId,
      package: packageName,
      version: packageVersion,
      license: license.trim(),
      source: source.trim(),
      root: `embedded/${dependencyId}`,
      licenseFile: `embedded/${dependencyId}/LICENSE.txt`,
      files: copiedFiles,
      entrypoints
    };
    manifest.embeddedDependencies = [...embeddedDependencies, dependency];
    try {
      const updated = await writeManifest(manifestPath, manifest);
      return { ...classification, dependency, manifest: updated, copiedFiles };
    } catch (error) {
      await fsp.rm(finalRoot, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { bundleRoomDependency, dependencyIdForPackage };
