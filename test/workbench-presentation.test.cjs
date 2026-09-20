"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { canUseProfile, credentialStatus, importNotices, shouldSubmitAgentPrompt } = require("../src/renderer/workbench-presentation.js");
test("stored credentials are not equated with usable credentials; local anonymous gateways remain supported", () => {
  const profile = { baseUrl: "https://example.test/v1", hasStoredKey: true };
  assert.equal(canUseProfile(profile), false);
  assert.match(credentialStatus(profile), /无法读取/);
  assert.equal(canUseProfile({ ...profile, hasSessionKey: true }), true);
  assert.equal(canUseProfile({ baseUrl: "http://localhost:8000/v1" }), true);
  assert.equal(canUseProfile(null), false);
  assert.match(credentialStatus({ baseUrl: profile.baseUrl }), /缺少密钥/);
});
test("import copy separates program replacement from snapshot replacement for every version change", () => {
  for (const versionChange of ["same", "upgrade", "downgrade", "install"]) {
    for (const protectedPackage of [true, false]) {
      const input = { room: { version: "1.1.0" }, existing: versionChange === "install" ? null : { version: "1.0.0" }, versionChange,
        transfer: { kind: "app-and-data", protected: protectedPackage } };
      const notices = importNotices(input);
      assert.doesNotMatch(notices.program, /保留现有业务数据|不会.*覆盖/);
      assert.match(notices.data, input.existing ? /替换.*不会合并/ : /初始化/);
      assert.equal(notices.button, input.existing ? "安装并替换数据" : "安装并恢复数据");
      assert.match(notices.data, /Blob/);
      const legacy = importNotices({ ...input, transfer: { ...input.transfer, formatVersion: "0.2" } });
      assert.match(legacy.data, /旧版包/);
      assert.doesNotMatch(legacy.data, /随包数据库、Blob/);
      const appOnly = importNotices({ ...input, transfer: { kind: "app-only" } });
      assert.match(appOnly.program, /保留现有业务数据/);
      assert.equal(appOnly.data, "");
    }
  }
});
test("hidden elements stay hidden despite component layout and questionnaire controls stay inline", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.agentQuestionForm \.agentQuestionOption\s*\{\s*display: flex/);
  const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
  assert.ok(html.indexOf('workbench-presentation.js') < html.indexOf('src="./app.js"'));
  assert.match(html, /id="roomStandby"/);
});
test("room collections remain reachable in a short non-fullscreen window", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");
  assert.match(css, /\.appShell\s*\{[^}]*height:\s*auto[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.workspace\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden[^}]*grid-template-rows:\s*68px minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.roomList\s*\{[^}]*flex:\s*1 1 0[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.sidebarFooter\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.homePage\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.installedRoomsGrid\s*\{[^}]*overflow:\s*visible/s);
  assert.doesNotMatch(css, /\.installedRoomsGrid\s*\{[^}]*max-height/s);
});
test("AI room composer submits on Enter and keeps Shift+Enter for a newline", () => {
  assert.equal(shouldSubmitAgentPrompt({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }), true);
  assert.equal(shouldSubmitAgentPrompt({ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 }), false);
  assert.equal(shouldSubmitAgentPrompt({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 13 }), false);
  assert.equal(shouldSubmitAgentPrompt({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), false);
  assert.equal(shouldSubmitAgentPrompt({ key: "a", shiftKey: false, isComposing: false, keyCode: 65 }), false);

  const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
  assert.match(html, /回车发送，Shift \+ 回车换行/);
  const renderer = fs.readFileSync(path.join(__dirname, "../src/renderer/app.js"), "utf8");
  assert.match(renderer, /commands\.length && event\.key === "Tab"/);
  assert.doesNotMatch(renderer, /\["Tab", "Enter"\]\.includes\(event\.key\)/);
});
