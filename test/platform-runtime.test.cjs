"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { GitService } = require("../src/main/git-service.cjs");
const { getRuntimeTarget, resolveBundledGit } = require("../src/main/platform-runtime.cjs");

test("runtime target matrix rejects unsupported platform and architecture", () => {
  assert.equal(getRuntimeTarget("win32", "x64").status, "supported");
  assert.equal(getRuntimeTarget("linux", "x64").status, "technical-preview");
  assert.throws(() => getRuntimeTarget("linux", "arm64"), /暂不支持当前平台/);
  assert.throws(() => getRuntimeTarget("darwin", "x64"), /暂不支持当前平台/);
});

test("bundled Git resolver uses platform-specific self-contained layouts", () => {
  const windows = resolveBundledGit({
    platform: "win32",
    arch: "x64",
    isPackaged: true,
    resourcesPath: path.resolve("C:/zhibian/resources"),
    appPath: "ignored"
  });
  assert.match(windows.executable, /mingit[\\/]cmd[\\/]git\.exe$/i);
  assert.equal(windows.nullDevice, "NUL");
  assert.equal(windows.pathDelimiter, ";");
  assert.match(windows.gitTemplatePath, /mingw64[\\/]share[\\/]git-core[\\/]templates$/i);

  const linux = resolveBundledGit({
    platform: "linux",
    arch: "x64",
    isPackaged: false,
    appPath: path.resolve("D:/zhibian/source")
  });
  assert.match(linux.executable, /git-linux-x64[\\/]bin[\\/]git$/);
  assert.doesNotMatch(linux.executable, /git\.exe$/i);
  assert.equal(linux.nullDevice, "/dev/null");
  assert.equal(linux.pathDelimiter, ":");
  assert.match(linux.gitTemplatePath, /git-linux-x64[\\/]share[\\/]git-core[\\/]templates$/);
});

test("Git environment is isolated with Linux semantics when using Linux descriptor", async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-linux-git-env-"));
  t.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  const descriptor = resolveBundledGit({
    platform: "linux",
    arch: "x64",
    isPackaged: false,
    appPath: path.join(dataRoot, "app")
  });
  const service = new GitService({ dataRoot }, descriptor);
  const environment = await service.createEnvironment(path.join(dataRoot, "projects", "example"));
  assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.match(environment.PATH, /git-linux-x64/);
  assert.doesNotMatch(environment.PATH, /;/);
  assert.equal(environment.SystemRoot, undefined);
  assert.equal(environment.COMSPEC, undefined);
  assert.match(environment.LD_LIBRARY_PATH, /git-linux-x64/);
  assert.match(environment.GIT_TEMPLATE_DIR, /git-linux-x64/);
});
