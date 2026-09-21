"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const docx = require("docx");
const XLSX = require("xlsx");
const PptxGenJS = require("pptxgenjs");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { validateInstalledProgramRuntime } = require("../src/main/room-runtime-validator.cjs");

async function fixtureFiles() {
  const markdown = "# 示例手册\n\n**重要内容**与普通段落。\n\n| 项目 | 数量 |\n| --- | --- |\n| 文档 | 2 |\n";
  const word = new docx.Document({ sections: [{ children: [
    new docx.Paragraph({ text: "Word 示例标题", heading: docx.HeadingLevel.HEADING_1 }),
    new docx.Paragraph("这是一段中文正文。")
  ] }] });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "数量"], ["文档", 2]]), "第一张表");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["第二页"], ["可以切换"]]), "第二张表");
  const presentation = new PptxGenJS();
  const firstSlide = presentation.addSlide();
  firstSlide.addText("演示文稿第一页", { x: 1, y: 1, w: 6, h: 1 });
  firstSlide.addImage({ data: "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", x: 1, y: 2, w: 1, h: 1 });
  presentation.addSlide().addText("演示文稿第二页", { x: 1, y: 1, w: 6, h: 1 });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("PDF first page", { x: 50, y: 700, size: 24, font });
  pdf.addPage().drawText("PDF second page", { x: 50, y: 700, size: 24, font });
  const scanned = await PDFDocument.create();
  scanned.addPage();
  return [
    { name: "sample.md", text: markdown },
    { name: "sample.docx", base64: (await docx.Packer.toBuffer(word)).toString("base64") },
    { name: "sample.xlsx", base64: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }).toString("base64") },
    { name: "sample.xls", base64: XLSX.write(workbook, { type: "buffer", bookType: "biff8" }).toString("base64") },
    { name: "sample.pptx", base64: Buffer.from(await presentation.write({ outputType: "arraybuffer" })).toString("base64") },
    { name: "sample.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
    { name: "sample-scan.pdf", base64: Buffer.from(await scanned.save()).toString("base64") }
  ];
}

