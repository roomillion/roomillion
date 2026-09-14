"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { snapshotProject, projectSummary, readProjectFile, migrationNotices, LIMITS } = require("../src/main/project-source.cjs");

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "project-source-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "index.html"), "<main><h1>Counter</h1></main>");
  return root;
}

test("source snapshot excludes secrets, dependencies and binary data; public summary contains no source or absolute path", async t => {
  const root = await fixture(t);
  for (const name of [".git", "node_modules", "data"]) {
    await fsp.mkdir(path.join(root, name));
    await fsp.writeFile(path.join(root, name, "private.js"), "do not read");
  }
  await fsp.writeFile(path.join(root, ".env"), "password=private");
  await fsp.writeFile(path.join(root, "config.js"), 'const apiKey = "not-a-real-key-for-this-unit-test"');
  await fsp.writeFile(path.join(root, "app.js"), "const counter = 0;");
  await fsp.writeFile(path.join(root, "binary.txt"), Buffer.from([0, 1, 2, 3]));
  await fsp.writeFile(path.join(root, "LICENSE"), "Example permission and copyright text");
  const source = await snapshotProject(root);
  assert.deepEqual(source.files.map(file => file.path).sort(), ["LICENSE", "app.js", "binary.txt", "index.html"].sort());
  assert.equal(source.files.find(file => file.path === "binary.txt").readable, false);
  assert.equal(source.skipped.sensitive, 1);
  const summary = projectSummary(source);
  assert.equal(JSON.stringify(summary).includes("const counter"), false);
  assert.equal(JSON.stringify(source).includes(root), false);
  assert.deepEqual(summary.notices, ["LICENSE"]);
  assert.equal((await migrationNotices(source, {}, "adapt")).notices[0].content, "Example permission and copyright text");
});

test("snapshot rejects links and source read accepts only snapshot paths with bounded paging", async t => {
  const root = await fixture(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "source-outside-test-"));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, "escape.js"), "outside-secret");
  await fsp.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await fsp.link(path.join(outside, "escape.js"), path.join(root, "hardlink.js"));
  await fsp.writeFile(path.join(root, "app.js"), "x".repeat(LIMITS.readChars + 20));
  const source = await snapshotProject(root);
  assert.equal(source.files.some(file => /link|escape/.test(file.path)), false);
  await assert.rejects(snapshotProject(path.join(root, "linked")), /符号链接|目录联接/);
  await assert.rejects(readProjectFile(source, "../escape.js"), /清单/);
  await assert.rejects(readProjectFile(source, "app.js", -1), /偏移/);
  assert.equal((await readProjectFile(source, "app.js")).eof, false);
  assert.equal((await readProjectFile(source, "app.js", LIMITS.readChars)).content.length, 20);
  await fsp.writeFile(path.join(root, "app.js"), "changed after import");
  assert.equal((await readProjectFile(source, "app.js")).content, "x".repeat(LIMITS.readChars));
});

test("project assessment maps installed libraries and surfaces backend and external dependency limitations", async t => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { three: "^0.180.0", express: "^5.0.0" } }));
  await fsp.writeFile(path.join(root, "server.py"), "from flask import Flask");
  const result = projectSummary(await snapshotProject(root));
  assert.ok(result.dependencies.find(item => item.name === "three").hostModules.some(item => item.id === "graphics.three@1" && item.version));
  assert.deepEqual(result.dependencies.find(item => item.name === "express").hostModules, []);
  assert.ok(result.warnings.some(warning => /非浏览器语言/.test(warning)));
  assert.ok(result.warnings.some(warning => /非内置依赖/.test(warning)));
});

test("large and non-UTF8 files remain in the complete pageable index", async t => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, "large.js"), "x".repeat(300_000));
  await fsp.writeFile(path.join(root, "legacy.txt"), Buffer.from([0xff, 0xfe, 0xff]));
  const source = await snapshotProject(root);
  assert.equal(source.complete, true);
  assert.equal(source.files.find(file => file.path === "large.js").readable, true);
  assert.equal(source.files.find(file => file.path === "legacy.txt").readable, false);
  const first = projectSummary(source, { pageSize: 1 });
  assert.equal(first.files.length, 1);
  assert.equal(typeof first.nextCursor, "number");
  assert.equal((await readProjectFile(source, "large.js", 262_144)).content.length, 37_856);
});
