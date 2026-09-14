"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest, validateRelativePackagePath } = require("../src/main/manifest.cjs");

function validManifest() {
  return {
    formatVersion: "0.1",
    id: "cn.zhibian.test",
    name: "测试房间",
    version: "1.0.0",
    runtime: { roomSdk: "1", minimumWorkbench: "0.1.0" },
    entry: "app/index.html",
    permissions: { database: "private", files: ["pick", "export", "largeText"], network: [] },
    hostModules: []
  };
}

test("manifest accepts the MVP contract", () => {
  const manifest = validateManifest(validManifest());
  assert.equal(manifest.id, "cn.zhibian.test");
  assert.equal(manifest.permissions.database, "private");
});

test("manifest accepts only reviewed file permissions", () => {
  const supported = validManifest();
  assert.deepEqual(validateManifest(supported).permissions.files, ["pick", "export", "largeText"]);
  const unknown = validManifest();
  unknown.permissions.files.push("filesystem");
  assert.throws(() => validateManifest(unknown), /不支持的文件权限/);
});

test("manifest accepts only exact bounded HTTP service origins", () => {
  const manifest = validManifest();
  manifest.permissions.network = ["https://example.com/", "http://intranet:8080"];
  assert.deepEqual(validateManifest(manifest).permissions.network, ["https://example.com", "http://intranet:8080"]);
  for (const origin of [
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://example.com/private",
    "https://example.com?token=secret",
    "http://0.0.0.0:8000"
  ]) {
    const invalid = validManifest();
    invalid.permissions.network = [origin];
    assert.throws(() => validateManifest(invalid), /联网|服务源|网络/);
  }
  const duplicate = validManifest();
  duplicate.permissions.network = ["https://example.com", "https://example.com/"];
  assert.throws(() => validateManifest(duplicate), /重复/);
});

test("manifest accepts only reviewed browser permissions and their dependency", () => {
  const supported = validManifest();
  supported.permissions.browser = ["navigate", "download"];
  assert.deepEqual(validateManifest(supported).permissions.browser, ["navigate", "download"]);

  const duplicate = validManifest();
  duplicate.permissions.browser = ["navigate", "navigate"];
  assert.deepEqual(validateManifest(duplicate).permissions.browser, ["navigate"]);

  const unknown = validManifest();
  unknown.permissions.browser = ["extensions"];
  assert.throws(() => validateManifest(unknown), /不支持的浏览器权限/);

  const downloadOnly = validManifest();
  downloadOnly.permissions.browser = ["download"];
  assert.throws(() => validateManifest(downloadOnly), /同时声明 navigate/);
});

test("manifest rejects unsafe paths and identifiers", () => {
  assert.throws(() => validateRelativePackagePath("../secret.txt", "path"), /安全/);
  assert.throws(() => validateRelativePackagePath("C:/secret.txt", "path"), /安全/);
  assert.throws(() => validateRelativePackagePath("app/.git/config", "path"), /安全/);
  assert.throws(() => validateRelativePackagePath("app/CON.txt", "path"), /安全/);
  assert.throws(() => validateRelativePackagePath("app/file:stream", "path"), /安全/);
  const manifest = validManifest();
  manifest.id = "Bad Room";
  assert.throws(() => validateManifest(manifest), /小写字母/);
});

test("manifest validates publisher identity before displaying it", () => {
  const manifest = validManifest();
  manifest.publisher = { id: "Bad Publisher", name: "发布者" };
  assert.throws(() => validateManifest(manifest), /publisher\.id/);
});

test("manifest accepts only reviewed host modules and enforces module dependencies", () => {
  const supported = validManifest();
  supported.hostModules = ["security.sanitize@1", "document.markdown@1"];
  assert.deepEqual(validateManifest(supported).hostModules, supported.hostModules);

  const unknown = validManifest();
  unknown.hostModules = ["npm.anything@1"];
  assert.throws(() => validateManifest(unknown), /不支持的宿主模块/);

  const duplicate = validManifest();
  duplicate.hostModules = ["data.csv@1", "data.csv@1"];
  assert.throws(() => validateManifest(duplicate), /重复模块/);

  const missingDependency = validManifest();
  missingDependency.hostModules = ["document.markdown@1"];
  assert.throws(() => validateManifest(missingDependency), /需要同时声明 security\.sanitize@1/);
});

test("manifest validates exact and fully declared embedded dependency metadata", () => {
  const manifest = validManifest();
  manifest.embeddedDependencies = [{
    id: "npm.tiny-helper",
    package: "tiny-helper",
    version: "1.2.3",
    license: "MIT",
    source: "npm:tiny-helper@1.2.3",
    root: "embedded/npm.tiny-helper",
    licenseFile: "embedded/npm.tiny-helper/LICENSE.txt",
    files: ["embedded/npm.tiny-helper/LICENSE.txt", "embedded/npm.tiny-helper/index.js"],
    entrypoints: ["embedded/npm.tiny-helper/index.js"]
  }];
  assert.equal(validateManifest(manifest).embeddedDependencies[0].version, "1.2.3");

  const floating = structuredClone(manifest);
  floating.embeddedDependencies[0].version = "^1.2.3";
  assert.throws(() => validateManifest(floating), /固定精确版本/);

  const missingLicense = structuredClone(manifest);
  missingLicense.embeddedDependencies[0].files = ["embedded/npm.tiny-helper/index.js"];
  assert.throws(() => validateManifest(missingLicense), /未登记许可证文件/);
});

test("manifest validates sharing options for AI modification", () => {
  const without = validManifest();
  assert.equal(validateManifest(without).sharing, undefined);

  const allowed = validManifest();
  allowed.sharing = { allowAiModification: true };
  assert.equal(validateManifest(allowed).sharing.allowAiModification, true);

  const explicitOff = validManifest();
  explicitOff.sharing = { allowAiModification: false };
  assert.equal(validateManifest(explicitOff).sharing.allowAiModification, false);

  const truthyString = validManifest();
  truthyString.sharing = { allowAiModification: "yes" };
  assert.throws(() => validateManifest(truthyString), /sharing\.allowAiModification 必须是布尔值/);

  const unknownKey = validManifest();
  unknownKey.sharing = { allowAiModification: true, redistribute: true };
  assert.throws(() => validateManifest(unknownKey), /不支持的分享选项字段/);

  const nonObject = validManifest();
  nonObject.sharing = true;
  assert.throws(() => validateManifest(nonObject), /sharing 必须是对象/);
});
