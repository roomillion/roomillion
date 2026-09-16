"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { RoomStore } = require("../src/main/room-store.cjs");
const { RoomAgentService } = require("../src/main/room-agent-service.cjs");
const { createRoomRuntimeAiMock } = require("../src/main/room-runtime-ai-mock.cjs");

function preloadApi(source) {
  let api;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {} }
  };
  vm.runInNewContext(source, { require: (name) => name === "electron" ? electron : null });
  return api;
}

test("AI capability directory matches the exposed Room SDK and registered IPC calls", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-sdk-contract-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = await new RoomStore(path.join(root, "data")).init();
  const service = await new RoomAgentService({ roomStore: store, aiService: { getPublicProfile: () => null } }).init();
  t.after(() => service.dispose());
  const session = service.requireSession((await service.createSession()).id);
  const pi = await import("@earendil-works/pi-ai");
  const tool = service.createTools(session, { pi }).find((item) => item.name === "inspect_room_capabilities");
  const result = JSON.parse((await tool.execute("contract", {}, new AbortController().signal)).content[0].text);
  const preload = await fsp.readFile(path.join(__dirname, "../src/preload/room-preload.cjs"), "utf8");
  const api = preloadApi(preload);
  for (const [namespace, listed] of Object.entries(result.policies.sdkMethods)) {
    const actual = namespace === "getInfo" ? [] : Object.keys(api[namespace]);
    assert.deepEqual([...listed].sort(), actual.sort(), `window.room.${namespace}`);
  }
  assert.deepEqual(Object.keys(result.policies.sdkMethods).sort(), Object.keys(api).sort());
  const ipc = await fsp.readFile(path.join(__dirname, "../src/main/ipc.cjs"), "utf8");
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("(room:[^"`]+)"/g)].map((match) => match[1]);
  const handled = new Set([...ipc.matchAll(/handle\("(room:[^"`]+)"/g)].map((match) => match[1]));
  assert.deepEqual(invoked.filter((channel) => !handled.has(channel)), []);
  assert.match(result.policies.aiRuntime.batchResult, /text,model,profileId,usage/);
});

test("isolated AI mocks follow production generate and batch response shapes", () => {
  const mock = createRoomRuntimeAiMock([{ text: "one" }, { text: "two" }]);
  assert.deepEqual(Object.keys(mock.generate()).sort(), ["text", "model", "profileId", "usage"].sort());
  const result = mock.batch([{ prompt: "page 1" }, { prompt: "page 2" }]);
  assert.deepEqual({ total: result.total, passed: result.passed, failed: result.failed }, { total: 2, passed: 1, failed: 1 });
  assert.deepEqual(Object.keys(result.results[0]).sort(), ["ok", "text", "model", "profileId", "usage"].sort());
  assert.deepEqual(Object.keys(result.results[1]).sort(), ["ok", "error"].sort());
  assert.equal(result.results[0].text, "two");
});
