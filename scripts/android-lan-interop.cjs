"use strict";

// Dedicated emulator acceptance: exercise the production desktop broker against
// the production Android TLS host. ADB carries the link, not a mock server.
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const { RoomMultiplayerService } = require("../src/main/room-multiplayer-service.cjs");
const serial = process.argv[2];
if (!/^emulator-\d+$/.test(serial || "")) throw new Error("请指定专用安卓模拟器，例如 emulator-5554；此脚本不操作用户真机");
if (!process.env.ANDROID_HOME) throw new Error("请设置 ANDROID_HOME");
const adb = path.join(process.env.ANDROID_HOME, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const adbRun = (...args) => spawnSync(adb, ["-s", serial, ...args], { encoding: "utf8", windowsHide: true, timeout: 15000 });
const service = new RoomMultiplayerService();
let forwardPort, runner;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  const installed = adbRun("shell", "pm", "path", "io.roomillion.android.test");
  if (!installed.stdout.includes("package:")) throw new Error("请先在专用模拟器安装当前 debug 和 androidTest APK");
  // Only a fake test invitation in the debug app sandbox is touched.
  adbRun("shell", "run-as", "io.roomillion.android", "rm", "-f", "files/lan-test-invitation.json");
  runner = spawn(adb, ["-s", serial, "shell", "am", "instrument", "-w", "-r", "-e", "lanInterop", "true", "-e", "class",
    "io.roomillion.android.RoomLanSessionTest#desktopInteropWhenRequested", "io.roomillion.android.test/androidx.test.runner.AndroidJUnitRunner"], { windowsHide: true });
  let output = "";
  runner.stdout.on("data", chunk => { output += chunk.toString(); }); runner.stderr.on("data", chunk => { output += chunk.toString(); });
  const completion = new Promise((resolve, reject) => { runner.once("error", reject); runner.once("exit", code => resolve(code)); });
  let invitation;
  for (let count = 0; count < 100; count++) {
    const raw = adbRun("shell", "run-as", "io.roomillion.android", "cat", "files/lan-test-invitation.json");
    if (raw.status === 0) { invitation = JSON.parse(raw.stdout).invitation; break; }
    if (runner.exitCode !== null) throw new Error(`安卓测试主机未启动：${output.slice(-2000)}`);
    await wait(200);
  }
  if (!invitation) throw new Error("等待安卓测试主机超时");
  const endpoint = JSON.parse(Buffer.from(invitation.slice(15), "base64url").toString("utf8"));
  const forwarded = adbRun("forward", "tcp:0", `tcp:${endpoint.port}`);
  if (forwarded.status !== 0 || !/^\d+\s*$/.test(forwarded.stdout)) throw new Error("ADB 端口转发失败");
  forwardPort = Number(forwarded.stdout.trim()); endpoint.port = forwardPort;
  const joined = await service.join("desktop-probe", { id: endpoint.roomId, version: endpoint.roomVersion },
    { invitation: "roomillion-lan:" + Buffer.from(JSON.stringify(endpoint)).toString("base64url"), name: "桌面验收玩家" });
  await service.read("desktop-probe", { timeoutMs: 0 });
  service.send("desktop-probe", { action: "desktop-probe" });
  const result = await service.read("desktop-probe", { timeoutMs: 5000 });
  if (!result.events.some(event => event.type === "message" && event.data?.private === "only-this-player")) throw new Error("桌面未收到安卓主机的私密消息");
  service.send("desktop-probe", { action: "desktop-received" });
  const code = await completion;
  if (code !== 0 || !/OK \(1 test\)/.test(output) || /FAILURES!!!/.test(output)) throw new Error(`安卓互通断言失败：${output.slice(-2000)}`);
  const directory = path.resolve(__dirname, "../release/android-lan-acceptance"); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${serial}-interop.json`), JSON.stringify({ passed: true, serial,
    host: "Android native TLS", client: "desktop RoomMultiplayerService", link: "ADB forwarded TCP (not a wireless hotspot acceptance)",
    checks: ["pinned-certificate", "join", "client-to-host", "private-host-to-client", "host-asserted-receipt"],
    peerId: joined.peerId, createdAt: new Date().toISOString() }, null, 2) + "\n");
  console.log("ANDROID_DESKTOP_LAN_INTEROP_OK；无线热点仍需多台真机验收");
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  service.dispose();
  if (forwardPort) adbRun("forward", "--remove", `tcp:${forwardPort}`);
  if (runner && runner.exitCode === null) runner.kill();
});
