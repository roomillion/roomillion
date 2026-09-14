"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveBundledGit } = require("../src/main/platform-runtime.cjs");

const execFileAsync = promisify(execFile);

async function fileSha256(filePath) {
  const buffer = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function statOrNull(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isSafeToolchainPath(relativePath) {
  return typeof relativePath === "string" &&
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes("\\") &&
    relativePath.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

async function verifyLinuxToolchain(appPath, { executeVersion = process.platform === "linux" } = {}) {
  const descriptor = resolveBundledGit({
    platform: "linux",
    arch: "x64",
    isPackaged: false,
    appPath
  });
  const errors = [];
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(descriptor.metadataPath, "utf8"));
  } catch (error) {
    errors.push(`无法读取 metadata.json：${error.message}`);
  }

  if (metadata) {
    if (metadata.target !== "linux-x64") errors.push("metadata.target 必须是 linux-x64");
    if (metadata.status !== "ready") errors.push(`工具链状态不是 ready：${metadata.status ?? "missing"}`);
    if (typeof metadata.version !== "string" || !metadata.version) errors.push("metadata.version 未填写");
    if (typeof metadata.source !== "string" || !metadata.source) errors.push("metadata.source 未填写");
    if (!/^[a-f0-9]{64}$/i.test(metadata.gitSha256 ?? "")) errors.push("metadata.gitSha256 不是 SHA-256");
    if (typeof metadata.licenseFile !== "string" || !metadata.licenseFile) errors.push("metadata.licenseFile 未填写");
    if (!Array.isArray(metadata.requiredFiles) || metadata.requiredFiles.length === 0) errors.push("metadata.requiredFiles 未填写");
    if (!metadata.linkage) errors.push("metadata.linkage 未填写");
  }

  const requiredFiles = Array.isArray(metadata?.requiredFiles) ? metadata.requiredFiles : ["bin/git"];
  for (const relativePath of requiredFiles) {
    if (!isSafeToolchainPath(relativePath)) {
      errors.push(`requiredFiles 包含无效路径：${relativePath}`);
      continue;
    }
    const stats = await statOrNull(path.join(descriptor.toolchainRoot, relativePath));
    if (!stats) errors.push(`缺少工具链文件：${relativePath}`);
  }

  const executableStats = await statOrNull(descriptor.executable);
  if (!executableStats?.isFile()) {
    errors.push("缺少 bin/git");
  } else {
    const actualHash = await fileSha256(descriptor.executable);
    if (metadata?.gitSha256 && actualHash !== metadata.gitSha256.toLowerCase()) {
      errors.push(`bin/git 哈希不匹配：${actualHash}`);
    }
    if (executeVersion) {
      if ((executableStats.mode & 0o111) === 0) errors.push("bin/git 没有可执行权限");
      try {
        const result = await execFileAsync(descriptor.executable, ["--version"], {
          cwd: descriptor.toolchainRoot,
          env: {
            PATH: descriptor.pathEntries.join(descriptor.pathDelimiter),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: descriptor.nullDevice,
            GIT_TERMINAL_PROMPT: "0",
            GIT_EXEC_PATH: descriptor.gitExecPath,
            GIT_TEMPLATE_DIR: descriptor.gitTemplatePath,
            LD_LIBRARY_PATH: descriptor.libraryPaths.join(descriptor.pathDelimiter),
            HOME: descriptor.toolchainRoot,
            LC_ALL: "C"
          },
          encoding: "utf8",
          timeout: 10_000
        });
        const reported = result.stdout.trim();
        if (!/^git version 2\./.test(reported)) errors.push(`Git 版本输出无效：${reported}`);
        if (metadata?.version && !reported.includes(metadata.version)) errors.push(`Git 输出与 metadata.version 不一致：${reported}`);
      } catch (error) {
        errors.push(`bin/git 无法在隔离环境运行：${String(error.stderr || error.message).trim()}`);
      }
    }
  }

  const licensePath = isSafeToolchainPath(metadata?.licenseFile)
    ? path.join(descriptor.toolchainRoot, metadata.licenseFile)
    : null;
  if (metadata?.licenseFile && (!licensePath || !(await statOrNull(licensePath))?.isFile())) {
    errors.push(`许可证文件不存在：${metadata.licenseFile}`);
  }

  return {
    ok: errors.length === 0,
    target: descriptor.targetId,
    executable: descriptor.executable,
    metadata: metadata ? {
      status: metadata.status,
      version: metadata.version,
      source: metadata.source,
      certifiedSystem: metadata.certifiedSystem
    } : null,
    executeVersion,
    errors
  };
}

async function main() {
  const report = await verifyLinuxToolchain(path.resolve(__dirname, ".."));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error("Linux x64 Git 工具链尚未就绪；构建已安全阻断。请按 resources/toolchains/git-linux-x64/README.md 补齐并核验。");
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { fileSha256, isSafeToolchainPath, verifyLinuxToolchain };
