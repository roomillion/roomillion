"use strict";

const path = require("node:path");
const { resolveBundledGit } = require("../src/main/platform-runtime.cjs");

function getTestGitToolchain() {
  const appPath = path.resolve(__dirname, "..");
  return resolveBundledGit({
    platform: process.platform,
    arch: process.arch,
    isPackaged: false,
    appPath
  });
}

module.exports = { getTestGitToolchain };
