"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const yazl = require("yazl");
const { validateManifest, validateRelativePackagePath } = require("./manifest.cjs");
const { auditPortableRoom, createPortablePathRegistry } = require("./portability-service.cjs");
const { getOfficialModuleForPackage } = require("./room-dependency-policy.cjs");
const { validateRoomIconFile } = require("./room-icon.cjs");

// Technical anti-zip-bomb ceilings, not product-scale limits.
const MAX_PACKAGE_BYTES = 4 * 1024 ** 3;
const MAX_UNPACKED_BYTES = 16 * 1024 ** 3;
const MAX_ENTRY_BYTES = 4 * 1024 ** 3;
const MAX_ENTRIES = 250_000;
const DETERMINISTIC_MTIME = new Date("1980-01-01T00:00:00.000Z");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest("hex") };
}

function normalizeEntryPath(entryName) {
  if (typeof entryName !== "string" || entryName.includes("\\") || entryName.includes("\0")) {
    throw new Error("房间包包含非法路径");
  }
  const withoutTrailingSlash = entryName.endsWith("/") ? entryName.slice(0, -1) : entryName;
  if (!withoutTrailingSlash) return "";
  validateRelativePackagePath(withoutTrailingSlash, "ZIP entry");
  return withoutTrailingSlash;
}

function ensureInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("房间包路径越过了解压目录");
  }
  return resolvedTarget;
}

function openZip(packagePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(packagePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    });
  });
}

function openEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function isSymlink(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

async function extractZip(packagePath, destination, options = {}) {
  const maxPackageBytes = options.maxPackageBytes ?? MAX_PACKAGE_BYTES;
  const maxUnpackedBytes = options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const packageLabel = options.packageLabel ?? "房间包";
  const stats = await fsp.stat(packagePath);
  if (!stats.isFile()) throw new Error(`${packageLabel}不是普通文件`);
  if (stats.size > maxPackageBytes) throw new Error(`${packageLabel}超过大小限制`);

  await fsp.mkdir(destination, { recursive: true });
  const zipFile = await openZip(packagePath);
  let entryCount = 0;
  let totalBytes = 0;
  const portablePaths = createPortablePathRegistry();

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zipFile.close(); } catch {}
      reject(error);
    };

    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zipFile.on("entry", (entry) => {
      (async () => {
        entryCount += 1;
        if (entryCount > maxEntries) throw new Error(`${packageLabel}文件数量超过限制`);
        if (entry.uncompressedSize > maxEntryBytes) throw new Error(`${packageLabel}单文件过大：${entry.fileName}`);
        totalBytes += entry.uncompressedSize;
        if (totalBytes > maxUnpackedBytes) throw new Error(`${packageLabel}解压后超过大小限制`);
        if (isSymlink(entry)) throw new Error(`${packageLabel}不得包含符号链接：${entry.fileName}`);

        const relativePath = normalizeEntryPath(entry.fileName);
        if (!relativePath) {
          zipFile.readEntry();
          return;
        }
        portablePaths.add(relativePath);
        const outputPath = ensureInside(destination, path.join(destination, ...relativePath.split("/")));

        if (entry.fileName.endsWith("/")) {
          await fsp.mkdir(outputPath, { recursive: true });
        } else {
          await fsp.mkdir(path.dirname(outputPath), { recursive: true });
          const input = await openEntryStream(zipFile, entry);
          await pipeline(input, fs.createWriteStream(outputPath, { flags: "wx" }));
        }
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
  return { packageBytes: stats.size, entryCount, unpackedBytes: totalBytes };
}

async function walkFiles(root, current = root) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不能打包符号链接：${fullPath}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, fullPath));
    else if (entry.isFile()) files.push({
      fullPath,
      relativePath: path.relative(root, fullPath).split(path.sep).join("/")
    });
  }
  return files;
}

async function createIntegrity(root) {
  const files = await walkFiles(root);
  const records = [];
  for (const file of files) {
    if (file.relativePath === "integrity.json" || file.relativePath === "signature.json") continue;
    const record = await hashFile(file.fullPath);
    records.push({ path: file.relativePath, ...record });
  }
  return { algorithm: "sha256", files: records };
}

async function verifyIntegrity(root) {
  const integrityPath = path.join(root, "integrity.json");
  const parsed = JSON.parse(await fsp.readFile(integrityPath, "utf8"));
  if (parsed.algorithm !== "sha256" || !Array.isArray(parsed.files)) {
    throw new Error("integrity.json 格式无效");
  }

  const expectedPaths = new Set();
  for (const record of parsed.files) {
    validateRelativePackagePath(record.path, "integrity.files[].path");
    if (expectedPaths.has(record.path)) throw new Error(`完整性清单路径重复：${record.path}`);
    expectedPaths.add(record.path);
    const fullPath = ensureInside(root, path.join(root, ...record.path.split("/")));
    const actual = await hashFile(fullPath);
    if (actual.size !== record.size || actual.sha256 !== record.sha256) {
      throw new Error(`房间文件完整性校验失败：${record.path}`);
    }
  }

  const actualFiles = (await walkFiles(root))
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath !== "integrity.json" && relativePath !== "signature.json");
  for (const relativePath of actualFiles) {
    if (!expectedPaths.has(relativePath)) throw new Error(`房间包存在未登记文件：${relativePath}`);
  }
  return {
    algorithm: "sha256",
    fileCount: parsed.files.length,
    totalBytes: parsed.files.reduce((sum, record) => sum + record.size, 0),
    files: parsed.files.map((record) => ({ path: record.path, size: record.size, sha256: record.sha256 }))
  };
}

