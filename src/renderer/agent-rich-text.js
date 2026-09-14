"use strict";
// A deliberately small Markdown subset: no HTML, images, URLs or executable attributes.
function renderAgentRichText(target, input) {
  const doc = target.ownerDocument;
  const raw = String(input || "").replace(/\r\n/g, "\n");
  const text = raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");
  target.replaceChildren();
  const inline = (parent, value) => {
    for (const token of value.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
      const tag = token.startsWith("**") && token.endsWith("**") ? "strong" : token.startsWith("`") && token.endsWith("`") ? "code" : null;
      if (tag) { const node = doc.createElement(tag); node.textContent = token.slice(tag === "strong" ? 2 : 1, tag === "strong" ? -2 : -1); parent.append(node); }
      else parent.append(doc.createTextNode(token));
    }
  };
  const lines = text.split("\n");
  let list = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { list = null; continue; }
    if (line.trim().startsWith("```")) {
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i]);
      const pre = doc.createElement("pre"); pre.textContent = code.join("\n"); target.append(pre); list = null; continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) {
      const table = doc.createElement("table");
      const row = (value, header) => { const tr = doc.createElement("tr"); for (const cell of value.trim().replace(/^\||\|$/g, "").split("|")) { const td = doc.createElement(header ? "th" : "td"); inline(td, cell.trim()); tr.append(td); } table.append(tr); };
      row(line, true); i++;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) row(lines[++i], false);
      const wrapper = doc.createElement("div"); wrapper.className = "agentTableScroll"; wrapper.append(table); target.append(wrapper); list = null; continue;
    }
    const item = /^\s*(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const type = item[1] ? "UL" : "OL";
      if (list?.tagName !== type) { list = doc.createElement(type.toLowerCase()); target.append(list); }
      const li = doc.createElement("li"); inline(li, item[2]); list.append(li); continue;
    }
    list = null;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const paragraph = doc.createElement(heading ? "h4" : "p"); inline(paragraph, heading ? heading[1] : line); target.append(paragraph);
  }
}
if (typeof module !== "undefined") module.exports = { renderAgentRichText };
