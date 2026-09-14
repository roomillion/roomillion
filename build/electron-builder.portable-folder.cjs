"use strict";

const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  artifactName: "Roomillion-${version}-Portable-Folder.${ext}",
  win: {
    ...packageJson.build.win,
    target: ["zip"]
  }
};
