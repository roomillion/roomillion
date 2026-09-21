"use strict";

(() => {
  const Core = window.DocumentCore;
  if (!Core || !window.room || !window.DOMPurify || !window.marked || !window.docx || !window.mammoth || !window.XLSX || !window.JSZip) {
    document.documentElement.dataset.roomError = "文档房间所需的离线模块未完整加载";
    return;
  }
  const state = { documents: [], activeId: null, busy: false, renderId: 0, objectUrls: [], pdfRenderTask: null, pdfjs: null };
  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "openFile", "openFromWelcome", "documentList", "documentCount", "fileKind", "fileName", "fileMeta", "closeDocument",
    "preview", "previewToolbar", "pageControls", "previousPage", "nextPage", "pageIndicator", "sheetControls", "sheetPicker",
    "previousRows", "nextRows", "rowIndicator", "zoomControls", "zoomOut", "zoomIn", "zoomValue", "readerStatus",
    "sourceFormat", "targetFormat", "convertButton", "conversionHint"
  ].map((id) => [id, byId(id)]));
  const LABELS = { md: "Markdown", docx: "Word · DOCX", xlsx: "Excel 表格", pptx: "演示文稿 · PPTX", pdf: "PDF" };
  const TARGETS = { md: "Markdown · .md", docx: "Word · .docx", pdf: "PDF · .pdf" };
  const selected = () => state.documents.find((item) => item.id === state.activeId) || null;

  function setStatus(message, error = false) {
    ui.readerStatus.textContent = message;
    ui.readerStatus.classList.toggle("error", error);
  }

  function updateBusy(value) {
    state.busy = value;
    ui.preview.setAttribute("aria-busy", String(value));
    ui.openFile.disabled = value;
    ui.openFromWelcome.disabled = value;
    ui.closeDocument.disabled = value;
    ui.convertButton.disabled = value || !selected() || !ui.targetFormat.value;
    ui.convertButton.textContent = value ? "处理中…" : "转换并保存";
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function renderLibrary() {
    const { scrollTop, scrollLeft } = ui.documentList;
    ui.documentCount.textContent = String(state.documents.length);
    ui.documentList.replaceChildren();
    if (!state.documents.length) {
      const hint = document.createElement("p");
      hint.className = "emptyLibrary";
      hint.innerHTML = "还没有打开文档。<br>点击右上角的“打开文档”开始。";
      ui.documentList.append(hint);
      return;
    }
    for (const item of state.documents) {
      const row = document.createElement("div");
      row.className = `documentItem${item.id === state.activeId ? " active" : ""}`;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `查看 ${item.name}`);
      const extension = document.createElement("span");
      extension.className = "extension";
      extension.textContent = item.kind === "xlsx" ? "XLS" : item.kind.toUpperCase();
      const details = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = item.name;
      const meta = document.createElement("small");
      meta.textContent = `${LABELS[item.kind]} · ${formatSize(item.bytes.length)}`;
      details.append(title, meta);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "×";
      remove.title = `关闭 ${item.name}`;
      remove.setAttribute("aria-label", `关闭 ${item.name}`);
      remove.addEventListener("click", (event) => { event.stopPropagation(); closeDocument(item.id); });
      row.append(extension, details, remove);
      row.addEventListener("click", () => selectDocument(item.id));
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectDocument(item.id); } });
      ui.documentList.append(row);
    }
    ui.documentList.scrollTop = scrollTop;
    ui.documentList.scrollLeft = scrollLeft;
  }

  function updateConversion() {
    const item = selected();
    ui.sourceFormat.textContent = item ? LABELS[item.kind] : "尚未选择";
    ui.targetFormat.replaceChildren();
    if (!item || !Core.CONVERTIBLE.includes(item.kind)) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = item ? "仅支持浏览" : "先打开文档";
      ui.targetFormat.append(option);
      ui.targetFormat.disabled = true;
      ui.convertButton.disabled = true;
      ui.conversionHint.textContent = item ? "Excel 与 PPTX 当前提供浏览；Markdown、Word 和 PDF 可相互转换。" : "Markdown、Word（DOCX）和 PDF 支持互转。Excel 与 PPTX 当前提供浏览。";
      return;
    }
    for (const kind of Core.CONVERTIBLE.filter((value) => value !== item.kind)) {
      const option = document.createElement("option");
      option.value = kind;
      option.textContent = TARGETS[kind];
      ui.targetFormat.append(option);
    }
    ui.targetFormat.disabled = false;
    ui.convertButton.disabled = state.busy;
    ui.conversionHint.textContent = item.kind === "pdf"
      ? "PDF 转换依赖可提取的文字层。扫描页和复杂分栏可能需要 OCR 或人工校对。"
      : item.kind === "docx"
        ? "转换保留主要文字结构；浮动图形、批注和复杂页面版式可能需要调整。"
        : "标题、列表、表格和基本行内样式会尽量保留。外部图片引用不会自动读取。";
  }

  function updateHeader() {
    const item = selected();
    ui.fileKind.textContent = item ? item.kind.toUpperCase() : "预览";
    ui.fileName.textContent = item?.name || "打开文档，开始阅读";
    ui.fileMeta.textContent = item ? `${LABELS[item.kind]} · ${formatSize(item.bytes.length)}` : "格式清晰，转换顺手。";
    ui.closeDocument.hidden = !item;
    ui.previewToolbar.hidden = !item || item.kind === "md" || item.kind === "docx";
    ui.pageControls.hidden = !item || !["pdf", "pptx"].includes(item.kind);
    ui.sheetControls.hidden = !item || item.kind !== "xlsx";
    ui.zoomControls.hidden = !item || item.kind !== "pdf";
    if (item?.kind === "pdf" || item?.kind === "pptx") {
      const total = item.kind === "pdf" ? item.pdf.numPages : item.presentation.slides.length;
      ui.pageIndicator.textContent = `${item.page} / ${total}`;
      ui.previousPage.disabled = item.page <= 1;
      ui.nextPage.disabled = item.page >= total;
    }
    if (item?.kind === "pdf") ui.zoomValue.textContent = `${Math.round(item.zoom * 100)}%`;
    updateConversion();
    renderLibrary();
  }

  function clearPreviewResources() {
    if (state.pdfRenderTask) { state.pdfRenderTask.cancel(); state.pdfRenderTask = null; }
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls.length = 0;
    ui.preview.replaceChildren();
  }

  function welcome() {
    const wrapper = document.createElement("div");
    wrapper.className = "welcome";
    const mark = document.createElement("span"); mark.className = "welcomeIcon"; mark.textContent = "文";
    const title = document.createElement("h3"); title.textContent = "把常用文档放在同一张桌面上";
    const text = document.createElement("p"); text.textContent = "浏览 Markdown、Word、Excel、演示文稿和 PDF；需要分享时，将 Markdown、Word 与 PDF 互相转换。";
    const open = document.createElement("button"); open.type = "button"; open.className = "secondaryButton"; open.textContent = "选择一个文档";
    open.addEventListener("click", () => openFile());
    wrapper.append(mark, title, text, open);
    ui.preview.append(wrapper);
  }

  function safeHtml(html) {
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["form", "iframe", "object", "embed", "svg", "math"] });
  }

  function renderMarkdown(item) {
    const paper = document.createElement("article");
    paper.className = "paper prose";
    paper.innerHTML = safeHtml(marked.parse(item.markdown, { gfm: true, breaks: false }));
    ui.preview.append(paper);
  }

  async function renderWord(item, renderId) {
    const wrapper = document.createElement("div");
    wrapper.className = "docxWrapper";
    ui.preview.append(wrapper);
    try {
      if (!window.docxPreview?.renderAsync) throw new Error("排版预览不可用");
      await window.docxPreview.renderAsync(item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength), wrapper, null, { breakPages: true, ignoreLastRenderedPageBreak: false });
      if (renderId !== state.renderId) return;
    } catch (_error) {
      if (renderId !== state.renderId) return;
      wrapper.className = "paper prose";
      wrapper.innerHTML = item.safeHtml;
      setStatus("已切换到安全阅读视图；原始 Word 版式无法完整渲染。");
    }
  }

  async function renderPdf(item, renderId) {
    const page = await item.pdf.getPage(item.page);
    if (renderId !== state.renderId) return;
    const viewport = page.getViewport({ scale: item.zoom * 1.2 });
    const canvas = document.createElement("canvas");
    canvas.className = "pdfCanvas";
    const ratio = Math.min(window.devicePixelRatio || 1, 2, 4096 / viewport.width, 4096 / viewport.height);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ui.preview.append(canvas);
    const text = await page.getTextContent();
    if (renderId !== state.renderId) return;
    if (!text.items.some((part) => part.str?.trim())) {
      const note = document.createElement("p"); note.className = "pdfNote";
      note.textContent = "这一页没有可提取文字，可能是扫描图像。阅读仍可用；转为 Markdown / Word 需要先进行 OCR。";
      ui.preview.prepend(note);
    }
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
    state.pdfRenderTask = task;
    task.promise.catch((error) => {
      if (error.name !== "RenderingCancelledException" && renderId === state.renderId) setStatus(`PDF 页面渲染失败：${error.message || error}`, true);
    }).finally(() => { if (state.pdfRenderTask === task) state.pdfRenderTask = null; });
  }

  function renderSheet(item) {
    ui.sheetPicker.replaceChildren();
    for (const [index, name] of item.workbook.SheetNames.entries()) {
      const option = document.createElement("option"); option.value = String(index); option.textContent = name; ui.sheetPicker.append(option);
    }
    ui.sheetPicker.value = String(item.sheetIndex);
    const sheet = item.workbook.Sheets[item.workbook.SheetNames[item.sheetIndex]];
    const bounds = sheet?.["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
    if (!bounds) { const empty = document.createElement("p"); empty.className = "documentWarning"; empty.textContent = "这个工作表没有单元格内容。"; ui.preview.append(empty); return; }
    const rowCount = bounds.e.r - bounds.s.r + 1;
    const maxPage = Math.max(0, Math.ceil(rowCount / 100) - 1);
    item.rowPage = Math.min(item.rowPage, maxPage);
    const firstRow = bounds.s.r + item.rowPage * 100;
    const lastRow = Math.min(bounds.e.r, firstRow + 99);
    const lastColumn = Math.min(bounds.e.c, bounds.s.c + 39);
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: true, defval: "", range: { s: { r: firstRow, c: bounds.s.c }, e: { r: lastRow, c: lastColumn } } });
    ui.rowIndicator.textContent = `${firstRow + 1}–${lastRow + 1} / ${bounds.e.r + 1}`;
    ui.previousRows.disabled = item.rowPage === 0;
    ui.nextRows.disabled = item.rowPage >= maxPage;
    if (bounds.e.c > lastColumn) {
      const note = document.createElement("p"); note.className = "documentWarning";
      note.textContent = `为保持浏览流畅，当前显示前 40 列；该工作表共有 ${bounds.e.c - bounds.s.c + 1} 列。`;
      ui.preview.append(note);
    }
    const table = document.createElement("table"); table.className = "spreadsheet";
    const header = document.createElement("tr");
    const corner = document.createElement("th"); corner.className = "rowNumber"; header.append(corner);
    for (let column = bounds.s.c; column <= lastColumn; column += 1) { const th = document.createElement("th"); th.textContent = XLSX.utils.encode_col(column); header.append(th); }
    table.append(header);
    for (let row = firstRow; row <= lastRow; row += 1) {
      const tr = document.createElement("tr");
      const number = document.createElement("th"); number.className = "rowNumber"; number.textContent = String(row + 1); tr.append(number);
      const cells = rows[row - firstRow] || [];
      for (let column = bounds.s.c; column <= lastColumn; column += 1) { const td = document.createElement("td"); td.textContent = String(cells[column - bounds.s.c] ?? ""); tr.append(td); }
      table.append(tr);
    }
    ui.preview.append(table);
  }

  async function renderSlide(item, renderId) {
    const shapes = await Core.loadSlide(item.presentation, item.page - 1);
    if (renderId !== state.renderId) return;
    const slide = document.createElement("div"); slide.className = "slideCanvas";
    const texts = [];
    for (const shape of shapes) {
      const element = document.createElement(shape.type === "image" ? "img" : "div");
      element.className = shape.type === "image" ? "slidePicture" : "slideShape";
      for (const [property, value] of Object.entries(shape.position)) element.style[property] = `${value}%`;
      if (shape.type === "image") {
        const url = URL.createObjectURL(new Blob([shape.bytes], { type: shape.mimeType }));
        state.objectUrls.push(url); element.src = url; element.alt = "幻灯片图片";
      } else { element.textContent = shape.text; texts.push(shape.text); }
      slide.append(element);
    }
    if (!shapes.length) { const fallback = document.createElement("div"); fallback.className = "slideFallback"; fallback.textContent = "这页没有可显示的文字或常见图片。"; slide.append(fallback); }
    ui.preview.append(slide);
    if (texts.length) {
      const details = document.createElement("details"); details.className = "pptTextList";
      const title = document.createElement("summary"); title.textContent = "查看本页文字";
      const body = document.createElement("p"); body.textContent = texts.join("\n"); body.style.whiteSpace = "pre-wrap";
      details.append(title, body); ui.preview.append(details);
    }
  }

  async function renderActive() {
    const renderId = ++state.renderId;
    clearPreviewResources();
    const item = selected();
    updateHeader();
    if (!item) { welcome(); setStatus("准备就绪"); return; }
    ui.preview.scrollTop = 0;
    try {
      if (item.kind === "md") renderMarkdown(item);
      else if (item.kind === "docx") await renderWord(item, renderId);
      else if (item.kind === "pdf") await renderPdf(item, renderId);
      else if (item.kind === "xlsx") renderSheet(item);
      else if (item.kind === "pptx") await renderSlide(item, renderId);
      if (renderId === state.renderId && !ui.readerStatus.classList.contains("error")) setStatus(`${item.name} · ${LABELS[item.kind]} · 已就绪`);
    } catch (error) { if (renderId === state.renderId) { setStatus(`预览失败：${error.message || error}`, true); showPreviewError(error); } }
  }

  function showPreviewError(error) {
    const message = document.createElement("p");
    message.className = "documentWarning";
    message.textContent = `无法预览：${error.message || error}`;
    ui.preview.append(message);
  }

  async function prepare(item) {
    if (item.kind === "md") item.markdown = new TextDecoder("utf-8", { fatal: false }).decode(item.bytes);
    else if (item.kind === "docx") {
      const source = item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength);
      const result = await mammoth.convertToHtml({ arrayBuffer: source });
      item.safeHtml = safeHtml(result.value);
      item.markdown = Core.htmlToMarkdown(item.safeHtml);
      item.warning = result.messages?.map((entry) => entry.message).filter(Boolean).slice(0, 3).join("；") || "";
    } else if (item.kind === "xlsx") item.workbook = XLSX.read(item.bytes, { type: "array", cellDates: true, dense: false });
    else if (item.kind === "pptx") item.presentation = await Core.openPresentation(item.bytes);
    else if (item.kind === "pdf") {
      if (!state.pdfjs) state.pdfjs = await import("/_modules/document.pdf.view@1/pdf.min.mjs");
      state.pdfjs.GlobalWorkerOptions.workerSrc = "/_modules/document.pdf.view@1/pdf.worker.min.mjs";
      const task = state.pdfjs.getDocument({ data: new Uint8Array(item.bytes), cMapUrl: "/_modules/document.pdf.view@1/cmaps/", cMapPacked: true, standardFontDataUrl: "/_modules/document.pdf.view@1/standard_fonts/", wasmUrl: "/_modules/document.pdf.view@1/wasm/" });
      item.pdf = await task.promise;
    }
  }

  async function openFile() {
    if (state.busy) return;
    updateBusy(true);
    try {
      const picked = await room.files.pickBinary({ extensions: Core.OFFICE_EXTENSIONS });
      if (!picked) { setStatus("已取消打开文档"); return; }
      const kind = Core.kindOf(picked.name);
      if (!kind) throw new Error("当前支持 MD、DOCX、XLSX、XLS、PPTX 和 PDF；旧版 DOC / PPT 请先另存为 DOCX / PPTX。");
      const item = { id: crypto.randomUUID(), name: picked.name, bytes: new Uint8Array(picked.data), kind, page: 1, zoom: 1, sheetIndex: 0, rowPage: 0 };
      setStatus(`正在读取 ${picked.name}…`);
      await prepare(item);
      state.documents.unshift(item);
      state.activeId = item.id;
      await renderActive();
      if (item.warning) setStatus(`已打开；Word 转换提示：${item.warning}`);
    } catch (error) { setStatus(`打开失败：${error.message || error}`, true); }
    finally { updateBusy(false); }
  }

  function selectDocument(id) {
    if (state.busy || state.activeId === id) return;
    state.activeId = id;
    renderActive();
  }

  function closeDocument(id) {
    if (state.busy) return;
    const index = state.documents.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [removed] = state.documents.splice(index, 1);
    if (state.activeId === id) state.activeId = state.documents[Math.min(index, state.documents.length - 1)]?.id || null;
    renderActive();
    removed.pdf?.loadingTask?.destroy().catch(() => {});
  }

  async function exportPdfArtifact(markdown, name) {
    const artifact = await room.documents.markdownToPdf(markdown, { title: name, name: `${name}.pdf` });
    let stream;
    try {
      stream = await room.files.beginExport(`${name}.pdf`);
      if (!stream) return null;
      let offset = 0;
      while (true) {
        const chunk = await room.artifacts.read(artifact.id, { offset, length: 4 * 1024 * 1024 });
        if (chunk.data.length) await room.files.writeExport(stream.token, chunk.data);
        offset = chunk.nextOffset;
        if (chunk.eof) break;
      }
      return await room.files.finishExport(stream.token);
    } catch (error) { if (stream) await room.files.abortExport(stream.token).catch(() => {}); throw error; }
    finally { await room.artifacts.remove(artifact.id).catch(() => {}); }
  }

  async function convert() {
    const item = selected();
    const target = ui.targetFormat.value;
    if (state.busy || !item || !Core.CONVERTIBLE.includes(item.kind) || !Core.CONVERTIBLE.includes(target) || item.kind === target) return;
    updateBusy(true);
    try {
      let markdown = item.markdown;
      if (item.kind === "pdf" && !markdown) {
        setStatus("正在提取 PDF 的文字层…");
        const extracted = await Core.pdfToMarkdown(item.pdf, (current, total) => setStatus(`正在提取 PDF 文字：${current} / ${total} 页`));
        markdown = extracted.markdown;
        item.missingPdfPages = extracted.missingPages;
        item.markdown = markdown;
      }
      if (!markdown?.trim()) throw new Error("文档没有可转换的文字");
      const name = Core.cleanName(item.name);
      let result;
      if (target === "md") result = await room.files.exportText(`${name}.md`, markdown);
      else if (target === "docx") {
        setStatus("正在排版 Word 文档…");
        const content = await Core.markdownToDocx(markdown, name);
        result = await room.files.exportBinary(`${name}.docx`, content);
      } else {
        setStatus("正在排版中文 PDF 文档…");
        result = await exportPdfArtifact(markdown, name);
      }
      const missingPages = result && item.missingPdfPages ? `；${item.missingPdfPages} 页无文字层，请先 OCR 再补齐` : "";
      setStatus(result ? `已保存 ${name}.${target}${missingPages}` : `已取消保存 ${TARGETS[target]}，原文档未改变`);
    } catch (error) { setStatus(`转换失败：${error.message || error}`, true); }
    finally { updateBusy(false); }
  }

  ui.openFile.addEventListener("click", openFile);
  ui.openFromWelcome.addEventListener("click", openFile);
  ui.closeDocument.addEventListener("click", () => { if (state.activeId) closeDocument(state.activeId); });
  ui.convertButton.addEventListener("click", convert);
  ui.targetFormat.addEventListener("change", () => { ui.convertButton.disabled = state.busy || !ui.targetFormat.value; });
  ui.previousPage.addEventListener("click", () => { const item = selected(); if (item && item.page > 1) { item.page -= 1; renderActive(); } });
  ui.nextPage.addEventListener("click", () => { const item = selected(); if (item && item.page < (item.kind === "pdf" ? item.pdf.numPages : item.presentation.slides.length)) { item.page += 1; renderActive(); } });
  ui.sheetPicker.addEventListener("change", () => { const item = selected(); if (item?.kind === "xlsx") { item.sheetIndex = Number(ui.sheetPicker.value); item.rowPage = 0; renderActive(); } });
  ui.previousRows.addEventListener("click", () => { const item = selected(); if (item?.kind === "xlsx" && item.rowPage > 0) { item.rowPage -= 1; renderActive(); } });
  ui.nextRows.addEventListener("click", () => { const item = selected(); if (item?.kind === "xlsx") { item.rowPage += 1; renderActive(); } });
  ui.zoomOut.addEventListener("click", () => { const item = selected(); if (item?.kind === "pdf") { item.zoom = Math.max(.5, Math.round((item.zoom - .25) * 4) / 4); renderActive(); } });
  ui.zoomIn.addEventListener("click", () => { const item = selected(); if (item?.kind === "pdf") { item.zoom = Math.min(2.5, Math.round((item.zoom + .25) * 4) / 4); renderActive(); } });
  ui.preview.addEventListener("click", (event) => { if (event.target.closest("a")) event.preventDefault(); });
  window.addEventListener("beforeunload", () => { clearPreviewResources(); for (const item of state.documents) item.pdf?.loadingTask?.destroy().catch(() => {}); });
  updateHeader();
  document.documentElement.dataset.roomReady = "true";
})();
