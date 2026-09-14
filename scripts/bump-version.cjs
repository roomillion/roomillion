"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packagePath = path.join(projectRoot, "package.json");
const lockPath = path.join(projectRoot, "package-lock.json");

function nextBuildVersion(version) {
  const prerelease = String(version).match(/^(\d+)\.(\d+)\.(\d+)-([a-z]+)\.(\d+)$/i);
  if (prerelease) {
    return `${prerelease[1]}.${prerelease[2]}.${prerelease[3]}-${prerelease[4]}.${Number(prerelease[5]) + 1}`;
  }
  const stable = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (stable) return `${stable[1]}.${stable[2]}.${Number(stable[3]) + 1}`;
  throw new Error(`无法自动递增版本号：${version}`);
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.version-next.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, target);
}

async function main() {
  const packageJson = JSON.parse(await fsp.readFile(packagePath, "utf8"));
  const packageLock = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  const previous = packageJson.version;
  const next = nextBuildVersion(previous);
  if (packageLock.version !== previous || packageLock.packages?.[""]?.version !== previous) {
    throw new Error("package.json 与 package-lock.json 版本不一致，请先修复再发布");
  }
  packageJson.version = next;
  packageLock.version = next;
  packageLock.packages[""].version = next;
  await writeJsonAtomic(packagePath, packageJson);
  await writeJsonAtomic(lockPath, packageLock);
  process.stdout.write(`VERSION_BUMP_OK ${previous} -> ${next}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("VERSION_BUMP_FAILED", error.message);
    process.exitCode = 1;
  });
}

module.exports = { nextBuildVersion };
