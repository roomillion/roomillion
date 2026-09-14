"use strict";

const path = require("node:path");

const SUPPORTED_RUNTIME_TARGETS = Object.freeze({
  "win32-x64": Object.freeze({
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    status: "supported",
    gitDirectory: "mingit",
    gitExecutable: ["cmd", "git.exe"],
    gitPathEntries: [["cmd"], ["mingw64", "bin"], ["usr", "bin"]],
    gitExecPath: ["mingw64", "libexec", "git-core"],
    gitTemplatePath: ["mingw64", "share", "git-core", "templates"],
    metadataPath: ["mingit-metadata.json"],
    nullDevice: "NUL",
    pathDelimiter: ";",
    displayName: "MinGit"
  }),
  "linux-x64": Object.freeze({
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    status: "technical-preview",
    gitDirectory: "git-linux-x64",
    gitExecutable: ["bin", "git"],
    gitPathEntries: [["bin"], ["libexec", "git-core"]],
    gitExecPath: ["libexec", "git-core"],
    gitTemplatePath: ["share", "git-core", "templates"],
    metadataPath: ["git-linux-x64", "metadata.json"],
    libraryPaths: [["lib"], ["lib64"]],
    nullDevice: "/dev/null",
    pathDelimiter: ":",
    displayName: "Linux Git"
  })
});

function getRuntimeTarget(platform = process.platform, arch = process.arch) {
  const target = SUPPORTED_RUNTIME_TARGETS[`${platform}-${arch}`];
  if (!target) {
    throw new Error(`千万间 Roomillion暂不支持当前平台：${platform}-${arch}`);
  }
  return target;
}

function getResourcesRoot({ isPackaged, resourcesPath, appPath }) {
  if (isPackaged) {
    if (typeof resourcesPath !== "string" || !resourcesPath) throw new Error("打包资源目录无效");
    return path.resolve(resourcesPath);
  }
  if (typeof appPath !== "string" || !appPath) throw new Error("应用源码目录无效");
  return path.resolve(appPath, "resources");
}

function resolveBundledGit(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = getRuntimeTarget(platform, arch);
  const resourcesRoot = getResourcesRoot(options);
  const toolchainsRoot = path.join(resourcesRoot, "toolchains");
  const toolchainRoot = path.join(toolchainsRoot, target.gitDirectory);
  const joinFromRoot = (segments) => path.join(toolchainRoot, ...segments);

  return Object.freeze({
    targetId: target.id,
    platform: target.platform,
    arch: target.arch,
    status: target.status,
    displayName: target.displayName,
    executable: joinFromRoot(target.gitExecutable),
    toolchainRoot,
    pathEntries: target.gitPathEntries.map(joinFromRoot),
    gitExecPath: joinFromRoot(target.gitExecPath),
    gitTemplatePath: joinFromRoot(target.gitTemplatePath),
    libraryPaths: (target.libraryPaths ?? []).map(joinFromRoot),
    metadataPath: path.join(toolchainsRoot, ...target.metadataPath),
    nullDevice: target.nullDevice,
    pathDelimiter: target.pathDelimiter
  });
}

function createLegacyWindowsGitDescriptor(gitExecutable) {
  const executable = path.resolve(gitExecutable);
  const toolchainRoot = path.resolve(executable, "..", "..");
  return Object.freeze({
    targetId: "win32-x64",
    platform: "win32",
    arch: "x64",
    status: "legacy",
    displayName: "MinGit",
    executable,
    toolchainRoot,
    pathEntries: [
      path.join(toolchainRoot, "cmd"),
      path.join(toolchainRoot, "mingw64", "bin"),
      path.join(toolchainRoot, "usr", "bin")
    ],
    gitExecPath: path.join(toolchainRoot, "mingw64", "libexec", "git-core"),
    gitTemplatePath: path.join(toolchainRoot, "mingw64", "share", "git-core", "templates"),
    libraryPaths: [],
    metadataPath: path.join(toolchainRoot, "..", "mingit-metadata.json"),
    nullDevice: "NUL",
    pathDelimiter: ";"
  });
}

module.exports = {
  SUPPORTED_RUNTIME_TARGETS,
  createLegacyWindowsGitDescriptor,
  getResourcesRoot,
  getRuntimeTarget,
  resolveBundledGit
};
