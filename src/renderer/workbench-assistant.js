"use strict";
(() => {
  const api = window.workbench.assistant;
  const byId = id => document.getElementById(`assistant${id}`);
  const dialog = byId("Dialog");
  let current = null, stream = null, lastMessages = "", refreshSequence = 0;
  const statuses = { confirmation: "需要确认", queued: "等待执行", running: "正在执行", completed: "已完成", failed: "执行失败", cancelled: "已取消", uncertain: "需要检查结果" };
  const showError = error => { byId("Status").textContent = formatError(error); };
  const button = (label, operation) => { const node = document.createElement("button"); node.type = "button"; node.className = "secondaryButton"; node.textContent = label; node.onclick = async () => { node.disabled = true; try { await operation(); } catch (error) { showError(error); } finally { node.disabled = false; } }; return node; };
  async function sessions() {
    const list = await api.list(); const select = byId("Session"); select.replaceChildren();
    for (const item of list) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.title; select.append(option); }
    if (current) select.value = current.id;
  }
  function models() {
    const select = byId("Model"); select.replaceChildren();
    const option = document.createElement("option"); option.value = ""; option.textContent = `跟随工作台默认：${state.provider?.label || state.provider?.model || "未配置"}`; select.append(option);
    for (const profile of state.aiProfiles) { const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.label || `${profile.name} · ${profile.model}`; select.append(option); }
    select.value = current?.profileId || "";
  }
  function renderMessages() {
    const key = JSON.stringify(current.messages);
    if (key === lastMessages) return;
    lastMessages = key; stream = null;
    const root = byId("Messages"); const pinned = root.scrollHeight - root.scrollTop - root.clientHeight < 100;
    root.replaceChildren();
    if (!current.messages.length) { const hint = document.createElement("p"); hint.className = "assistantHint"; hint.textContent = "说出你的需求，助手会寻找已安装房间来完成。普通操作直接执行；删除或对外发送会请你确认。"; root.append(hint); }
    for (const message of current.messages) {
      if (!message.text) continue;
      const article = document.createElement("article"); article.className = `assistantMessage ${message.role}`;
      const label = document.createElement("strong"); label.textContent = message.role === "user" ? "你" : "工作台助手";
      const content = document.createElement("div"); content.className = "assistantMessageText"; content.textContent = message.text;
      article.append(label, button("复制", () => window.workbench.copyText(message.text)), content); root.append(article);
    }
    if (pinned) root.scrollTop = root.scrollHeight;
  }
  function renderTasks() {
    const root = byId("Tasks"); const scroll = root.parentElement.scrollTop; root.replaceChildren();
    if (!current.tasks.length) { const hint = document.createElement("p"); hint.textContent = "房间执行任务后，进度和结果会出现在这里。"; root.append(hint); }
    for (const task of current.tasks) {
      const card = document.createElement("article"); card.className = `assistantTask ${task.status}`;
      const title = document.createElement("strong"); title.textContent = `${task.roomName} · ${task.name}`;
      const status = document.createElement("p"); status.textContent = `${statuses[task.status] || task.status}${task.progress ? ` · ${task.progress}` : ""}`; card.append(title, status);
      if (task.error) { const error = document.createElement("p"); error.className = "error"; error.textContent = task.error; card.append(error); }
      if (task.input || task.result !== undefined) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = task.status === "confirmation" ? "查看操作参数" : "查看结果"; const pre = document.createElement("pre"); pre.textContent = JSON.stringify(task.input || task.result, null, 2); details.append(summary, pre); card.append(details); }
      const controls = document.createElement("div"); controls.className = "assistantTaskActions";
      if (task.status === "confirmation") {
        for (const [label, allowed] of [["确认执行", true], ["取消", false]]) controls.append(button(label, async () => { await api.confirm(current.id, task.id, allowed); await refresh(); }));
      } else if (["running", "queued"].includes(task.status)) controls.append(button("停止任务", async () => { await api.cancelTask(current.id, task.id); await refresh(); }));
      controls.append(button("打开房间", async () => { dialog.close(); await openRoom(task.roomId); }));
      for (const artifact of task.artifacts || []) controls.append(button(`保存 ${artifact.name}`, async () => { const saved = await api.saveArtifact(current.id, task.id, artifact.id); if (saved) byId("Status").textContent = `已保存 ${saved.name}`; }));
      card.append(controls); root.append(card);
    }
    root.parentElement.scrollTop = scroll;
  }
  function render() {
    if (!current) return;
    const working = current.status === "working";
    for (const id of ["Model", "Think", "Retry", "Attach"]) byId(id).disabled = working;
    byId("Stop").disabled = !working; byId("Send").disabled = working;
    byId("Think").value = current.thinkingLevel; byId("Retry").value = String(current.maxRetries);
    byId("Model").value = current.profileId || "";
    byId("Status").textContent = current.error || (working ? "助手正在处理；已启动的任务会单独保留" : "对话已保存，可以继续提出需求");
    byId("Files").textContent = current.files.length ? `${current.files.length} 个附件：${current.files.map(file => file.name).join("、")}` : "";
    renderMessages(); renderTasks();
  }
  async function refresh() {
    if (!current) return;
    const id = current.id, sequence = ++refreshSequence;
    const result = await api.get(id);
    if (sequence !== refreshSequence || current?.id !== id) return;
    acceptResponse(result);
  }
  function acceptResponse(result) {
    if (result?.id === current?.id && result.revision >= current.revision) { current = result; render(); }
  }
  async function catalog() {
    const rooms = await api.catalog(); const root = byId("Catalog"); root.replaceChildren();
    for (const room of rooms) {
      const label = document.createElement("label"); const check = document.createElement("input"); check.type = "checkbox"; check.checked = room.enabled;
      check.onchange = async () => { check.disabled = true; try { await api.setAccess(room.id, check.checked); } catch (error) { check.checked = !check.checked; showError(error); } finally { check.disabled = false; } };
      const text = document.createElement("span"); text.textContent = `${room.name} · ${room.actions.length ? `${room.actions.length} 个功能` : "可打开，暂未开放操作"}`; label.append(check, text); root.append(label);
    }
  }
  byId("Button").onclick = async () => {
    try {
      await hideRoomForModal();
      if (elements.generateDialog.open) elements.generateDialog.close();
      if (!current) { const list = await api.list(); current = list.length ? await api.get(list[0].id) : await api.create(); }
      else current = await api.get(current.id);
      await sessions(); models(); await catalog(); render(); if (!dialog.open) dialog.showModal(); byId("Prompt").focus();
    } catch (error) { showToast(formatError(error)); await restoreActiveRoomAfterDialog(); }
  };
  byId("Close").onclick = () => dialog.close();
  byId("AiSettings").onclick = async () => { dialog.close(); try { await showProviderDialog(); } catch (error) { showToast(formatError(error)); } };
  dialog.addEventListener("close", restoreActiveRoomAfterDialog);
  byId("New").onclick = async () => { try { current = await api.create(); lastMessages = ""; await sessions(); models(); render(); } catch (error) { showError(error); } };
  byId("Session").onchange = async event => { const id = event.target.value, sequence = ++refreshSequence; try { const result = await api.get(id); if (sequence !== refreshSequence || byId("Session").value !== id) return; current = result; lastMessages = ""; models(); render(); } catch (error) { showError(error); } };
  for (const id of ["Model", "Think", "Retry"]) byId(id).onchange = async () => { try { acceptResponse(await api.configure(current.id, { profileId: byId("Model").value || null, thinkingLevel: byId("Think").value, maxRetries: Number(byId("Retry").value) })); } catch (error) { showError(error); } };
  byId("Attach").onclick = async () => { try { acceptResponse(await api.attach(current.id)); } catch (error) { showError(error); } };
  byId("Stop").onclick = async () => { try { await api.stop(current.id); await refresh(); } catch (error) { showError(error); } };
  byId("Form").onsubmit = async event => {
    event.preventDefault(); const prompt = byId("Prompt").value.trim(); if (!prompt || !current || current.status === "working") return;
    byId("Send").disabled = true;
    try { const id = current.id; const response = await api.send(id, prompt); if (current?.id === id) { if (response.revision >= current.revision) current = response; byId("Prompt").value = ""; render(); } await sessions(); } catch (error) { showError(error); byId("Send").disabled = false; }
  };
  byId("Prompt").onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); byId("Form").requestSubmit(); } };
  api.onEvent(event => {
    if (!current || event.sessionId !== current.id) return;
    if (event.openRoomId && dialog.open) dialog.close();
    if (event.session && event.session.revision >= current.revision) { current = event.session; render(); }
    if (event.task) { const index = current.tasks.findIndex(task => task.id === event.task.id); if (index < 0) current.tasks.push(event.task); else current.tasks[index] = event.task; if (dialog.open) renderTasks(); }
    if (event.activity) byId("Status").textContent = event.activity.replace(/find_rooms|inspect_room_actions|call_room_action|get_room_task|cancel_room_task|transfer_room_file|open_room/g, name => ({find_rooms:"查找房间",inspect_room_actions:"查看房间功能",call_room_action:"房间功能",get_room_task:"查询任务结果",cancel_room_task:"停止房间任务",transfer_room_file:"传递文件",open_room:"打开房间"})[name]);
    if (event.delta && dialog.open) {
      const root = byId("Messages"); const pinned = root.scrollHeight - root.scrollTop - root.clientHeight < 100;
      if (!stream) { stream = document.createElement("div"); stream.className = "assistantMessage assistant assistantMessageText"; root.append(stream); }
      stream.textContent += event.delta; if (pinned) root.scrollTop = root.scrollHeight;
    }
  });
  window.workbench.onRoomsChanged(() => { if (dialog.open) catalog().catch(showError); });
  window.workbench.onAiStateChanged(() => { if (dialog.open) setTimeout(models, 0); });
})();
