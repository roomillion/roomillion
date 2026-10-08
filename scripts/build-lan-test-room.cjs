"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { RoomStore } = require("../src/main/room-store.cjs");
const { createCustomRoom } = require("../src/main/custom-room.cjs");
const { spec, roomId } = require("../test/fixtures/lan-room.cjs");
async function build() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "roomillion-lan-fixture-"));
  const output = path.resolve(__dirname, "../release/android-lan-acceptance/房间");
  try {
    const store = await new RoomStore(path.join(temporary, "data")).init();
    const result = await createCustomRoom({ spec, roomId, roomStore: store, selectedKeys: ["multiplayer.host", "multiplayer.join"] });
    await fs.mkdir(output, { recursive: true });
    const packagePath = path.join(output, "局域网联机测试.room");
    await store.exportRoom(result.room.id, packagePath);
    const assetPath = path.resolve(__dirname, "../android/app/build/generated/androidTestAssets/lan-probe.room");
    await fs.mkdir(path.dirname(assetPath), { recursive: true }); await fs.copyFile(packagePath, assetPath);
    console.log("LAN_TEST_ROOM_OK " + packagePath);
  } finally {
    if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temporary).startsWith("roomillion-lan-fixture-")) throw new Error("临时目录校验失败");
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
build().catch(error => { console.error(error); process.exitCode = 1; });
