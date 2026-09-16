"use strict";

const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  artifactName: "Roomillion-${version}-Portable-Folder.${ext}",
  extraResources: [
    ...packageJson.build.extraResources,
    { from: "build/portable-folder.marker", to: "portable-folder.marker" }
  ],
  win: {
    ...packageJson.build.win,
    target: ["zip"]
  }
};
