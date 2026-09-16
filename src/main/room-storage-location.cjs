"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_FOLDER = "Roomillion-data";

function dataRootForSelection(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("请选择有效的绝对目录");
  const selected = path.resolve(directory);
  return path.basename(selected).toLowerCase() === DATA_FOLDER.toLowerCase() ? selected : path.join(selected, DATA_FOLDER);
}

function overlaps(left, right) {
  const a = path.resolve(left).toLowerCase();
  const b = path.resolve(right).toLowerCase();
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

async function exists(target) {
  try { await fsp.stat(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

class RoomStorageLocation {
  constructor({ profileRoot, executablePath, packaged, portableFolder = false, portableExecutableDir = null, pickDirectory = null }) {
    this.profileRoot = path.resolve(profileRoot);
    this.executablePath = path.resolve(executablePath);
    this.packaged = packaged === true;
    this.portableFolder = portableFolder === true;
    this.portableExecutableDir = portableExecutableDir;
    this.pickDirectory = pickDirectory;
    this.configPath = path.join(this.profileRoot, "room-storage-location.json");
    this.warning = null;
  }

  async readConfig() {
    try {
      const value = JSON.parse(await fsp.readFile(this.configPath, "utf8"));
      if (value?.version !== 1 || (value.dataRoot && !path.isAbsolute(value.dataRoot))) throw new Error("房间位置配置无效");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeConfig(value) {
    await fsp.mkdir(this.profileRoot, { recursive: true });
    const temporary = `${this.configPath}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, this.configPath);
  }

  async prepareTarget(target, source, { reuseExisting = false } = {}) {
    const destination = path.resolve(target);
    const original = path.resolve(source);
    if (destination === original) return destination;
    if (overlaps(destination, original)) throw new Error("新目录不能包含当前数据目录，也不能位于当前数据目录内部");
    if (await exists(destination)) {
      const stat = await fsp.stat(destination);
      if (!stat.isDirectory()) throw new Error("目标位置不是文件夹");
      if (reuseExisting && await exists(path.join(destination, "registry.json"))) return destination;
      if ((await fsp.readdir(destination)).length) throw new Error("目标房间目录已有文件，请选择空文件夹或现有的 Roomillion-data");
      await fsp.rmdir(destination);
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    if (!(await exists(original))) {
      await fsp.mkdir(destination);
      return destination;
    }
    const staging = path.join(path.dirname(destination), `.${DATA_FOLDER}.copy-${crypto.randomUUID()}`);
    try {
      await fsp.cp(original, staging, { recursive: true, force: false, errorOnExist: true });
      await fsp.rename(staging, destination);
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return destination;
  }

  async resolveStartup() {
    const legacyRoot = path.join(this.profileRoot, "mvp-data");
    const config = await this.readConfig();
    if (config?.pending) {
      const { source, target } = config.pending;
      if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error("待迁移的房间路径无效");
      try {
        await this.prepareTarget(target, source);
        await this.writeConfig({ dataRoot: target });
        return target;
      } catch (error) {
        this.warning = `房间目录迁移失败，已继续使用原目录：${error.message}`;
        await this.writeConfig({ dataRoot: source });
        return source;
      }
    }
    if (config?.dataRoot) {
      if (!(await exists(config.dataRoot))) throw new Error(`已设置的房间目录不存在：${config.dataRoot}`);
      return path.resolve(config.dataRoot);
    }
    if (!this.packaged) return legacyRoot;
    if (this.portableExecutableDir) {
      if (!this.pickDirectory) throw new Error("单文件便携版缺少首次目录选择器");
      const selected = await this.pickDirectory(path.resolve(this.portableExecutableDir));
      if (!selected) return null;
      const target = dataRootForSelection(selected);
      await this.prepareTarget(target, legacyRoot, { reuseExisting: true });
      await this.writeConfig({ dataRoot: target });
      return target;
    }
    if (!this.portableFolder) return legacyRoot;
    const target = path.join(path.dirname(this.executablePath), DATA_FOLDER);
    await this.prepareTarget(target, legacyRoot, { reuseExisting: true });
    return target;
  }

  async scheduleMove(currentRoot, selectedDirectory) {
    const source = path.resolve(currentRoot);
    const target = dataRootForSelection(selectedDirectory);
    if (source.toLowerCase() === target.toLowerCase()) return { changed: false, target };
    if (overlaps(source, target)) throw new Error("新目录不能包含当前数据目录，也不能位于当前数据目录内部");
    if (await exists(target) && (await fsp.readdir(target)).length) throw new Error("目标房间目录已有文件，请选择空文件夹");
    await this.writeConfig({ dataRoot: source, pending: { source, target } });
    return { changed: true, target, restartRequired: true };
  }
}

module.exports = { RoomStorageLocation, dataRootForSelection, DATA_FOLDER };
