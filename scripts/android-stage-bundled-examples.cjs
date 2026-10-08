"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// Only public examples with Android room-host coverage belong in the APK.
const examples = [
  "inventory",
  "meeting-actions",
  "ai-debate",
  "ai-model-benchmark",
  "audio-analysis",
  "document-workbench"
];

async function main() {
  const root = path.resolve(__dirname, "..");
  const source = path.join(root, "resources", "examples");
  const output = path.join(root, "android", "app", "build", "generated", "androidAssets", "examples");
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const name of examples) {
    const file = `${name}.room`;
    await fs.copyFile(path.join(source, file), path.join(output, file));
  }
  console.log(`ANDROID_BUNDLED_EXAMPLES_OK ${examples.length}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
