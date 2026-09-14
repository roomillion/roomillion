"use strict";

const form = document.getElementById("itemForm");
const itemsRoot = document.getElementById("items");
const status = document.getElementById("status");
const output = document.getElementById("output");

function setStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#a74732" : "#65786f";
}

async function initialize() {
  const info = await window.room.getInfo();
  document.getElementById("roomIdentity").textContent = info.id.split(".").at(-1);
  await window.room.db.run("CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
  await refresh();
}

async function refresh() {
  const rows = await window.room.db.query("SELECT id, name, quantity, note FROM inventory ORDER BY id DESC");
  itemsRoot.replaceChildren();
  document.getElementById("itemCount").textContent = String(rows.length);
  document.getElementById("totalQuantity").textContent = String(rows.reduce((sum, row) => sum + Number(row.quantity), 0));
  if (!rows.length) {
    const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "还没有物资记录"; itemsRoot.appendChild(empty); return;
  }
  for (const row of rows) {
    const item = document.createElement("article"); item.className = "item";
    const details = document.createElement("div"); const name = document.createElement("strong"); const note = document.createElement("p");
    name.textContent = row.name; note.textContent = row.note || "无备注"; details.append(name, note);
    const quantity = document.createElement("span"); quantity.className = "quantity"; quantity.textContent = String(row.quantity);
    const remove = document.createElement("button"); remove.className = "delete"; remove.textContent = "删除";
    remove.addEventListener("click", async () => { await window.room.db.run("DELETE FROM inventory WHERE id = ?", [row.id]); await refresh(); });
    item.append(details, quantity, remove); itemsRoot.appendChild(item);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  await window.room.db.run("INSERT INTO inventory(name, quantity, note, created_at) VALUES(?, ?, ?, ?)", [values.name, Number(values.quantity), values.note, new Date().toISOString()]);
  form.reset(); form.elements.quantity.value = "1"; setStatus("物资已保存"); await refresh();
});

document.getElementById("pickButton").addEventListener("click", async () => {
  try {
    const file = await window.room.files.pickText();
    if (!file) return;
    output.hidden = false; output.textContent = `${file.name}\n\n${file.text.slice(0, 5000)}`; setStatus("已通过用户授权读取文本文件");
  } catch (error) { setStatus(error.message, true); }
});

document.getElementById("exportButton").addEventListener("click", async () => {
  const rows = await window.room.db.query("SELECT name, quantity, note FROM inventory ORDER BY id");
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = ["name,quantity,note", ...rows.map((row) => [row.name, row.quantity, row.note].map(escape).join(","))].join("\n");
  const saved = await window.room.files.exportText("物资台账.csv", `\ufeff${csv}`);
  if (saved) setStatus(`已导出到 ${saved}`);
});

document.getElementById("aiButton").addEventListener("click", async () => {
  try {
    const rows = await window.room.db.query("SELECT name, quantity, note FROM inventory ORDER BY id");
    const result = await window.room.ai.generate(`请简要分析下面的物资库存，指出库存为零或可能需要关注的项目：\n${JSON.stringify(rows)}`);
    output.hidden = false; output.textContent = result.text; setStatus(`AI 分析完成 · ${result.model}`);
  } catch (error) { setStatus(error.message, true); }
});

initialize().catch((error) => setStatus(error.message, true));
