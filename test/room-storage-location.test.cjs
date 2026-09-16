"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RoomStorageLocation, dataRootForSelection } = require("../src/main/room-storage-location.cjs");
const { RoomImportLocation } = require("../src/main/room-import-location.cjs");

test("unpacked build installs rooms beside the executable and preserves existing profile data", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-unpacked-location-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const profileRoot = path.join(root, "profile");
  const executablePath = path.join(root, "unzipped", "Roomillion.exe");
  const legacy = path.join(profileRoot, "mvp-data");
  await fsp.mkdir(path.join(legacy, "rooms", "example", "program"), { recursive: true });
  await fsp.writeFile(path.join(legacy, "registry.json"), '{"rooms":{}}');
  await fsp.writeFile(path.join(legacy, "rooms", "example", "program", "manifest.json"), "original");
  const location = new RoomStorageLocation({ profileRoot, executablePath, packaged: true, portableFolder: true });
  const actual = await location.resolveStartup();
  assert.equal(actual, path.join(root, "unzipped", "Roomillion-data"));
  assert.equal(await fsp.readFile(path.join(actual, "rooms", "example", "program", "manifest.json"), "utf8"), "original");
  assert.equal(await fsp.readFile(path.join(legacy, "rooms", "example", "program", "manifest.json"), "utf8"), "original");
  assert.equal(await location.resolveStartup(), actual);
  await assert.rejects(fsp.access(location.configPath), { code: "ENOENT" });
});

test("single-file portable asks on first launch and keeps the chosen location", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-exe-location-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let prompts = 0;
  const selected = path.join(root, "chosen");
  await fsp.mkdir(selected);
  const options = { profileRoot: path.join(root, "profile"), executablePath: path.join(root, "temp", "Roomillion.exe"), packaged: true,
    portableExecutableDir: path.join(root, "portable"), pickDirectory: async () => { prompts += 1; return selected; } };
  const first = new RoomStorageLocation(options);
  assert.equal(await first.resolveStartup(), path.join(selected, "Roomillion-data"));
  const second = new RoomStorageLocation(options);
  assert.equal(await second.resolveStartup(), path.join(selected, "Roomillion-data"));
  assert.equal(prompts, 1);
  assert.equal(dataRootForSelection(path.join(selected, "Roomillion-data")), path.join(selected, "Roomillion-data"));
});

test("changing room location migrates on restart without deleting the old data", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-move-location-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const options = { profileRoot: path.join(root, "profile"), executablePath: path.join(root, "dev", "electron.exe"), packaged: false };
  const location = new RoomStorageLocation(options);
  const original = await location.resolveStartup();
  await fsp.mkdir(path.join(original, "rooms", "test", "data"), { recursive: true });
  await fsp.writeFile(path.join(original, "registry.json"), '{"rooms":{}}');
  await fsp.writeFile(path.join(original, "rooms", "test", "data", "saved.txt"), "keep");
  const nextParent = path.join(root, "external");
  await fsp.mkdir(nextParent);
  const scheduled = await location.scheduleMove(original, nextParent);
  assert.equal(scheduled.restartRequired, true);
  assert.equal(await fsp.readFile(path.join(original, "rooms", "test", "data", "saved.txt"), "utf8"), "keep");
  const restarted = new RoomStorageLocation(options);
  const actual = await restarted.resolveStartup();
  assert.equal(actual, path.join(nextParent, "Roomillion-data"));
  assert.equal(await fsp.readFile(path.join(actual, "rooms", "test", "data", "saved.txt"), "utf8"), "keep");
  assert.equal(await fsp.readFile(path.join(original, "rooms", "test", "data", "saved.txt"), "utf8"), "keep");
  await assert.rejects(restarted.scheduleMove(actual, path.join(actual, "nested")), /包含当前/);
});

test("last successful room import directory persists and missing folders are ignored", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-import-location-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const importDirectory = path.join(root, "packages");
  await fsp.mkdir(importDirectory);
  const saved = new RoomImportLocation(path.join(root, "data"));
  assert.equal(await saved.get(), null);
  await saved.remember(path.join(importDirectory, "a.room"));
  assert.equal(await new RoomImportLocation(path.join(root, "data")).get(), importDirectory);
  await fsp.rmdir(importDirectory);
  assert.equal(await saved.get(), null);
});


test("installed build keeps its writable user-profile storage", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-installed-location-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const profileRoot = path.join(root, "profile");
  const location = new RoomStorageLocation({ profileRoot, executablePath: path.join(root, "program-files", "Roomillion.exe"), packaged: true });
  assert.equal(await location.resolveStartup(), path.join(profileRoot, "mvp-data"));
});


test("a blocked migration keeps the original rooms available", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-move-fallback-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const options = { profileRoot: path.join(root, "profile"), executablePath: path.join(root, "dev", "electron.exe"), packaged: false };
  const location = new RoomStorageLocation(options);
  const source = await location.resolveStartup();
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, "registry.json"), '{"rooms":{}}');
  const targetParent = path.join(root, "target");
  await fsp.mkdir(targetParent);
  const { target } = await location.scheduleMove(source, targetParent);
  await fsp.mkdir(target);
  await fsp.writeFile(path.join(target, "other.txt"), "do not overwrite");
  const restart = new RoomStorageLocation(options);
  assert.equal(await restart.resolveStartup(), source);
  assert.match(restart.warning, /迁移失败/);
  assert.equal(await fsp.readFile(path.join(target, "other.txt"), "utf8"), "do not overwrite");
  assert.equal(await fsp.readFile(path.join(source, "registry.json"), "utf8"), '{"rooms":{}}');
});