function validateEmbeddedDependencyFiles(manifest, files, { rejectOfficialDuplicates = false } = {}) {
  const actualFiles = new Set(
    files.map((file) => file.relativePath).filter((relativePath) => relativePath.startsWith("embedded/"))
  );
  const declaredFiles = new Set();
  for (const dependency of manifest.embeddedDependencies) {
    const officialModule = getOfficialModuleForPackage(dependency.package);
    if (rejectOfficialDuplicates && officialModule) {
      throw new Error(`${dependency.package} 已由工作台模块 ${officialModule.id} 提供，新房间不得重复打包`);
    }
    for (const relativePath of dependency.files) {
      declaredFiles.add(relativePath);
      if (!actualFiles.has(relativePath)) throw new Error(`额外依赖文件不存在：${relativePath}`);
    }
  }
  for (const relativePath of actualFiles) {
    if (!declaredFiles.has(relativePath)) throw new Error(`embedded/ 中存在未声明的额外依赖文件：${relativePath}`);
  }
  return true;
}

function summarizeEmbeddedDependencies(manifest, integrity) {
  const integrityByPath = new Map(integrity.files.map((record) => [record.path, record]));
  return manifest.embeddedDependencies.map((dependency) => {
    const records = dependency.files.map((relativePath) => integrityByPath.get(relativePath));
    const digest = crypto.createHash("sha256");
    for (const record of records.sort((a, b) => a.path.localeCompare(b.path, "en"))) {
      digest.update(record.path).update("\0").update(record.sha256).update("\n");
    }
    return {
      id: dependency.id,
      package: dependency.package,
      version: dependency.version,
      license: dependency.license,
      source: dependency.source,
      hostModuleEquivalent: getOfficialModuleForPackage(dependency.package)?.id ?? null,
      fileCount: records.length,
      bytes: records.reduce((sum, record) => sum + record.size, 0),
      contentSha256: digest.digest("hex")
    };
  });
}

async function readAndValidateManifest(root) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const validated = validateManifest(manifest);
  const entryPath = ensureInside(root, path.join(root, ...validated.entry.split("/")));
  const entryStats = await fsp.stat(entryPath);
  if (!entryStats.isFile()) throw new Error("房间入口不是普通文件");
  await validateRoomIconFile(root, validated.icon);
  return validated;
}

async function extractAndValidate(packagePath, tempRoot) {
  await fsp.mkdir(tempRoot, { recursive: true });
  const stagingPath = await fsp.mkdtemp(path.join(tempRoot, "room-import-"));
  try {
    const archive = await extractZip(packagePath, stagingPath);
    const manifest = await readAndValidateManifest(stagingPath);
    const icon = await validateRoomIconFile(stagingPath, manifest.icon);
    const integrity = await verifyIntegrity(stagingPath);
    const files = await walkFiles(stagingPath);
    validateEmbeddedDependencyFiles(manifest, files);
    const portability = await auditPortableRoom(files);
    const packageDigest = await hashFile(packagePath);
    let signature = { status: "missing" };
    try {
      const signatureText = await fsp.readFile(path.join(stagingPath, "signature.json"), "utf8");
      JSON.parse(signatureText);
      signature = { status: "unverified" };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("signature.json 格式无效");
    }
    return {
      manifest,
      stagingPath,
      packageInfo: {
        sha256: packageDigest.sha256,
        packageBytes: archive.packageBytes,
        entryCount: archive.entryCount,
        unpackedBytes: archive.unpackedBytes,
        integrity,
        embeddedDependencies: summarizeEmbeddedDependencies(manifest, integrity),
        portability,
        signature,
        icon
      }
    };
  } catch (error) {
    await fsp.rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function packDirectory(sourceRoot, destinationPath, { enforceCurrentDependencyPolicy = true } = {}) {
  const manifest = await readAndValidateManifest(sourceRoot);
  const sourceFiles = await walkFiles(sourceRoot);
  validateEmbeddedDependencyFiles(manifest, sourceFiles, { rejectOfficialDuplicates: enforceCurrentDependencyPolicy });
  await auditPortableRoom(sourceFiles);
  const integrity = await createIntegrity(sourceRoot);
  const integrityBuffer = Buffer.from(`${JSON.stringify(integrity, null, 2)}\n`, "utf8");
  const files = (await walkFiles(sourceRoot)).filter(
    (file) => file.relativePath !== "integrity.json" && file.relativePath !== "signature.json"
  );

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  const zipFile = new yazl.ZipFile();
  const output = fs.createWriteStream(destinationPath, { flags: "w" });
  const completed = pipeline(zipFile.outputStream, output);

  for (const file of files) {
    zipFile.addFile(file.fullPath, file.relativePath, { mtime: DETERMINISTIC_MTIME, mode: 0o100644 });
  }
  zipFile.addBuffer(integrityBuffer, "integrity.json", { mtime: DETERMINISTIC_MTIME, mode: 0o100644 });
  zipFile.end();
  await completed;
  return manifest;
}

module.exports = {
  MAX_PACKAGE_BYTES,
  MAX_ENTRY_BYTES,
  MAX_UNPACKED_BYTES,
  MAX_ENTRIES,
  createIntegrity,
  extractZip,
  extractAndValidate,
  packDirectory,
  sha256,
  summarizeEmbeddedDependencies,
  validateEmbeddedDependencyFiles,
  verifyIntegrity,
  walkFiles
};
