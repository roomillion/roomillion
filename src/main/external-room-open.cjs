"use strict";

const path = require("node:path");

const ROOM_PACKAGE_EXTENSIONS = new Set([".room", ".zroom"]);

function roomPackagePathsFromArguments(argumentsList, workingDirectory = process.cwd()) {
  const seen = new Set();
  const paths = [];
  for (const argument of argumentsList || []) {
    if (typeof argument !== "string" || !ROOM_PACKAGE_EXTENSIONS.has(path.extname(argument).toLowerCase())) continue;
    const resolved = path.resolve(workingDirectory, argument);
    if (!seen.has(resolved)) { seen.add(resolved); paths.push(resolved); }
  }
  return paths;
}

module.exports = { ROOM_PACKAGE_EXTENSIONS, roomPackagePathsFromArguments };
