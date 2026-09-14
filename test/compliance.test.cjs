"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const compliance = path.join(root, "resources", "compliance");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("Apache project terms are scoped and included in Windows/Linux packaging", async () => {
  const pkg = require("../package.json");
  const lock = require("../package-lock.json");
  const linux = require("../build/electron-builder.linux.cjs");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(lock.packages[""].license, pkg.license);
  const license = await fsp.readFile(path.join(root, "LICENSE"), "utf8");
  assert.match(license, /Apache License[\s\S]*Version 2.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match(license, /Grant of Patent License/);
  assert.doesNotMatch(license, /Dimforge/);
  for (const config of [pkg.build, linux]) {
    for (const name of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"]) assert.ok(config.files.includes(name));
    assert.ok(config.extraResources.some(item => item.from === "resources/compliance"));
  }
  for (const name of ["LICENSE", "NOTICE"]) assert.deepEqual(await fsp.readFile(path.join(root, name)), await fsp.readFile(path.join(compliance, name)));
  assert.match(await fsp.readFile(path.join(root, "NOTICE"), "utf8"), /original licenses[\s\S]*continue to apply/);
});

test("all inventoried dependency notices retain their original bytes and valid local links", async () => {
  const inventory = JSON.parse(await fsp.readFile(path.join(compliance, "license-inventory.json"), "utf8"));
  const sbom = JSON.parse(await fsp.readFile(path.join(compliance, "sbom.cdx.json"), "utf8"));
  assert.deepEqual(inventory.records.map(item => item.component).sort(), sbom.components.map(item => item["bom-ref"]).sort());
  assert.equal(sbom.metadata.component.licenses[0].license.id, "Apache-2.0");
  for (const record of [...inventory.records, ...inventory.distributions]) {
    for (const file of record.files) {
      assert.ok(file.path.startsWith("licenses/") && !file.path.split("/").includes(".."));
      const bytes = await fsp.readFile(path.join(compliance, file.path));
      assert.equal(bytes.length, file.bytes, file.path);
      assert.equal(hash(bytes), file.sha256, file.path);
      assert.deepEqual(bytes, await fsp.readFile(path.join(root, file.source)), file.path);
    }
  }
  const index = await fsp.readFile(path.join(compliance, "THIRD-PARTY-LICENSES.md"), "utf8");
  for (const match of index.matchAll(/\]\(([^)]+)\)/g)) await fsp.access(path.join(compliance, decodeURIComponent(match[1])));
});

test("upstream supplements are pinned and missing licenses are explicitly reported", async () => {
  const sources = require("../scripts/license-evidence/sources.json");
  for (const item of Object.values(sources)) assert.equal(hash(await fsp.readFile(path.join(root, item.file))), item.sha256);
  const inventory = JSON.parse(await fsp.readFile(path.join(compliance, "license-inventory.json"), "utf8"));
  const review = await fsp.readFile(path.join(compliance, "LICENSE-REVIEW.md"), "utf8");
  for (const ref of inventory.missingOriginalLicenseFiles) assert.ok(review.includes(ref), ref);
  const piVersion = require("../package.json").dependencies["@earendil-works/pi-ai"];
  const pi = inventory.records.find(item => item.component === `@earendil-works/pi-ai@${piVersion}`);
  assert.equal(pi.status, "original-files-collected");
  assert.ok(pi.licenseEvidence.source.includes(`v${piVersion}/LICENSE`));
  assert.match(await fsp.readFile(path.join(root, pi.licenseEvidence.file), "utf8"), /Copyright \(c\) 2025 Mario Zechner/);
});

test("fontkit uses its own evidence instead of an unrelated pdf-lib copyright", async () => {
  const catalog = require("../src/main/room-module-catalog.cjs").ROOM_MODULE_CATALOG;
  const fontkit = catalog.find(item => item.packageName === "@pdf-lib/fontkit");
  assert.equal(fontkit.licenseSource, "README.md");
  assert.equal(fontkit.licenseEvidenceOnly, true);
  const moduleRoot = path.join(root, "resources", "room-modules", fontkit.id);
  await assert.rejects(fsp.access(path.join(moduleRoot, "LICENSE.txt")), { code: "ENOENT" });
  assert.deepEqual(await fsp.readFile(path.join(moduleRoot, "LICENSE-EVIDENCE.md")), await fsp.readFile(path.join(root, "node_modules", "@pdf-lib", "fontkit", "README.md")));
  assert.match(await fsp.readFile(path.join(moduleRoot, "NOTICE.txt"), "utf8"), /not a replacement license/);
});
