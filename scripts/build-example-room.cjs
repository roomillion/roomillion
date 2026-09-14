"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { packDirectory } = require("../src/main/room-package.cjs");
const { EXAMPLE_CATALOG } = require("../src/main/example-catalog.cjs");
const {
  generatedGame3dAppJs,
  generatedGame3dIndexHtml,
  generatedGame3dStyles,
  parseGame3dDefinition
} = require("../src/main/game3d-room.cjs");

async function prepareTemplate(example, sourceRoot) {
  if (example.template !== "game3d") return;
  const appRoot = path.join(sourceRoot, "app");
  const definitionPath = path.join(appRoot, "definition.js");
  const definition = parseGame3dDefinition(await fsp.readFile(definitionPath, "utf8"));
  await fsp.writeFile(path.join(appRoot, "index.html"), generatedGame3dIndexHtml(), "utf8");
  await fsp.writeFile(path.join(appRoot, "styles.css"), generatedGame3dStyles(), "utf8");
  await fsp.writeFile(path.join(appRoot, "app.js"), generatedGame3dAppJs(), "utf8");
  await fsp.writeFile(definitionPath, `window.GAME_DEFINITION = ${JSON.stringify(definition)};\n`, "utf8");
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(projectRoot, "resources", "examples");
  await fsp.mkdir(outputRoot, { recursive: true });
  const currentPackages = new Set(EXAMPLE_CATALOG.map(example => example.packageName.toLowerCase()));
  const stalePackages = (await fsp.readdir(outputRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .filter(entry => {
      const extension = path.extname(entry.name).toLowerCase();
      return extension === ".zroom" || (extension === ".room" && !currentPackages.has(entry.name.toLowerCase()));
    });
  await Promise.all(stalePackages.map(entry => fsp.rm(path.join(outputRoot, entry.name), { force: true })));
  for (const example of EXAMPLE_CATALOG) {
    const sourceRoot = path.join(projectRoot, "examples", example.id);
    await prepareTemplate(example, sourceRoot);
    const outputPath = path.join(outputRoot, example.packageName);
    await packDirectory(sourceRoot, outputPath);
    const stats = await fsp.stat(outputPath);
    console.log(`示例房间已生成：${path.relative(projectRoot, outputPath)} (${stats.size} bytes)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
