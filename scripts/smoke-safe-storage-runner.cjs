"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const electronPath = require("electron");
const phaseScript = path.join(__dirname, "smoke-safe-storage-phase.cjs");

async function runPhase(phase, smokeRoot, secret) {
  const childEnvironment = { ...process.env, ZHIBIAN_DPAPI_SMOKE_SECRET: secret };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [phaseScript, `--phase=${phase}`, `--smoke-root=${smokeRoot}`], {
    cwd: path.join(__dirname, ".."),
    env: childEnvironment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`safeStorage ${phase} 阶段超时`));
    }, 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  if (stdout.includes(secret) || stderr.includes(secret)) throw new Error(`${phase} 阶段输出了明文密钥`);
  if (exitCode !== 0) throw new Error(`${phase} 阶段失败：${stdout}\n${stderr}`);
  return { stdout, stderr };
}

async function scanFilesForSecret(root, secret) {
  const pending = [root];
  let fileCount = 0;
  const secretBuffer = Buffer.from(secret, "utf8");
  while (pending.length) {
    const current = pending.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        const stats = await fsp.stat(fullPath);
        if (stats.size > 20 * 1024 * 1024) continue;
        const buffer = await fsp.readFile(fullPath);
        fileCount += 1;
        if (buffer.includes(secretBuffer)) throw new Error(`磁盘文件包含明文密钥：${entry.name}`);
      }
    }
  }
  return fileCount;
}

async function main() {
  const smokeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-real-safe-storage-"));
  const secret = `ZB_DPAPI_${crypto.randomBytes(32).toString("hex")}`;
  try {
    const write = await runPhase("write", smokeRoot, secret);
    assert.match(write.stdout, /SAFE_STORAGE_WRITE_OK/);
    const serviceRoot = path.join(smokeRoot, "service-data");
    const registry = JSON.parse(await fsp.readFile(path.join(serviceRoot, "provider.json"), "utf8"));
    assert.equal(registry.formatVersion, "0.2");
    const encryptedPath = path.join(serviceRoot, "provider-secrets", `${registry.activeProfileId}.bin`);
    const encryptedBytes = (await fsp.stat(encryptedPath)).size;
    const filesScannedAfterWrite = await scanFilesForSecret(smokeRoot, secret);

    const read = await runPhase("read", smokeRoot, secret);
    assert.match(read.stdout, /SAFE_STORAGE_READ_OK/);
    await assert.rejects(() => fsp.access(encryptedPath));
    const filesScannedAfterClear = await scanFilesForSecret(smokeRoot, secret);
    console.log(`SAFE_STORAGE_SMOKE_OK ${JSON.stringify({
      provider: "Electron safeStorage on Windows",
      processes: 2,
      encryptedBytes,
      filesScannedAfterWrite,
      filesScannedAfterClear,
      plaintextFound: false,
      cleared: true
    })}`);
  } finally {
    await fsp.rm(smokeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("SAFE_STORAGE_SMOKE_FAILED", error.message);
  process.exitCode = 1;
});
