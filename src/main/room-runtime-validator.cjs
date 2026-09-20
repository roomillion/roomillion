"use strict";
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { inspectCustomRoomSpec } = require("./custom-room.cjs");
const { normalizeRoomTestDefinition } = require("./room-test-definition.cjs");

function declaredRuntimeTimeout(input) {
  const definition = normalizeRoomTestDefinition(input);
  const duration = (definition?.scenarios || []).flatMap(item => item.actions).reduce((total, action) => total + (action.type === "wait" ? action.ms : action.type === "reload" ? 12000 : action.type === "click" ? 100 : 0), 0);
  return Math.min(300000, 45000 + duration);
}

async function validateRoomRuntime({ spec, signal, timeoutMs }) {
  signal?.throwIfAborted();
  const checked = inspectCustomRoomSpec(spec);
  if (!checked.report.passed) throw new Error("运行检查前必须通过静态检查");
  const jobRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-room-check-"));
  try {
    const input = path.join(jobRoot, "input.json");
    await fsp.writeFile(input, JSON.stringify(checked.spec));
    await runWorker(input, signal, timeoutMs ?? declaredRuntimeTimeout(checked.spec.files["room-tests.json"]));
    return await readResult(jobRoot);
  } finally {
    // Only the exact directory created above; never the user's room store.
    await fsp.rm(jobRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function validateInstalledProgramRuntime({ programRoot, signal, timeoutMs }) {
  signal?.throwIfAborted();
  const resolved = path.resolve(programRoot || "");
  const stats = await fsp.stat(resolved);
  if (!stats.isDirectory()) throw new Error("运行检查对象不是房间程序目录");
  const jobRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-room-check-"));
  try {
    const copiedProgram = path.join(jobRoot, "program");
    await fsp.cp(resolved, copiedProgram, { recursive: true, force: true });
    const input = path.join(jobRoot, "input.json");
    await fsp.writeFile(input, JSON.stringify({ mode: "installed-program", program: "program" }));
    let definition;
    try { definition = await fsp.readFile(path.join(copiedProgram, "app", "room-tests.json"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await runWorker(input, signal, timeoutMs ?? declaredRuntimeTimeout(definition));
    return await readResult(jobRoot);
  } finally {
    await fsp.rm(jobRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function runWorker(input, signal, timeoutMs, spawnWorker = spawn) {
  const electron = process.versions.electron ? require("electron") : null;
  const executable = process.versions.electron ? process.execPath : require("electron");
  const args = electron?.app?.isPackaged ? [`--room-runtime-check=${input}`] : [path.join(__dirname, "room-runtime-worker.cjs"), input];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawnWorker(executable, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = "";
    let settled = false;
    child.stderr?.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { child.stderr?.destroy?.(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    const stop = (error) => {
      if (settled) return;
      try { child.kill(); } catch {}
      finish(error);
    };
    const abort = () => stop(new Error("运行检查已停止"));
    const timer = setTimeout(() => stop(new Error(`房间运行检查超时（${Math.round(timeoutMs / 1000)} 秒）：请检查场景等待时长、初始化和未结束的异步任务`)), timeoutMs);
    child.once("error", finish);
    // Electron renderers can inherit stderr and keep the pipe open after the
    // browser process exits. Its exit is the completion signal, not pipe close.
    child.once("exit", code => finish(code === 0 ? null : new Error("隔离运行检查进程异常退出：" + diagnostics)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function readResult(jobRoot) {
  const output = path.join(jobRoot, "result.json");
  if ((await fsp.stat(output)).size > 100000) throw new Error("运行检查报告过大");
  const result = JSON.parse(await fsp.readFile(output, "utf8"));
  if (typeof result.passed !== "boolean") throw new Error("运行检查未返回有效结果");
  return result;
}

module.exports = { validateRoomRuntime, validateInstalledProgramRuntime, runWorker, declaredRuntimeTimeout };
