"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

class RoomImportLocation {
  constructor(dataRoot) { this.filePath = path.join(path.resolve(dataRoot), "room-import-location.json"); }
  async get() {
    try {
      const value = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      if (typeof value.directory !== "string" || !path.isAbsolute(value.directory)) return null;
      return (await fsp.stat(value.directory)).isDirectory() ? value.directory : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async remember(packagePath) {
    const directory = path.dirname(path.resolve(packagePath));
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(temporary, `${JSON.stringify({ directory })}\n`, "utf8");
    await fsp.rename(temporary, this.filePath);
    return directory;
  }
}

module.exports = { RoomImportLocation };