test("official document room browses five formats and exercises both directions of MD, Word and PDF conversion", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "roomillion-document-room-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, "program");
  await fsp.cp(path.join(__dirname, "..", "examples", "document-workbench"), source, { recursive: true });
  const definition = {
    version: 1,
    mocks: { files: await fixtureFiles(), captureExports: true },
    scenarios: [{ name: "五种文档浏览与六条转换路径", actions: [
      { type: "click", selector: "#openFile" },
      { type: "wait", ms: 500 },
      { type: "assertText", selector: "#fileName", value: "sample.md" },
      { type: "assertText", selector: ".paper h1", value: "示例手册" },
      { type: "click", selector: "#convertButton" },
      { type: "wait", ms: 1000 },
      { type: "assertText", selector: "#readerStatus", value: "已保存 sample.docx" },
      { type: "input", selector: "#targetFormat", value: "pdf" },
      { type: "click", selector: "#convertButton" },
      { type: "wait", ms: 5000 },
      { type: "wait", ms: 3000 },
      { type: "assertText", selector: "#readerStatus", value: "已保存 sample.pdf" },

      { type: "click", selector: "#openFile" },
      { type: "wait", ms: 1200 },
      { type: "assertText", selector: "#fileName", value: "sample.docx" },
      { type: "assertText", selector: "#preview", value: "Word 示例标题" },
      { type: "assertExists", selector: ".docxWrapper .docx" },
      { type: "click", selector: "#convertButton" },
      { type: "wait", ms: 300 },
      { type: "assertText", selector: "#readerStatus", value: "已保存 sample.md" },
      { type: "input", selector: "#targetFormat", value: "pdf" },
      { type: "click", selector: "#convertButton" },
      { type: "wait", ms: 5000 },
      { type: "wait", ms: 3000 },
      { type: "assertText", selector: "#readerStatus", value: "已保存 sample.pdf" },

      { type: "click", selector: "#openFile" },
      { type: "wait", ms: 450 },
      { type: "assertText", selector: "#fileName", value: "sample.xlsx" },
      { type: "assertText", selector: "#preview", value: "文档" },
      { type: "input", selector: "#sheetPicker", value: "1" },
      { type: "assertText", selector: "#preview", value: "可以切换" },

      { type: "click", selector: "#openFile" },
      { type: "wait", ms: 450 },
      { type: "assertText", selector: "#fileName", value: "sample.xls" },
      { type: "assertText", selector: "#preview", value: "文档" },

      { type: "click", selector: "#openFile" },
      { type: "wait", ms: 550 },
      { type: "assertText", selector: "#fileName", value: "sample.pptx" },
      { type: "assertText", selector: "#preview", value: "演示文稿第一页" },
      { type: "assertExists", selector: ".slidePicture" },
      { type: "click", selector: "#nextPage" },
      { type: "wait", ms: 300 },
      { type: "assertText", selector: "#preview", value: "演示文稿第二页" },

      { type: "click", selector: "#openFile" },
      { type: "wait", ms: 1000 },
      { type: "assertText", selector: "#fileName", value: "sample.pdf" },
      { type: "assertExists", selector: ".pdfCanvas" },
      { type: "click", selector: "#nextPage" },
      { type: "wait", ms: 500 },
      { type: "assertText", selector: "#pageIndicator", value: "2 / 2" },
      { type: "click", selector: "#convertButton" },
      { type: "wait", ms: 400 },
      { type: "assertText", selector: "#readerStatus", value: "已保存 sample.md" },
      { type: "input", selector: "#targetFormat", value: "docx" },
      { type: "click", selector: "#convertButton" },
      { type: "wait", ms: 900 },
      { type: "assertText", selector: "#readerStatus", value: "已保存 sample.docx" },

      { type: "click", selector: "#openFile" },
      { type: "wait", ms: 2000 },
      { type: "assertText", selector: "#fileName", value: "sample-scan.pdf" },
      { type: "assertText", selector: "#preview", value: "扫描图像" },
      { type: "click", selector: "#convertButton" },
      { type: "wait", ms: 500 },
      { type: "assertText", selector: "#readerStatus", value: "需要先做 OCR" },
      { type: "wait", ms: 500 },
      { type: "assertExists", selector: "#preview[aria-busy='false']" },
      { type: "click", selector: "#closeDocument" },
      { type: "wait", ms: 250 },
      { type: "assertText", selector: "#fileName", value: "sample.pdf" },
      { type: "click", selector: "#documentList .documentItem:last-child" },
      { type: "assertText", selector: "#fileName", value: "sample.md" }
    ] }]
  };
  await fsp.writeFile(path.join(source, "app", "room-tests.json"), JSON.stringify(definition));
  const result = await validateInstalledProgramRuntime({ programRoot: source });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.checks.find((check) => check.id === "declared-scenarios")?.passed, true, JSON.stringify(result));
  assert.deepEqual(result.exports.map((item) => item.name), ["sample.docx", "sample.pdf", "sample.md", "sample.pdf", "sample.md", "sample.docx"]);
  assert.ok(result.exports.every((item) => item.bytes > 0 && (item.name.endsWith(".md") || item.signature.startsWith(item.name.endsWith(".pdf") ? "%PDF" : "PK"))), JSON.stringify(result.exports));
  assert.ok(result.exports[0].docxText.includes("示例手册"));
  assert.ok(result.exports[1].pdfPages >= 1);
  assert.ok(result.exports[2].excerpt.includes("# Word 示例标题"));
  assert.ok(result.exports[3].pdfPages >= 1);
  assert.ok(result.exports[4].excerpt.includes("PDF first page"));
  assert.ok(result.exports[5].docxText.includes("PDF first page"));
});
