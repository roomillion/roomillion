"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

const A4 = Object.freeze({ width: 595.28, height: 841.89 });

function cleanInlineMarkdown(text) {
  return String(text || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/<[^>]+>/g, "")
    .trimEnd();
}

function markdownBlocks(markdown) {
  const blocks = [];
  let inCode = false;
  for (const sourceLine of String(markdown || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(sourceLine)) { inCode = !inCode; continue; }
    if (!sourceLine.trim()) { blocks.push({ text: "", size: 10, gap: 7 }); continue; }
    const heading = sourceLine.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push({ text: cleanInlineMarkdown(heading[2]), size: Math.max(12, 24 - level * 2), gap: level <= 2 ? 10 : 7, heading: true });
      continue;
    }
    const bullet = sourceLine.match(/^\s*[-+*]\s+(.+)$/);
    const numbered = sourceLine.match(/^\s*(\d+)[.)]\s+(.+)$/);
    const quote = sourceLine.match(/^\s*>\s?(.*)$/);
    const text = bullet ? `• ${bullet[1]}` : numbered ? `${numbered[1]}. ${numbered[2]}` : quote ? `│ ${quote[1]}` : sourceLine;
    blocks.push({ text: cleanInlineMarkdown(text), size: inCode ? 9 : 10.5, gap: 4, code: inCode });
  }
  return blocks;
}

function wrapText(font, text, size, maxWidth) {
  if (!text) return [""];
  const lines = [];
  let line = "";
  for (const character of [...text]) {
    const candidate = line + character;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) { lines.push(line); line = character; }
    else line = candidate;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

class RoomDocumentService {
  constructor({ resourcesPath, blobService }) {
    this.resourcesPath = resourcesPath;
    this.blobs = blobService;
  }

  async fontBytes() {
    const candidates = [
      this.resourcesPath && path.join(this.resourcesPath, "room-modules", "font.cjk@1", "NotoSansCJKsc-Regular.otf"),
      path.resolve(__dirname, "..", "..", "resources", "room-modules", "font.cjk@1", "NotoSansCJKsc-Regular.otf")
    ].filter(Boolean);
    for (const candidate of candidates) {
      try { return await fsp.readFile(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    throw new Error("找不到平台中文 PDF 字体");
  }

  async renderMarkdown(roomId, markdown, options = {}) {
    if (typeof markdown !== "string" || !markdown.trim()) throw new Error("Markdown 内容不能为空");
    if (markdown.length > 50_000_000) throw new Error("单次 PDF 排版最多处理 5000 万字符，请拆分书籍");
    const title = String(options.title || "Roomillion 文档").slice(0, 200);
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(await this.fontBytes(), { subset: true });
    pdf.setTitle(title);
    pdf.setCreator("千万间 Roomillion");
    const margin = 48;
    const maxWidth = A4.width - margin * 2;
    let page;
    let y;
    const addPage = () => { page = pdf.addPage([A4.width, A4.height]); y = A4.height - margin; };
    addPage();
    for (const block of markdownBlocks(markdown)) {
      const lineHeight = block.size * 1.55;
      const lines = wrapText(font, block.text, block.size, maxWidth - (block.code ? 12 : 0));
      const needed = Math.max(lineHeight, lines.length * lineHeight) + block.gap;
      if (y - needed < margin + 18) addPage();
      if (!block.text) { y -= block.gap; continue; }
      for (const line of lines) {
        if (y - lineHeight < margin + 18) addPage();
        page.drawText(line, { x: margin + (block.code ? 12 : 0), y, size: block.size, font, color: block.heading ? rgb(0.08, 0.12, 0.18) : rgb(0.12, 0.14, 0.18) });
        y -= lineHeight;
      }
      y -= block.gap;
    }
    const pages = pdf.getPages();
    for (let index = 0; index < pages.length; index += 1) {
      const label = `${index + 1} / ${pages.length}`;
      pages[index].drawText(label, { x: A4.width / 2 - font.widthOfTextAtSize(label, 8) / 2, y: 22, size: 8, font, color: rgb(0.4, 0.42, 0.46) });
    }
    const bytes = await pdf.save({ useObjectStreams: true });
    return this.blobs.put(roomId, { name: String(options.name || `${title}.pdf`), mimeType: "application/pdf", kind: "artifact", metadata: { source: "markdown", title, pages: pages.length } }, bytes);
  }

  async renderMarkdownArtifact(roomId, artifactId, options = {}) {
    const source = await this.blobs.getFile(roomId, artifactId);
    if (source.item.kind !== "artifact" || !["text/markdown", "text/plain"].includes(source.item.mimeType)) throw new Error("源制品必须是 Markdown 或纯文本");
    const markdown = await fsp.readFile(source.path, "utf8");
    return this.renderMarkdown(roomId, markdown, { title: path.basename(source.item.name, path.extname(source.item.name)), ...options });
  }
}

module.exports = { RoomDocumentService, markdownBlocks, wrapText };
