"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const esbuild = require("esbuild");
const { ROOM_MODULE_CATALOG } = require("../src/main/room-module-catalog.cjs");

const selected = [
  "data.date@1", "data.decimal@1", "data.csv@1", "data.search@1",
  "ui.chart@1", "security.sanitize@1", "document.markdown@1", "archive.zip@1",
  "utility.qrcode@1", "document.spreadsheet@1", "document.pdf.view@1",
  "document.word.write@1", "document.word.read@1", "document.word.preview@1"
];
const catalog = new Map(ROOM_MODULE_CATALOG.map((item) => [item.id, item]));
const root = path.resolve(__dirname, "..");
const output = path.join(root, "android", "app", "build", "generated", "androidAssets", "android-modules");

async function main() {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const id of selected) {
    const item = catalog.get(id);
    if (!item) throw new Error(`Unknown official module: ${id}`);
    const source = path.join(root, "resources", "room-modules", id);
    await fs.access(path.join(source, "LICENSE.txt"));
    await fs.cp(source, path.join(output, id), { recursive: true });
    for (const asset of item.assets) await fs.access(path.join(output, id, asset.publicName));
    if (id === "document.pdf.view@1") {
      const compatibility = await fs.readFile(path.join(__dirname, "android-pdf-runtime-compat.js"), "utf8");
      for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
        const module = path.join(output, id, name);
        const legacy = path.join(root, "node_modules", "pdfjs-dist", "legacy", "build", name);
        const source = await fs.readFile(legacy, "utf8");
        const transformed = await esbuild.transform(source, { target: "chrome80", format: "esm", legalComments: "inline" });
        if (transformed.warnings.length) throw new Error(`PDF 兼容构建告警：${transformed.warnings[0].text}`);
        await fs.writeFile(module, `${compatibility}\n${transformed.code}`);
      }
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
