"use strict";

module.exports = {
  appId: "io.roomillion.desktop",
  productName: "千万间 Roomillion",
  directories: {
    output: "release/linux",
    buildResources: "build"
  },
  files: [
    "src/**/*",
    "package.json",
    "LICENSE",
    "NOTICE",
    "THIRD-PARTY-NOTICES.md"
  ],
  asar: true,
  electronDist: "node_modules/electron/dist",
  extraResources: [
    {
      from: "resources/examples",
      to: "examples",
      filter: ["*.room"]
    },
    {
      from: "resources/toolchains/git-linux-x64",
      to: "toolchains/git-linux-x64"
    },
    {
      from: "resources/compliance",
      to: "compliance"
    },
    {
      from: "resources/room-modules",
      to: "room-modules"
    }
  ],
  linux: {
    target: ["dir"],
    category: "Utility",
    executableName: "roomillion",
    syncDesktopName: true,
    artifactName: "Roomillion-${version}-linux-${arch}.${ext}"
  },
  appImage: {
    artifactName: "Roomillion-${version}-${arch}.AppImage"
  }
};
