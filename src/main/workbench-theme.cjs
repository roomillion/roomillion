"use strict";

const WORKBENCH_THEMES = Object.freeze({
  "forest-light": Object.freeze({
    id: "forest-light",
    mode: "light",
    backgroundColor: "#edf2ef",
    titlebarColor: "#f7faf8",
    symbolColor: "#42574e"
  }),
  "ocean-light": Object.freeze({
    id: "ocean-light",
    mode: "light",
    backgroundColor: "#eaf1f8",
    titlebarColor: "#f5f9ff",
    symbolColor: "#334b66"
  }),
  "paper-light": Object.freeze({
    id: "paper-light",
    mode: "light",
    backgroundColor: "#f4efe3",
    titlebarColor: "#fbf7ed",
    symbolColor: "#5d5344"
  }),
  "lilac-light": Object.freeze({
    id: "lilac-light",
    mode: "light",
    backgroundColor: "#f1edf7",
    titlebarColor: "#faf7ff",
    symbolColor: "#554a69"
  }),
  "rose-light": Object.freeze({
    id: "rose-light",
    mode: "light",
    backgroundColor: "#f9f0f2",
    titlebarColor: "#fdf5f7",
    symbolColor: "#59253a"
  }),
  "jade-light": Object.freeze({
    id: "jade-light",
    mode: "light",
    backgroundColor: "#ebf4f4",
    titlebarColor: "#f4fafa",
    symbolColor: "#0f4c48"
  }),
  "amber-light": Object.freeze({
    id: "amber-light",
    mode: "light",
    backgroundColor: "#faf3e3",
    titlebarColor: "#fdf8ec",
    symbolColor: "#6b4a12"
  }),
  "cloud-light": Object.freeze({
    id: "cloud-light",
    mode: "light",
    backgroundColor: "#eff1f4",
    titlebarColor: "#f7f8fa",
    symbolColor: "#38415c"
  }),
  "ink-light": Object.freeze({
    id: "ink-light",
    mode: "light",
    backgroundColor: "#eee9dc",
    titlebarColor: "#f4f0e5",
    symbolColor: "#322f29"
  }),
  "celadon-light": Object.freeze({
    id: "celadon-light",
    mode: "light",
    backgroundColor: "#edf2ed",
    titlebarColor: "#f7f8f3",
    symbolColor: "#27483f"
  }),
  "studio-light": Object.freeze({
    id: "studio-light",
    mode: "light",
    backgroundColor: "#f5f5f3",
    titlebarColor: "#ffffff",
    symbolColor: "#202220"
  }),
  "editorial-light": Object.freeze({
    id: "editorial-light",
    mode: "light",
    backgroundColor: "#f3efe4",
    titlebarColor: "#fffdf7",
    symbolColor: "#111111"
  }),
  "forest-dark": Object.freeze({
    id: "forest-dark",
    mode: "dark",
    backgroundColor: "#0c1512",
    titlebarColor: "#101a17",
    symbolColor: "#dce9e3"
  }),
  "midnight-dark": Object.freeze({
    id: "midnight-dark",
    mode: "dark",
    backgroundColor: "#0b1220",
    titlebarColor: "#111827",
    symbolColor: "#dbeafe"
  }),
  "violet-dark": Object.freeze({
    id: "violet-dark",
    mode: "dark",
    backgroundColor: "#120f1d",
    titlebarColor: "#1b1628",
    symbolColor: "#eee7ff"
  }),
  "graphite-dark": Object.freeze({
    id: "graphite-dark",
    mode: "dark",
    backgroundColor: "#121314",
    titlebarColor: "#1b1c1d",
    symbolColor: "#f1eee9"
  }),
  "wine-dark": Object.freeze({
    id: "wine-dark",
    mode: "dark",
    backgroundColor: "#170d10",
    titlebarColor: "#1e1216",
    symbolColor: "#f3dde2"
  }),
  "abyss-dark": Object.freeze({
    id: "abyss-dark",
    mode: "dark",
    backgroundColor: "#0a1517",
    titlebarColor: "#0f1c20",
    symbolColor: "#d8ece9"
  }),
  "brass-dark": Object.freeze({
    id: "brass-dark",
    mode: "dark",
    backgroundColor: "#14100b",
    titlebarColor: "#1a140d",
    symbolColor: "#f0e6d2"
  }),
  "sakura-dark": Object.freeze({
    id: "sakura-dark",
    mode: "dark",
    backgroundColor: "#180e14",
    titlebarColor: "#1d1219",
    symbolColor: "#f5dfe9"
  }),
  "terminal-dark": Object.freeze({
    id: "terminal-dark",
    mode: "dark",
    backgroundColor: "#07100b",
    titlebarColor: "#09140d",
    symbolColor: "#79ff9f"
  }),
  "prism-dark": Object.freeze({
    id: "prism-dark",
    mode: "dark",
    backgroundColor: "#100d24",
    titlebarColor: "#171331",
    symbolColor: "#f0eaff"
  })
});

function getWorkbenchTheme(themeId) {
  if (typeof themeId !== "string" || !Object.hasOwn(WORKBENCH_THEMES, themeId)) {
    throw new Error("工作台主题无效");
  }
  return WORKBENCH_THEMES[themeId];
}

function applyNativeWorkbenchTheme(window, themeId) {
  const theme = getWorkbenchTheme(themeId);
  if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) {
    throw new Error("工作台窗口不可用");
  }
  window.setBackgroundColor?.(theme.backgroundColor);
  window.setTitleBarOverlay?.({
    color: theme.titlebarColor,
    symbolColor: theme.symbolColor,
    height: 38
  });
  return { id: theme.id, mode: theme.mode };
}

module.exports = {
  WORKBENCH_THEMES,
  applyNativeWorkbenchTheme,
  getWorkbenchTheme
};
