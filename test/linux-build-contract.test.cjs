"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const config = require("../build/electron-builder.linux.cjs");
const packageJson = require("../package.json");
const { verifyLinuxToolchain } = require("../scripts/verify-linux-toolchain.cjs");

test("Linux build config packages only the Linux Git toolchain", () => {
  const resources = config.extraResources.map((entry) => `${entry.from}=>${entry.to}`);
  assert.ok(resources.some((entry) => entry.includes("git-linux-x64")));
  assert.equal(resources.some((entry) => entry.toLowerCase().includes("mingit")), false);
  assert.equal(config.linux.executableName, "roomillion");
  assert.deepEqual(config.linux.target, ["dir"]);
});

test("Windows build config packages only MinGit", () => {
  const resources = packageJson.build.extraResources.map((entry) => `${entry.from}=>${entry.to}`);
  assert.ok(resources.some((entry) => entry.toLowerCase().includes("mingit")));
  assert.equal(resources.some((entry) => entry.includes("git-linux-x64")), false);
  assert.equal(packageJson.build.win.signExecutable, false);
  assert.match(packageJson.build.win.icon, /app\.ico$/);
});

test("Linux build preflight fails closed for an intentionally incomplete toolchain", async (t) => {
  const appRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-incomplete-linux-toolchain-"));
  t.after(() => fsp.rm(appRoot, { recursive: true, force: true }));
  const toolchainRoot = path.join(appRoot, "resources", "toolchains", "git-linux-x64");
  await fsp.mkdir(toolchainRoot, { recursive: true });
  await fsp.writeFile(path.join(toolchainRoot, "metadata.json"), JSON.stringify({
    target: "linux-x64",
    status: "awaiting-verified-toolchain",
    version: null,
    source: null,
    gitSha256: null,
    licenseFile: null,
    requiredFiles: ["bin/git"],
    linkage: null
  }), "utf8");
  const report = await verifyLinuxToolchain(appRoot, { executeVersion: false });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((message) => /状态不是 ready/.test(message)));
  assert.ok(report.errors.some((message) => /缺少 bin\/git/.test(message)));
});

test("Linux preparation scripts are offline and system profile avoids direct identity fields", async () => {
  const prepare = await fsp.readFile(path.resolve(__dirname, "..", "scripts", "linux", "prepare-git-toolchain.sh"), "utf8");
  const profile = await fsp.readFile(path.resolve(__dirname, "..", "scripts", "linux", "collect-system-profile.sh"), "utf8");
  const smoke = await fsp.readFile(path.resolve(__dirname, "..", "scripts", "linux", "smoke-toolchain-preparation.sh"), "utf8");
  const bootstrap = await fsp.readFile(path.resolve(__dirname, "..", "scripts", "linux", "bootstrap-build-runtime.sh"), "utf8");
  const buildPreview = await fsp.readFile(path.resolve(__dirname, "..", "scripts", "linux", "build-generic-preview.sh"), "utf8");
  const verifyPilot = await fsp.readFile(path.resolve(__dirname, "..", "scripts", "linux", "verify-pilot.sh"), "utf8");
  const buildAcceptanceKit = await fsp.readFile(path.resolve(__dirname, "..", "scripts", "linux", "build-uos-acceptance-kit.sh"), "utf8");
  const runAcceptance = await fsp.readFile(path.resolve(__dirname, "..", "pilot", "uos", "run-uos-acceptance.sh"), "utf8");
  assert.doesNotMatch(prepare, /\b(?:apt|apt-get|yum|dnf|pacman)\s+(?:install|update|upgrade)\b/);
  assert.doesNotMatch(prepare, /curl|wget/);
  assert.match(prepare, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(prepare, /GIT_TEMPLATE_DIR=/);
  assert.doesNotMatch(profile, /\bhostname\b\s*\$\(|\bwhoami\b/);
  assert.match(profile, /"hostnameCollected": false/);
  assert.match(profile, /"fuse2Library":/);
  assert.match(smoke, /prepare-git-toolchain\.sh/);
  assert.match(smoke, /ACTUAL_SHA256/);
  assert.match(bootstrap, /NODE_SHA256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2/);
  assert.match(buildPreview, /npm ci --offline/);
  assert.match(buildPreview, /--linux dir tar\.xz/);
  assert.match(buildPreview, /electron-v44\.0\.0-linux-x64-dist\.tar\.xz/);
  assert.match(buildPreview, /node_modules\/electron\/install\.js/);
  assert.match(buildPreview, /ELECTRON_BUILDER_CACHE/);
  assert.match(buildPreview, /127\.0\.0\.1:9/);
  assert.match(buildPreview, /--exclude='\.\/docs'/);
  assert.match(verifyPilot, /--appimage-extract/);
  assert.match(verifyPilot, /APPDIR=/);
  assert.match(verifyPilot, /REPORT_DESTINATION/);
  assert.doesNotMatch(verifyPilot, /--no-sandbox/);
  assert.match(buildAcceptanceKit, /SHA256SUMS\.txt/);
  assert.match(buildAcceptanceKit, /package\.json/);
  assert.match(buildAcceptanceKit, /STAGE_ROOT\/VERSION/);
  assert.doesNotMatch(buildAcceptanceKit, /PROJECT_ROOT\/docs\//);
  assert.match(buildAcceptanceKit, /migration-data\.zdata/);
  assert.match(buildAcceptanceKit, /sha256sum "\$\{KIT_NAME\}\.tar\.xz"/);
  assert.match(runAcceptance, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(runAcceptance, /KIT_ROOT\/VERSION/);
  assert.match(runAcceptance, /automated-summary\.json/);
  assert.match(runAcceptance, /migration-return/);
  assert.doesNotMatch(runAcceptance, /\b(?:sudo|apt|apt-get|yum|dnf)\b/);
  assert.doesNotMatch(runAcceptance, /--no-sandbox/);
});
