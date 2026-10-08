"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { AiService } = require("../src/main/ai-service.cjs");

function chatEndpoint(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl || /[{}]/.test(baseUrl)) return null;
  let url;
  try { url = new URL(baseUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  return `${url.href.replace(/\/+$/, "")}/chat/completions`;
}

async function buildCatalog() {
  // Read the same pinned Pi catalog as the desktop. No profiles or credentials are loaded.
  const catalog = await new AiService(path.resolve(__dirname, "..", "android", "app", "build")).getProviderCatalog();
  const providers = [];
  for (const provider of catalog) {
    // Copilot also needs its own login/header exchange; Android has not implemented it.
    if (!provider.configurable || provider.source !== "pi-builtin" || provider.id === "github-copilot") continue;
    const models = provider.models.filter((model) => model.api === "openai-completions")
      .map((model) => ({ id: model.id, name: model.name, endpoint: chatEndpoint(model.baseUrl || provider.baseUrl), input: model.input }))
      .filter((model) => model.endpoint);
    if (!models.length) continue;
    const defaultModel = models.find((model) => model.id === provider.defaultModel) || models[0];
    providers.push({ id: provider.id, name: provider.displayName, description: provider.description,
      category: provider.categoryLabel, defaultModel: defaultModel.id, endpoint: defaultModel.endpoint, models });
  }
  return { formatVersion: 1, providers };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "android", "app", "build", "generated", "androidAssets", "ai-providers.json");
  const catalog = await buildCatalog();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`);
  const version = JSON.parse(await fs.readFile(path.join(root, "node_modules", "@earendil-works", "pi-ai", "package.json"), "utf8")).version;
  const license = path.join(root, "resources", "compliance", "licenses", "npm", "@earendil-works", "pi-ai", version, "upstream", `pi-${version}-LICENSE`);
  const licenseOutput = path.join(path.dirname(output), "compliance", "pi-ai-LICENSE.txt");
  await fs.mkdir(path.dirname(licenseOutput), { recursive: true });
  await fs.copyFile(license, licenseOutput);
  console.log(`ANDROID_AI_PROVIDERS_OK ${catalog.providers.length} providers, ${catalog.providers.reduce((sum, provider) => sum + provider.models.length, 0)} models`);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { buildCatalog, chatEndpoint };
