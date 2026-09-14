"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WORKBENCH_THEMES,
  applyNativeWorkbenchTheme,
  getWorkbenchTheme
} = require("../src/main/workbench-theme.cjs");

test("workbench exposes color themes plus six visibly distinct style themes", () => {
  const themes = Object.values(WORKBENCH_THEMES);
  assert.equal(themes.length, 22);
  assert.equal(themes.filter((theme) => theme.mode === "light").length, 12);
  assert.equal(themes.filter((theme) => theme.mode === "dark").length, 10);
  assert.equal(new Set(themes.map((theme) => theme.id)).size, 22);
  assert.equal(getWorkbenchTheme("ink-light").titlebarColor, "#f4f0e5");
  assert.equal(getWorkbenchTheme("prism-dark").mode, "dark");
  assert.throws(() => getWorkbenchTheme("unknown-theme"), /主题无效/);
});

test("native workbench theme updates the window background and titlebar safely", () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    setBackgroundColor: (color) => calls.push(["background", color]),
    setTitleBarOverlay: (options) => calls.push(["titlebar", options])
  };
  const result = applyNativeWorkbenchTheme(window, "graphite-dark");
  assert.deepEqual(result, { id: "graphite-dark", mode: "dark" });
  assert.deepEqual(calls[0], ["background", "#121314"]);
  assert.deepEqual(calls[1], ["titlebar", {
    color: "#1b1c1d",
    symbolColor: "#f1eee9",
    height: 38
  }]);
});
