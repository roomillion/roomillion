"use strict";

const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  win: {
    ...packageJson.build.win,
    target: ["nsis"]
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    artifactName: "Roomillion-${version}-Setup.${ext}",
    include: "build/installer.nsh"
  }
};
