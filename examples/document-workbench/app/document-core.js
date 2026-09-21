"use strict";

// Document transformations stay in the room renderer. File access and exports
// still cross the workbench's permission-checked Room SDK boundary.
(() => {
  const textDecoder = new TextDecoder("utf-8", { fatal: false });
  const OFFICE_EXTENSIONS = Object.freeze(["md", "markdown", "txt", "docx", "xlsx", "xls", "pptx", "pdf"]);
  const CONVERTIBLE = Object.freeze(["md", "docx", "pdf"]);

  function extensionOf(name) {
    return String(name || "").split(".").at(-1).toLowerCase();
  }

  function kindOf(name) {
    const extension = extensionOf(name);
    if (["md", "markdown", "txt"].includes(extension)) return "md";
    if (["xls", "xlsx"].includes(extension)) return "xlsx";
    return ["docx", "pptx", "pdf"].includes(extension) ? extension : null;
  }

  function cleanName(name) {
    return String(name || "文档").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 90) || "文档";
  }

  function escapeMarkdown(value) {
    return String(value || "").replace(/([\\`*_{}[\]<>|])/g, "\\$1");
  }

  function htmlToMarkdown(html) {
    const documentNode = new DOMParser().parseFromString(String(html || ""), "text/html");
    const inline = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return escapeMarkdown(node.textContent.replace(/\s+/g, " "));
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      const content = [...node.childNodes].map(inline).join("");
      if (tag === "br") return "  \n";
      if (["strong", "b"].includes(tag)) return content.trim() ? `**${content.trim()}**` : "";
      if (["em", "i"].includes(tag)) return content.trim() ? `*${content.trim()}*` : "";
      if (tag === "code") return `\`${content.replace(/`/g, "\\`")}\``;
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        return /^https?:\/\//i.test(href) ? `[${content || escapeMarkdown(href)}](${href.replace(/[()]/g, "")})` : content;
      }
      if (tag === "img") return `[图片${node.getAttribute("alt") ? `：${escapeMarkdown(node.getAttribute("alt"))}` : ""}]`;
      return content;
    };
    const blocks = [];
    const renderList = (list, depth = 0) => {
      const ordered = list.tagName.toLowerCase() === "ol";
      let number = Number(list.getAttribute("start")) || 1;
      const rows = [];
      for (const child of list.children) {
        if (child.tagName.toLowerCase() !== "li") continue;
        const nested = [...child.children].filter((item) => ["ul", "ol"].includes(item.tagName.toLowerCase()));
        const content = [...child.childNodes].filter((item) => !nested.includes(item)).map(inline).join("").trim();
        rows.push(`${"  ".repeat(depth)}${ordered ? `${number++}.` : "-"} ${content}`);
        for (const sublist of nested) rows.push(renderList(sublist, depth + 1));
      }
      return rows.join("\n");
    };
    const renderBlock = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent.trim();
        if (value) blocks.push(escapeMarkdown(value));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { blocks.push(`${"#".repeat(Number(tag[1]))} ${[...node.childNodes].map(inline).join("").trim()}`); return; }
      if (["p", "figcaption"].includes(tag)) { const value = [...node.childNodes].map(inline).join("").trim(); if (value) blocks.push(value); return; }
      if (["ul", "ol"].includes(tag)) { blocks.push(renderList(node)); return; }
      if (tag === "pre") { blocks.push(`\`\`\`\n${node.textContent.trimEnd()}\n\`\`\``); return; }
      if (tag === "blockquote") {
        const value = [...node.childNodes].map(inline).join("").trim();
        if (value) blocks.push(value.split("\n").map((line) => `> ${line}`).join("\n"));
        return;
      }
      if (tag === "table") {
        const rows = [...node.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")].map((cell) => cell.textContent.trim().replace(/\s+/g, " ").replace(/\|/g, "\\|")));
        const width = Math.max(0, ...rows.map((row) => row.length));
        if (width) {
          const pad = (row) => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`;
          blocks.push([pad(rows[0]), pad(Array(width).fill("---")), ...rows.slice(1).map(pad)].join("\n"));
        }
        return;
      }
      for (const child of node.childNodes) renderBlock(child);
    };
    for (const node of documentNode.body.childNodes) renderBlock(node);
    return blocks.filter(Boolean).join("\n\n").trim() + "\n";
  }

  function textRuns(tokens, styles = {}) {
    const result = [];
    for (const token of tokens || []) {
      if (["strong", "em", "del", "link"].includes(token.type)) {
        const next = { ...styles, ...(token.type === "strong" ? { bold: true } : token.type === "em" ? { italics: true } : token.type === "del" ? { strike: true } : token.type === "link" ? { underline: {} } : {}) };
        result.push(...textRuns(token.tokens || [{ type: "text", text: token.text || "" }], next));
      } else if (token.type === "br") result.push(new docx.TextRun({ text: "\n", ...styles }));
      else if (token.type === "image") result.push(new docx.TextRun({ text: `[图片：${token.text || "未命名"}]`, ...styles }));
      else if (token.type === "codespan") result.push(new docx.TextRun({ text: token.text || "", font: "Consolas", ...styles }));
      else if (["text", "escape", "html"].includes(token.type)) result.push(new docx.TextRun({ text: token.text || "", ...styles }));
    }
    return result.length ? result : [new docx.TextRun("")];
  }

  function paragraph(text, tokens, extras = {}) {
    return new docx.Paragraph({ children: textRuns(tokens || marked.lexer(text || "", { gfm: true }).flatMap((item) => item.tokens || [{ type: "text", text: item.text || "" }])), spacing: { after: 140 }, ...extras });
  }

  async function markdownToDocx(markdown, title) {
    if (!String(markdown || "").trim()) throw new Error("没有可转换的文字内容");
    const children = [];
    for (const token of marked.lexer(markdown, { gfm: true })) {
      if (token.type === "heading") children.push(paragraph(token.text, token.tokens, { heading: docx.HeadingLevel[`HEADING_${Math.min(token.depth, 6)}`] }));
      else if (token.type === "paragraph" || token.type === "text") children.push(paragraph(token.text, token.tokens));
      else if (token.type === "list") {
        for (const [index, item] of token.items.entries()) {
          const prefix = token.ordered ? `${Number(token.start) + index}. ` : "• ";
          children.push(new docx.Paragraph({ children: [new docx.TextRun(prefix), ...textRuns(item.tokens?.flatMap((part) => part.tokens || [{ type: "text", text: part.text || "" }]) || [{ type: "text", text: item.text || "" }])], indent: { left: 360 }, spacing: { after: 70 } }));
        }
      } else if (token.type === "table") {
        const rows = [token.header, ...token.rows];
        children.push(new docx.Table({ rows: rows.map((row, rowIndex) => new docx.TableRow({ children: row.map((cell) => new docx.TableCell({ children: [new docx.Paragraph({ children: textRuns(cell.tokens || [{ type: "text", text: cell.text || "" }], rowIndex === 0 ? { bold: true } : {}) })] })) })) }));
      } else if (token.type === "code") {
        for (const line of token.text.split("\n")) children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: line || " ", font: "Consolas", size: 18 })], spacing: { after: 0 } }));
      } else if (token.type === "blockquote") {
        for (const line of token.text.split("\n")) children.push(paragraph(line, null, { indent: { left: 360 }, border: { left: { color: "9CBBA9", space: 8, size: 12, style: "single" } } }));
      } else if (token.type === "hr") children.push(new docx.Paragraph({ border: { bottom: { color: "B9C9BD", size: 8, style: "single" } } }));
    }
    if (!children.length) throw new Error("没有可转换的文字内容");
    const documentFile = new docx.Document({ title: String(title || "文档"), sections: [{ properties: {}, children }] });
    return new Uint8Array(await (await docx.Packer.toBlob(documentFile)).arrayBuffer());
  }

  function pdfLineGroups(items) {
    const lines = [];
    for (const item of items) {
      if (!item.str?.trim()) continue;
      const x = Number(item.transform?.[4] || 0);
      const y = Number(item.transform?.[5] || 0);
      const size = Math.max(1, Number(item.height || Math.hypot(item.transform?.[0] || 0, item.transform?.[1] || 0) || 10));
      let line = lines.find((row) => Math.abs(row.y - y) <= Math.max(2, Math.min(row.size, size) * .35));
      if (!line) { line = { y, size, pieces: [] }; lines.push(line); }
      line.pieces.push({ x, width: Number(item.width || 0), text: item.str });
      line.size = Math.max(line.size, size);
    }
    return lines.sort((a, b) => b.y - a.y).map((line) => {
      const pieces = line.pieces.sort((a, b) => a.x - b.x);
      let text = "";
      let end = -Infinity;
      for (const piece of pieces) {
        const gap = piece.x - end;
        const needsSpace = text && gap > line.size * .22 && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(piece.text);
        text += (needsSpace ? " " : "") + piece.text;
        end = Math.max(end, piece.x + piece.width);
      }
      return { y: line.y, size: line.size, text: text.trim() };
    }).filter((line) => line.text);
  }

  async function pdfToMarkdown(pdf, onProgress = () => {}) {
    const pages = [];
    let hasText = false;
    let missingPages = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const lines = pdfLineGroups((await page.getTextContent()).items);
      if (lines.length) hasText = true;
      else missingPages += 1;
      const sizes = lines.map((line) => line.size).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)] || 12;
      const blocks = [];
      let paragraphLines = [];
      let previous = null;
      const flush = () => { if (paragraphLines.length) blocks.push(paragraphLines.join(" ")); paragraphLines = []; };
      for (const line of lines) {
        const heading = line.text.length < 110 && line.size >= median * 1.45;
        if (heading) { flush(); blocks.push(`${line.size >= median * 1.9 ? "#" : "##"} ${line.text}`); }
        else {
          if (previous && previous.y - line.y > Math.max(previous.size, line.size) * 1.8) flush();
          paragraphLines.push(line.text);
        }
        previous = line;
      }
      flush();
      pages.push(`<!-- 第 ${number} 页${lines.length ? "" : "：无可提取文字，可能是扫描图像"} -->\n\n${blocks.join("\n\n")}`);
      onProgress(number, pdf.numPages);
    }
    if (!hasText) throw new Error("这份 PDF 没有可提取的文字层。扫描版文件需要先做 OCR，才能转换为 Markdown 或 Word。");
    return { markdown: pages.join("\n\n").trim() + "\n", missingPages };
  }

  function xml(source) {
    const parsed = new DOMParser().parseFromString(source, "application/xml");
    if (parsed.getElementsByTagName("parsererror").length) throw new Error("演示文稿的 XML 结构无效");
    return parsed;
  }

  function nodes(root, name) { return [...root.getElementsByTagNameNS("*", name)]; }
  function first(root, name) { return nodes(root, name)[0] || null; }

  async function openPresentation(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
    if (!slides.length) throw new Error("PPTX 中没有找到可浏览的幻灯片");
    const presentation = zip.file("ppt/presentation.xml");
    const sizeNode = presentation ? first(xml(await presentation.async("string")), "sldSz") : null;
    const size = { width: Number(sizeNode?.getAttribute("cx")) || 12192000, height: Number(sizeNode?.getAttribute("cy")) || 6858000 };
    return { zip, slides, size };
  }

  function slidePosition(node, size, fallbackIndex) {
    const transform = first(node, "xfrm");
    const offset = transform && first(transform, "off");
    const extent = transform && first(transform, "ext");
    if (!offset || !extent) return { left: 8, top: 10 + fallbackIndex * 13, width: 84, height: 12 };
    return {
      left: Math.max(0, Number(offset.getAttribute("x")) / size.width * 100),
      top: Math.max(0, Number(offset.getAttribute("y")) / size.height * 100),
      width: Math.min(100, Number(extent.getAttribute("cx")) / size.width * 100),
      height: Math.min(100, Number(extent.getAttribute("cy")) / size.height * 100)
    };
  }

  async function loadSlide(presentation, index) {
    const slidePath = presentation.slides[index];
    if (!slidePath) throw new Error("幻灯片页码无效");
    const slide = xml(await presentation.zip.file(slidePath).async("string"));
    const relPath = slidePath.replace(/\/([^/]+)$/, "/_rels/$1.rels");
    const relFile = presentation.zip.file(relPath);
    const relations = new Map();
    if (relFile) {
      for (const rel of nodes(xml(await relFile.async("string")), "Relationship")) {
        const target = rel.getAttribute("Target");
        if (!target || rel.getAttribute("TargetMode") === "External") continue;
        const resolved = new URL(target, `https://ppt.local/${slidePath}`);
        if (resolved.origin === "https://ppt.local") relations.set(rel.getAttribute("Id"), decodeURIComponent(resolved.pathname.slice(1)));
      }
    }
    const items = [];
    const tree = first(slide, "spTree");
    for (const element of tree?.children || []) {
      const tag = element.localName;
      if (tag === "sp" || tag === "graphicFrame") {
        const paragraphs = nodes(element, "p").map((paragraphNode) => nodes(paragraphNode, "t").map((textNode) => textNode.textContent).join("")).filter(Boolean);
        const text = paragraphs.join("\n").trim();
        if (text) items.push({ type: "text", text, position: slidePosition(element, presentation.size, items.length) });
      } else if (tag === "pic") {
        const embedded = first(element, "blip")?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
        const mediaPath = relations.get(embedded);
        const media = mediaPath && presentation.zip.file(mediaPath);
        if (!media) continue;
        const extension = extensionOf(mediaPath);
        if (!["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) continue;
        items.push({ type: "image", bytes: await media.async("uint8array"), mimeType: extension === "jpg" ? "image/jpeg" : `image/${extension}`, position: slidePosition(element, presentation.size, items.length) });
      }
    }
    return items;
  }

  window.DocumentCore = Object.freeze({ OFFICE_EXTENSIONS, CONVERTIBLE, kindOf, cleanName, htmlToMarkdown, markdownToDocx, pdfToMarkdown, pdfLineGroups, openPresentation, loadSlide });
})();
