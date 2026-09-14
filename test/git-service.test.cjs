"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { GitService } = require("../src/main/git-service.cjs");
const { getTestGitToolchain } = require("../test-support/bundled-git.cjs");
const { packDirectory } = require("../src/main/room-package.cjs");
const { RoomStore } = require("../src/main/room-store.cjs");

async function setupRoom(root) {
  const source = path.join(root, "source");
  const packagePath = path.join(root, "room.room");
  await fsp.mkdir(path.join(source, "app"), { recursive: true });
  await fsp.writeFile(path.join(source, "manifest.json"), JSON.stringify({
    formatVersion: "0.1",
    id: "cn.zhibian.git-test",
    name: "版本测试房间",
    version: "1.0.0",
    runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" },
    entry: "app/index.html",
    permissions: { database: "private", files: ["export"], network: [] },
    hostModules: []
  }), "utf8");
  await fsp.writeFile(path.join(source, "app", "index.html"), "<!doctype html><title>INITIAL</title>", "utf8");
  await packDirectory(source, packagePath);
  const store = await new RoomStore(path.join(root, "data")).init();
  const room = await store.installPackage(packagePath, { source: "local-generated" });
  return { room, store };
}

test("bundled platform Git creates checkpoints without system PATH and restores program only", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-git-service-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const { room, store } = await setupRoom(root);
  const toolchain = getTestGitToolchain();
  const git = await new GitService(store, toolchain).init();
  assert.match(git.version, /^git version 2\./);
  const isolatedEnvironment = await git.createEnvironment(git.getProjectRoot(room.id));
  assert.doesNotMatch(isolatedEnvironment.PATH, /Program Files/i);
  assert.equal(isolatedEnvironment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(isolatedEnvironment.GIT_TERMINAL_PROMPT, "0");

  const initial = await git.captureRoom(room.id, "初始版本", { kind: "initial" });
  await fsp.writeFile(
    path.join(store.getProgramRoot(room.id), "app", "index.html"),
    "<!doctype html><title>SECOND</title>",
    "utf8"
  );
  const second = await git.captureRoom(room.id, "第二版", { kind: "manual" });
  assert.notEqual(initial.id, second.id);
  assert.ok(second.changes.some((change) => change.paths.includes("app/index.html")));

  const hooksConfig = await git.runGit(room.id, ["config", "--get", "core.hooksPath"]);
  assert.equal(hooksConfig.stdout.trim(), toolchain.nullDevice);
  const protocolConfig = await git.runGit(room.id, ["config", "--get", "protocol.allow"]);
  assert.equal(protocolConfig.stdout.trim(), "never");

  const restored = await git.restoreCheckpoint(room.id, initial.id);
  assert.equal(restored.restoredFrom.id, initial.id);
  const content = await fsp.readFile(path.join(store.getProgramRoot(room.id), "app", "index.html"), "utf8");
  assert.match(content, /INITIAL/);
  assert.equal(store.hasPermission(room.id, "files", "export"), true);

  const history = await git.listHistory(room.id);
  assert.equal(history.gitVersion, git.version);
  assert.equal(history.checkpoints[0].kind, "restore");
  assert.ok(history.checkpoints.some((checkpoint) => checkpoint.kind === "before-restore"));
});
