"use strict";

const form = document.getElementById("actionForm");
const actionsRoot = document.getElementById("actions");
const statusRoot = document.getElementById("status");
const brief = document.getElementById("brief");
let rows = [];

function setStatus(message, isError = false) {
  statusRoot.textContent = message;
  statusRoot.style.color = isError ? "#b34834" : "#6f7b8e";
}

function localDate(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function isOverdue(row) {
  return row.status !== "done" && row.due_date < localDate();
}

async function initialize() {
  await window.room.db.run("CREATE TABLE IF NOT EXISTS meeting_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, owner TEXT NOT NULL, due_date TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)");
  const due = new Date();
  due.setDate(due.getDate() + 7);
  form.elements.dueDate.value = localDate(due);
  await refresh();
}

async function refresh() {
  rows = await window.room.db.query("SELECT id, title, owner, due_date, priority, status FROM meeting_actions ORDER BY status ASC, due_date ASC, id DESC");
  document.getElementById("totalCount").textContent = String(rows.length);
  document.getElementById("openCount").textContent = String(rows.filter((row) => row.status === "open").length);
  document.getElementById("overdueCount").textContent = String(rows.filter(isOverdue).length);
  renderRows();
}

function renderRows() {
  const filter = document.getElementById("statusFilter").value;
  const visible = rows.filter((row) => filter === "all" || row.status === filter);
  actionsRoot.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = rows.length ? "当前筛选下没有事项" : "还没有行动项，从左侧添加第一条";
    actionsRoot.appendChild(empty);
    return;
  }
  for (const row of visible) {
    const item = document.createElement("article");
    item.className = `action ${row.status}`;
    const marker = document.createElement("div");
    marker.className = `priority ${row.priority === "高" ? "high" : row.priority === "低" ? "low" : ""}`;
    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = row.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    const owner = document.createElement("span");
    owner.textContent = `负责人：${row.owner}`;
    const due = document.createElement("span");
    due.textContent = `截止：${row.due_date}`;
    if (isOverdue(row)) due.className = "overdue";
    const priority = document.createElement("span");
    priority.textContent = `${row.priority}优先级`;
    meta.append(owner, due, priority);
    content.append(title, meta);
    const controls = document.createElement("div");
    controls.className = "rowActions";
    const toggle = document.createElement("button");
    toggle.textContent = row.status === "done" ? "重新打开" : "标为完成";
    toggle.addEventListener("click", async () => {
      await setActionStatus(row.id, row.status === "done" ? "open" : "done");
    });
    const remove = document.createElement("button");
    remove.className = "delete";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      await removeAction(row.id);
    });
    controls.append(toggle, remove);
    item.append(marker, content, controls);
    actionsRoot.appendChild(item);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  await addAction(values);
  form.elements.title.value = "";
  setStatus("行动项已保存");
  await refresh();
});

document.getElementById("statusFilter").addEventListener("change", renderRows);
document.getElementById("exportButton").addEventListener("click", async () => {
  const csv = actionsCsv(rows);
  const saved = await window.room.files.exportText("会议行动项.csv", `\ufeff${csv}`);
  if (saved) setStatus(`已导出到 ${saved}`);
});
document.getElementById("aiButton").addEventListener("click", async () => {
  try {
    const result = await generateBrief();
    setStatus(`简报已生成 · ${result.model}`);
  } catch (error) { setStatus(error.message, true); }
});
document.getElementById("closeBrief").addEventListener("click", () => { brief.hidden = true; });

function actionsCsv(rows) {
  const escape = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return ["事项,负责人,截止日期,优先级,状态", ...rows.map(row => [row.title, row.owner, row.due_date, row.priority, row.status === "done" ? "已完成" : "进行中"].map(escape).join(","))].join("\n");
}
async function addAction(values) {
  if (!String(values.title).trim() || !String(values.owner).trim() || !/^\d{4}-\d{2}-\d{2}$/.test(values.dueDate) || new Date(values.dueDate).toISOString().slice(0, 10) !== values.dueDate) throw new Error("事项、负责人或日期无效");
  await room.db.run("INSERT INTO meeting_actions(title, owner, due_date, priority, status, created_at) VALUES(?, ?, ?, ?, 'open', ?)", [values.title.trim(), values.owner.trim(), values.dueDate, values.priority, new Date().toISOString()]);
  const [row] = await room.db.query("SELECT id, title, owner, due_date, priority, status FROM meeting_actions ORDER BY id DESC LIMIT 1"); await refresh(); return row;
}
async function requireAction(id) { const [row] = await room.db.query("SELECT id FROM meeting_actions WHERE id = ?", [id]); if (!row) throw new Error("行动项不存在"); }
async function setActionStatus(id, value) { await requireAction(id); await room.db.run("UPDATE meeting_actions SET status = ? WHERE id = ?", [value, id]); await refresh(); return { id, status: value }; }
async function removeAction(id) { await requireAction(id); await room.db.run("DELETE FROM meeting_actions WHERE id = ?", [id]); await refresh(); return { removed: id }; }
async function generateBrief() {
  const current = await room.db.query("SELECT id, title, owner, due_date, priority, status FROM meeting_actions ORDER BY id");
  const result = await room.ai.generate(`请把以下会议行动项整理成简洁的中文推进简报，先写风险与逾期项，再写本周重点，不要编造信息：\n${JSON.stringify(current)}`);
  document.getElementById("briefText").textContent = result.text; brief.hidden = false; return result;
}
initialize().then(async () => {
  if (!room.actions) return;
  await room.actions.register("list", async ({ query = "" }) => ({ rows: (await room.db.query("SELECT id, title, owner, due_date, priority, status FROM meeting_actions ORDER BY id DESC")).filter(row => row.title.includes(query)) }));
  await room.actions.register("add", addAction);
  await room.actions.register("set-status", ({ id, status }) => setActionStatus(id, status));
  await room.actions.register("remove", ({ id }) => removeAction(id));
  await room.actions.register("export", async ({ format }) => {
    const current = await room.db.query("SELECT id, title, owner, due_date, priority, status FROM meeting_actions ORDER BY id");
    const escapeMd = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
    const content = format === "csv" ? "\ufeff" + actionsCsv(current) : ["# 会议行动清单", "", ...current.map(row => `- [${row.status === "done" ? "x" : " "}] ${escapeMd(row.title)} — ${escapeMd(row.owner)}，截止 ${row.due_date}，${row.priority}优先级`)].join("\n");
    const item = await room.artifacts.put(`会议行动清单.${format === "csv" ? "csv" : "md"}`, content, { mimeType: format === "csv" ? "text/csv" : "text/markdown" }); return { count: current.length, artifacts: [item.id] };
  });
  await room.actions.register("brief", async () => { const result = await generateBrief(); const item = await room.artifacts.put("会议推进简报.md", result.text, { mimeType: "text/markdown" }); return { text: result.text, artifacts: [item.id] }; });
}).catch(error => setStatus(error.message, true));
