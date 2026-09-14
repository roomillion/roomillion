"use strict";

const { ROOM_MODULE_CATALOG } = require("./room-module-catalog.cjs");

const REVIEWED_EMBEDDED_LICENSES = Object.freeze(new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unlicense"
]));

const OFFICIAL_MODULE_BY_PACKAGE = new Map(
  ROOM_MODULE_CATALOG.map((module) => [module.packageName, module])
);

function getOfficialModuleForPackage(packageName) {
  return OFFICIAL_MODULE_BY_PACKAGE.get(packageName) ?? null;
}

function isReviewedEmbeddedLicense(license) {
  return REVIEWED_EMBEDDED_LICENSES.has(license);
}

function classifyRoomDependency({ packageName, license } = {}) {
  const officialModule = getOfficialModuleForPackage(packageName);
  if (officialModule) {
    return Object.freeze({
      kind: "host-module",
      packageName,
      hostModule: officialModule.id,
      bundled: false,
      reason: "workbench-provided"
    });
  }
  return Object.freeze({
    kind: "embedded",
    packageName,
    bundled: true,
    licenseReviewed: isReviewedEmbeddedLicense(license),
    reason: "not-in-workbench-catalog"
  });
}

module.exports = {
  REVIEWED_EMBEDDED_LICENSES,
  classifyRoomDependency,
  getOfficialModuleForPackage,
  isReviewedEmbeddedLicense
};
