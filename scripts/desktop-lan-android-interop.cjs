"use strict";

// Production desktop host and Android client; ADB supplies the test link only.
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { RoomMultiplayerService, parseInvitation } = require("../src/main/room-multiplayer-service.cjs");
const serial = process.argv[2];
if (!/^emulator-\d+$/.test(serial || "")) throw new Error("请指定专用安卓模拟器；此脚本不操作用户真机");
if (!process.env.ANDROID_HOME) throw new Error("请设置 ANDROID_HOME");
const adb = path.join(process.env.ANDROID_HOME, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const adbRun = (...args) => {
  const result = spawnSync(adb, ["-s", serial, ...args], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (result.status !== 0) throw new Error(`ADB 操作失败：${result.stderr.slice(-500)}`);
  return result.stdout;
};
const room = { id: "cn.roomillion.lan-test", version: "1.0.0" };
const host = new RoomMultiplayerService({ networkInterfaces: () => ({ test: [{ address: "127.0.0.1", internal: false }] }) });
const desktop = new RoomMultiplayerService();
let port, runner, temporary;
async function run() {
  if (!adbRun("shell", "pm", "path", "io.roomillion.android.test").includes("package:")) throw new Error("请安装最新 debug 和 androidTest APK");
  const created = await host.create("host-probe", room, { name: "电脑主机验收", maxPlayers: 3 });
  const invitation = created.invitations[0].invitation, endpoint = parseInvitation(invitation, room); port = endpoint.port;
  adbRun("reverse", `tcp:${port}`, `tcp:${port}`);
  const pc = await desktop.join("pc-probe", room, { invitation, name: "电脑验收玩家" });
  await host.read("host-probe", { timeoutMs: 0 }); await desktop.read("pc-probe", { timeoutMs: 0 });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "roomillion-desktop-lan-"));
  const local = path.join(temporary, "invitation.json"), remote = "/data/local/tmp/roomillion-desktop-lan-invitation.json";
  await fs.writeFile(local, JSON.stringify({ invitation }));
  adbRun("push", local, remote);
  adbRun("shell", "run-as", "io.roomillion.android", "cp", remote, "files/desktop-lan-test-invitation.json");
  adbRun("shell", "rm", "-f", remote);
  runner = spawn(adb, ["-s", serial, "shell", "am", "instrument", "-w", "-r", "-e", "desktopHostInterop", "true", "-e", "class",
    "io.roomillion.android.RoomLanSessionTest#joinDesktopHostWhenRequested", "io.roomillion.android.test/androidx.test.runner.AndroidJUnitRunner"], { windowsHide: true });
  let output = "";
  runner.stdout.on("data", chunk => { output += chunk.toString(); }); runner.stderr.on("data", chunk => { output += chunk.toString(); });
  const completion = new Promise((resolve, reject) => { runner.once("error", reject); runner.once("exit", resolve); });
  // Attach a rejection handler now while the protocol assertions are pending.
  completion.catch(() => {});
  let peer, replied = false;
  const end = Date.now() + 20000;
  while (!replied && Date.now() < end) {
    const batch = await host.read("host-probe", { timeoutMs: 1000 });
    for (const event of batch.events) {
      if (event.type === "message" && event.data?.action === "android-probe") {
        peer = event.from;
        host.send("host-probe", { phase: "day" });
        host.send("host-probe", { private: "android-only" }, { to: peer });
      }
      if (event.type === "message" && event.from === peer && event.data?.action === "android-received") replied = true;
    }
    if (runner.exitCode !== null && !replied) throw new Error(`安卓测试提前退出：${output.slice(-1500)}`);
  }
  if (!replied) throw new Error("安卓未确认收到电脑主机消息");
  const received = await desktop.read("pc-probe", { timeoutMs: 100 });
  if (!received.events.some(event => event.type === "message" && event.data?.phase === "day") || received.events.some(event => event.data?.private)) throw new Error("电脑玩家的广播或私密隔离失败");
  const code = await completion;
  if (code !== 0 || !/OK \(1 test\)/.test(output) || /FAILURES!!!/.test(output)) throw new Error(`安卓互通断言失败：${output.slice(-1500)}`);
  const directory = path.resolve(__dirname, "../release/android-lan-acceptance"); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${serial}-desktop-host-interop.json`), JSON.stringify({ passed: true, serial,
    host: "desktop RoomMultiplayerService", clients: ["Android native TLS", "desktop RoomMultiplayerService"],
    link: "ADB reverse TCP (not real wireless LAN acceptance)", checks: ["pinned-certificate", "android-join", "desktop-join", "client-to-host", "broadcast", "private-isolation", "android-asserted-receipt"],
    createdAt: new Date().toISOString() }, null, 2) + "\n");
  console.log("DESKTOP_ANDROID_LAN_HOST_INTEROP_OK");
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  desktop.dispose(); host.dispose();
  if (port) { try { adbRun("reverse", "--remove", `tcp:${port}`); } catch {} }
  if (runner && runner.exitCode === null) runner.kill();
  try { adbRun("shell", "run-as", "io.roomillion.android", "rm", "-f", "files/desktop-lan-test-invitation.json"); } catch {}
  if (temporary && path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temporary).startsWith("roomillion-desktop-lan-")) await fs.rm(temporary, { recursive: true, force: true });
});
