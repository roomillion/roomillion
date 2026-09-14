"use strict";

const {
  consumeTargetVector,
  createSourceVector,
  runtimeLabel,
  verifyReturnVector
} = require("./migration-vector.cjs");

function usage() {
  process.stderr.write(`用法：
  migration-cli.cjs create-source --room <zroom> --output <新目录> [--label win32-x64]
  migration-cli.cjs target --input <源向量目录> --output <新目录> [--label linux-x64]
  migration-cli.cjs verify-return --source <源向量目录> --input <回传目录> [--report <新JSON>] [--label win32-x64]
`);
  process.exitCode = 2;
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!/^--(?:room|output|input|source|report|label)$/.test(key ?? "") || typeof value !== "string") return null;
    if (Object.hasOwn(options, key)) return null;
    options[key] = value;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  if (!options) return usage();
  const label = options["--label"] ?? runtimeLabel();
  if (command === "create-source" && options["--room"] && options["--output"]) {
    const result = await createSourceVector({
      roomPackagePath: options["--room"],
      outputRoot: options["--output"],
      sourceRuntime: label
    });
    process.stdout.write(`MIGRATION_SOURCE_CREATED ${JSON.stringify({ outputRoot: result.outputRoot, reused: result.reused, vector: result.vector })}\n`);
    return;
  }
  if (command === "target" && options["--input"] && options["--output"]) {
    const result = await consumeTargetVector({
      inputRoot: options["--input"],
      outputRoot: options["--output"],
      targetRuntime: label
    });
    process.stdout.write(`MIGRATION_TARGET_PASS ${JSON.stringify({ outputRoot: result.outputRoot, report: result.report })}\n`);
    return;
  }
  if (command === "verify-return" && options["--source"] && options["--input"]) {
    const result = await verifyReturnVector({
      sourceRoot: options["--source"],
      returnRoot: options["--input"],
      reportPath: options["--report"],
      returnRuntime: label
    });
    process.stdout.write(`MIGRATION_RETURN_PASS ${JSON.stringify(result.report)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`MIGRATION_FAILED ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseOptions };
