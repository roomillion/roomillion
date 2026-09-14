"use strict";

const { app, BrowserWindow, session } = require("electron");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function argumentValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

async function captureDownload(destinationPath, trigger) {
  const download = new Promise((resolve, reject) => {
    session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(destinationPath);
      item.once("done", (_doneEvent, state) => {
        if (state === "completed") resolve(destinationPath);
        else reject(new Error(`下载未完成：${state}`));
      });
    });
  });
  await trigger();
  return download;
}

async function main() {
  const pilotRoot = path.resolve(argumentValue("pilot-root") ?? path.join(__dirname, "..", "release", "Roomillion-0.2.0-Pilot-Kit"));
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "zhibian-pilot-pages-smoke-"));
  app.setPath("userData", path.join(temporaryRoot, "user-data"));
  app.setPath("sessionData", path.join(temporaryRoot, "session-data"));
  app.commandLine.appendSwitch("disable-gpu");
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    const feedbackHtml = path.join(pilotRoot, "试点反馈表.html");
    const summaryHtml = path.join(pilotRoot, "汇总试点结果.html");
    await fsp.access(feedbackHtml);
    await fsp.access(summaryHtml);
    await fsp.access(path.join(pilotRoot, "pilot-feedback-core.js"));

    await window.loadFile(feedbackHtml);
    const feedbackPath = path.join(temporaryRoot, "feedback-P01.json");
    await captureDownload(feedbackPath, () => window.webContents.executeJavaScript(`(() => {
      const form = document.getElementById("feedbackForm");
      form.elements.testerId.value = "P01";
      form.elements.durationMinutes.value = "18";
      form.elements.automaticVerdict.value = "PASS";
      for (const select of document.querySelectorAll('[name^="task_"]')) select.value = "passed";
      document.querySelector('[name="observation_offlineCompleted"]').value = "true";
      document.querySelector('[name="observation_uacPrompted"]').value = "false";
      document.querySelector('[name="observation_smartScreenOrAntivirus"]').value = "false";
      document.querySelector('[name="observation_helpNeeded"]').value = "false";
      document.querySelector('[name="observation_permissionConfusing"]').value = "false";
      form.requestSubmit();
      return { taskRows: document.querySelectorAll("#tasks .task").length };
    })()`));
    const feedback = JSON.parse(await fsp.readFile(feedbackPath, "utf8"));
    if (feedback.testerId !== "P01" || Object.values(feedback.tasks).some((status) => status !== "passed")) {
      throw new Error("反馈表下载内容无效");
    }

    const feedbacks = Array.from({ length: 5 }, (_value, index) => ({ ...feedback, testerId: `P0${index + 1}` }));
    await window.loadFile(summaryHtml);
    const summaryUi = await window.webContents.executeJavaScript(`(async () => {
      const values = ${JSON.stringify(feedbacks)};
      const transfer = new DataTransfer();
      values.forEach((value, index) => transfer.items.add(new File(
        [JSON.stringify(value)],
        "zhibian-pilot-feedback-P0" + (index + 1) + ".json",
        { type: "application/json" }
      )));
      const input = document.getElementById("files");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (document.getElementById("status").textContent.includes("有效样本 5 份")) {
            clearInterval(timer); resolve();
          } else if (Date.now() - started > 5000) {
            clearInterval(timer); reject(new Error("汇总页等待超时"));
          }
        }, 50);
      });
      return {
        rows: document.querySelectorAll("#metrics tr").length,
        failedTargets: document.querySelectorAll("#metrics .fail").length,
        status: document.getElementById("status").textContent,
        exportEnabled: !document.getElementById("export").disabled
      };
    })()`);
    if (summaryUi.rows !== 6 || summaryUi.failedTargets !== 0 || !summaryUi.exportEnabled) {
      throw new Error(`汇总页渲染无效：${JSON.stringify(summaryUi)}`);
    }

    const summaryPath = path.join(temporaryRoot, "pilot-summary.json");
    await captureDownload(summaryPath, () => window.webContents.executeJavaScript("document.getElementById('export').click()"));
    const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
    if (summary.sampleSize !== 5 || !Object.values(summary.targets).every((target) => target.passed)) {
      throw new Error("汇总下载内容没有达到预期目标");
    }
    console.log(`PILOT_PAGES_SMOKE_OK ${JSON.stringify({ feedbackTester: feedback.testerId, summaryUi, sampleSize: summary.sampleSize })}`);
  } finally {
    window.destroy();
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error("PILOT_PAGES_SMOKE_FAILED", error);
  app.exit(1);
});
