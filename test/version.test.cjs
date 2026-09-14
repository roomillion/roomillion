"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { nextBuildVersion } = require("../scripts/bump-version.cjs");
const packageJson = require("../package.json");

test("release version increments deterministically without ad-hoc artifact names", () => {
  assert.equal(packageJson.name, "roomillion");
  assert.equal(packageJson.desktopName, "roomillion");
  assert.equal(packageJson.build.appId, "io.roomillion.desktop");
  assert.equal(packageJson.build.productName, "千万间 Roomillion");
  assert.equal(packageJson.build.extraResources[0].filter[0], "*.room");
  assert.match(packageJson.build.portable.artifactName, /^Roomillion-/);
  assert.equal(nextBuildVersion("0.3.0-alpha.1"), "0.3.0-alpha.2");
  assert.equal(nextBuildVersion("0.3.0-beta.9"), "0.3.0-beta.10");
  assert.equal(nextBuildVersion("1.2.3"), "1.2.4");
  assert.throws(() => nextBuildVersion("dev-latest"), /无法自动递增版本号/);
  assert.equal(packageJson.scripts["predist:portable"], "npm run version:next");
  assert.match(packageJson.scripts["dist:portable"], /build:resources/);
  assert.match(packageJson.scripts["dist:portable-folder"], /build:resources/);
  assert.match(packageJson.scripts["build:portable-folder"], /electron-builder\.portable-folder\.cjs/);
  assert.match(packageJson.scripts["build:installer"], /electron-builder\.installer\.cjs/);
  assert.match(packageJson.scripts["dist:installer"], /build:resources/);
  assert.equal(packageJson.scripts["release:portable"], "npm run dist:portable");
  const folderConfig = fs.readFileSync(path.join(__dirname, "..", "build", "electron-builder.portable-folder.cjs"), "utf8");
  assert.match(folderConfig, /Portable-Folder/);
  assert.match(folderConfig, /target: \["zip"\]/);
  const installerConfig = require(path.join(__dirname, "..", "build", "electron-builder.installer.cjs"));
  assert.deepEqual(installerConfig.win.target, ["nsis"]);
  assert.equal(installerConfig.nsis.perMachine, false);
  assert.equal(installerConfig.nsis.oneClick, true);
  assert.equal(installerConfig.nsis.packElevateHelper, false);
  assert.match(installerConfig.nsis.artifactName, /Setup/);
  assert.match(installerConfig.nsis.artifactName, /^Roomillion-/);
  const installerInclude = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"), "utf8");
  assert.match(installerInclude, /HKCU "Software\\Classes\\\.room"/);
  assert.match(installerInclude, /HKCU "Software\\Classes\\\.zroom"/);
  assert.match(installerInclude, /APP_EXECUTABLE_FILENAME/);
  assert.match(installerInclude, /%1/);
});

test("pilot kit follows package version instead of a hard-coded release", () => {
  const buildScript = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-pilot-kit.ps1"), "utf8");
  const verifyScript = fs.readFileSync(path.join(__dirname, "..", "pilot", "verify-pilot.ps1"), "utf8");
  assert.match(buildScript, /package\.json/);
  assert.match(buildScript, /PSBoundParameters\.ContainsKey\("Version"\)/);
  assert.match(verifyScript, /checksumArtifactName/);
  assert.match(verifyScript, /PSBoundParameters\.ContainsKey\("ArtifactName"\)/);
});
