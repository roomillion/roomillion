"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { packDirectory } = require("../src/main/room-package.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");

async function createPackage(root, {
  id = "cn.zhibian.import-test",
  version = "1.0.0",
  permissions = { database: "private", files: ["pick", "export"], ai: { roles: ["general"] }, network: [] },
  sharing
} = {}) {
  const source = path.join(root, `source-${version.replaceAll(".", "-")}-${Math.random().toString(16).slice(2)}`);
  const packagePath = path.join(root, `${id}-${version}.room`);
  await fsp.mkdir(path.join(source, "app"), { recursive: true });
  await fsp.writeFile(path.join(source, "manifest.json"), JSON.stringify({
    formatVersion: "0.1",
    id,
    name: "导入测试房间",
    version,
    publisher: { id: "cn.example", name: "示例发布者" },
    runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" },
    entry: "app/index.html",
    permissions,
    hostModules: [],
    ...(sharing ? { sharing } : {})
  }), "utf8");
  await fsp.writeFile(path.join(source, "app", "index.html"), `<!doctype html><title>${version}</title>`, "utf8");
  await packDirectory(source, packagePath);
  return packagePath;
}

test("external room is inspected without installation and cancellation cleans staging", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-import-cancel-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const packagePath = await createPackage(root);
  const store = await new RoomStore(path.join(root, "data")).init();
  const inspection = await store.inspectPackage(packagePath, { source: "external" });

  assert.equal(store.listRooms().length, 0);
  assert.equal(inspection.trust, "unknown");
  assert.equal(inspection.riskLevel, "high");
  assert.deepEqual(inspection.defaultSelectedKeys, ["database.private"]);
  assert.equal(inspection.package.verifiedFiles, 2);
  assert.equal(inspection.package.portability.status, "portable");
  assert.equal(store.pendingImports.size, 1);

  assert.equal(await store.cancelImport(inspection.token), true);
  assert.equal(store.pendingImports.size, 0);
  assert.equal(store.listRooms().length, 0);
});

test("confirmed import grants only selected capabilities and permissions can be revoked", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-import-confirm-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const packagePath = await createPackage(root);
  const store = await new RoomStore(path.join(root, "data")).init();
  const inspection = await store.inspectPackage(packagePath, { source: "external" });
  const room = await store.commitImport(inspection.token, ["database.private", "files.export"]);

  assert.equal(room.trust, "unknown");
  assert.equal(store.hasPermission(room.id, "database"), true);
  assert.equal(store.hasPermission(room.id, "files", "export"), true);
  assert.equal(store.hasPermission(room.id, "files", "pick"), false);
  assert.equal(store.hasPermission(room.id, "ai"), false);
  const initialDetails = store.getPermissionDetails(room.id);
  assert.deepEqual(initialDetails.requestedKeys, ["database.private", "files.pick", "files.export", "ai.general"]);
  assert.deepEqual(initialDetails.grantedKeys, ["database.private", "files.export"]);
  assert.deepEqual(
    Object.fromEntries(initialDetails.items.map((item) => [item.key, item.granted])),
    { "database.private": true, "files.pick": false, "files.export": true, "ai.general": false }
  );

  await store.setRoomPermissions(room.id, ["database.private", "files.pick", "ai.general"]);
  assert.equal(store.hasPermission(room.id, "files", "export"), false);
  assert.equal(store.hasPermission(room.id, "files", "pick"), true);
  assert.equal(store.hasPermission(room.id, "ai", "general"), true);
  assert.deepEqual(store.getPermissionDetails(room.id).grantedKeys, ["database.private", "files.pick", "ai.general"]);

  await assert.rejects(
    () => store.setRoomPermissions(room.id, ["database.private", "files.system"]),
    /未申请/
  );
});

test("room update reports new permissions and preserves previously granted ones by default", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-import-update-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const first = await createPackage(root, {
    version: "1.0.0",
    permissions: { database: "private", files: ["export"], network: [] }
  });
  const second = await createPackage(root, {
    version: "1.1.0",
    permissions: { database: "private", files: ["export", "pick"], network: [] }
  });
  const store = await new RoomStore(path.join(root, "data")).init();
  const firstInspection = await store.inspectPackage(first, { source: "external" });
  await store.commitImport(firstInspection.token, ["database.private", "files.export"]);

  const update = await store.inspectPackage(second, { source: "external" });
  assert.equal(update.versionChange, "upgrade");
  assert.deepEqual(update.permissionDiff.added, ["files.pick"]);
  assert.deepEqual(update.defaultSelectedKeys, ["database.private", "files.export"]);
  await store.cancelImport(update.token);
  assert.equal(store.getRoom("cn.zhibian.import-test").version, "1.0.0");
});

test("AI modification sharing flag travels with export, import and re-export choices", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-sharing-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const plain = await createPackage(root, { version: "1.0.0" });
  const store = await new RoomStore(path.join(root, "data")).init();
  const inspection = await store.inspectPackage(plain, { source: "external" });
  assert.equal(inspection.room.allowAiModification, false);
  const room = await store.commitImport(inspection.token, ["database.private"]);
  assert.equal(room.allowAiModification, false);
  assert.equal(store.getRoom(room.id).allowAiModification, false);

  // 导出时勾选允许：包内 manifest 带标记，本机已安装副本保持不变
  const sharedPath = path.join(root, "shared.room");
  await store.exportRoom(room.id, sharedPath, { allowAiModification: true });
  assert.equal(store.getRoom(room.id).allowAiModification, false);
  const sharedInspection = await store.inspectPackage(sharedPath, { source: "external" });
  assert.equal(sharedInspection.room.allowAiModification, true);
  assert.ok(sharedInspection.risks.some((risk) => risk.code === "ai-modification-allowed"));

  // 安装带标记的包后，房间注册记录透出标记
  const updated = await store.commitImport(sharedInspection.token, ["database.private"]);
  assert.equal(updated.allowAiModification, true);
  assert.equal(store.getRoom(room.id).allowAiModification, true);

  // 默认导出保持房间当前声明；显式取消勾选则从包内移除标记
  const keptPath = path.join(root, "kept.room");
  await store.exportRoom(room.id, keptPath);
  const keptInspection = await store.inspectPackage(keptPath, { source: "external" });
  assert.equal(keptInspection.room.allowAiModification, true);
  await store.cancelImport(keptInspection.token);

  const strippedPath = path.join(root, "stripped.room");
  await store.exportRoom(room.id, strippedPath, { allowAiModification: false });
  const strippedInspection = await store.inspectPackage(strippedPath, { source: "external" });
  assert.equal(strippedInspection.room.allowAiModification, false);
  assert.ok(!strippedInspection.risks.some((risk) => risk.code === "ai-modification-allowed"));
  await store.cancelImport(strippedInspection.token);

  await assert.rejects(() => store.exportRoom(room.id, path.join(root, "bad.room"), { allowAiModification: "yes" }), /分享选项无效/);
});
