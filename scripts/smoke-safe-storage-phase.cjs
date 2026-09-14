"use strict";

const { app, safeStorage } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { AiService } = require("../src/main/ai-service.cjs");

function argumentValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

async function run() {
  const phase = argumentValue("phase");
  const smokeRoot = path.resolve(argumentValue("smoke-root") ?? "");
  const secret = process.env.ZHIBIAN_DPAPI_SMOKE_SECRET;
  if (!new Set(["write", "read"]).has(phase) || !smokeRoot || !secret) throw new Error("安全存储冒烟参数无效");
  const serviceRoot = path.join(smokeRoot, "service-data");
  app.setPath("userData", path.join(smokeRoot, "electron-user-data"));
  app.setPath("sessionData", path.join(smokeRoot, "electron-session-data"));
  app.commandLine.appendSwitch("disable-gpu");
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前 Windows 用户的 Electron safeStorage 不可用");

  const service = await new AiService(serviceRoot, { secureStorage: safeStorage }).init();
  if (phase === "write") {
    const profile = await service.saveProfile({
      name: "真实 Windows 安全存储冒烟",
      baseUrl: "http://127.0.0.1:65535/v1",
      model: "dpapi-smoke-model",
      apiKey: secret,
      rememberKey: true
    });
    if (!profile.hasStoredKey || !profile.hasSessionKey || !profile.secureStorageAvailable) {
      throw new Error("密钥未由系统安全存储持久化");
    }
    const encrypted = await fsp.readFile(service.secretPathFor(profile.id));
    if (encrypted.includes(Buffer.from(secret, "utf8"))) throw new Error("密钥文件包含明文");
    console.log(`SAFE_STORAGE_WRITE_OK ${JSON.stringify({ encryptedBytes: encrypted.length, secureStorageAvailable: true })}`);
    return;
  }

  const profile = service.getPublicProfile();
  if (!profile?.hasStoredKey || !profile.hasSessionKey || service.sessionApiKey !== secret || profile.keyStorageError) {
    throw new Error("新进程无法从 Windows 安全存储读取已保存密钥");
  }
  await service.clearSessionKey();
  const secretStillExists = await fsp.access(service.secretPathFor(profile.id)).then(() => true, () => false);
  if (secretStillExists) throw new Error("清除密钥后加密文件仍存在");
  console.log(`SAFE_STORAGE_READ_OK ${JSON.stringify({ reloadedInNewProcess: true, cleared: true })}`);
}

run().then(() => app.exit(0)).catch((error) => {
  console.error("SAFE_STORAGE_PHASE_FAILED", error.message);
  app.exit(1);
});
