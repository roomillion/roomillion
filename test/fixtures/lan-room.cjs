"use strict";

// Fake acceptance room, not part of the public example catalog or bundled APK.
const spec = {
  formatVersion: "room-app@1", kind: "custom", name: "局域网联机测试", description: "用于验证电脑或手机开房与电脑、手机加入的消息测试房间", theme: "light",
  hostModules: ["utility.qrcode@1"], capabilities: { database: false, ai: false, files: [], network: [], multiplayer: ["host", "join"] },
  files: {
    html: `<main><h1>局域网联机测试</h1><p>电脑和手机连接同一局域网，并安装同一份测试房间。任选一台设备开房；手机也可以先开启热点供其他设备连接。</p>
<label>昵称<input id="name" value="测试玩家" maxlength="40"></label>
<div class="actions"><button id="create">创建游戏</button><button id="leave" disabled>离开游戏</button></div>
<label>加入信息<textarea id="invitation" rows="3" placeholder="粘贴主机分享的完整加入信息"></textarea></label><button id="join">加入游戏</button>
<section id="sharing" hidden><label>选择主机地址<select id="address"></select></label><canvas id="qr"></canvas><p>扫码可取得加入信息；也可选中上面的文字复制。二维码扫描与粘贴由用户完成。</p></section>
<p id="status" role="status">正在检查联机能力</p>
<label>发送给<select id="target"><option value="host">主机</option></select></label>
<label>消息<input id="message" value="联机测试消息" maxlength="1000"></label><button id="send" disabled>发送消息</button>
<h2>收到的消息</h2><pre id="log" aria-live="polite"></pre></main>`,
    css: `*{box-sizing:border-box}body{margin:0;background:#f5f8f5;color:#163b30;font-family:system-ui,sans-serif}main{max-width:780px;margin:auto;padding:20px}label{display:block;margin:12px 0}input,textarea,select{display:block;width:100%;font:inherit;padding:10px;margin-top:6px;border:1px solid #b5cec4;border-radius:10px;background:white}button{font:inherit;padding:10px 18px;border:0;border-radius:12px;background:#23684f;color:white;margin:5px 5px 5px 0}button:disabled{opacity:.45}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e5f0e9;padding:12px;border-radius:12px;max-height:40vh;overflow:auto}canvas{max-width:100%;height:auto}#status{font-weight:600}.actions{display:flex;flex-wrap:wrap}`,
    javascript: `const el = id => document.getElementById(id);
let running = false, busy = false, role = null;
function log(text) { el('log').textContent = (el('log').textContent + text + '\\n').slice(-20000); }
function report(error) { el('status').textContent = error.message || String(error); }
async function refresh() {
  const state = await room.multiplayer.getStatus(); role = state.role;
  el('create').disabled = busy || running || !state.canHost;
  el('join').disabled = busy || running; el('leave').disabled = !running;
  el('send').disabled = !state.connected; el('status').textContent = state.connected ? (role === 'host' ? '主机已开启' : '已加入游戏') : (role ? '连接中断，正在重连' : '尚未开房或加入');
  const selected = el('target').value; el('target').replaceChildren();
  const add = (value, text) => { const option = document.createElement('option'); option.value = value; option.textContent = text; el('target').append(option); };
  if (role === 'host') { add('all','所有玩家（公开）'); for (const peer of state.peers || []) add(peer.peerId, peer.name + (peer.connected ? '（私密）' : '（掉线）')); }
  else add('host','主机');
  if ([...el('target').options].some(option => option.value === selected)) el('target').value = selected;
  return state;
}
async function receive() {
  try { while (running) {
    const batch = await room.multiplayer.read(); if (!running) break;
    for (const event of batch.events) {
      if (event.type === 'message') log(event.from + '：' + JSON.stringify(event.data));
      else log(event.type + (event.name ? '：' + event.name : ''));
    }
    await refresh();
  } } catch (error) { if (running) { running = false; report(error); el('leave').disabled = false; } }
}
async function enter(action) {
  if (busy || running) return; busy = true; await refresh();
  try { const state = await action(); running = true;
    el('sharing').hidden = state.role !== 'host';
    if (state.role === 'host') {
      el('address').replaceChildren();
      for (const entry of state.invitations || []) { const option = document.createElement('option'); option.value = entry.invitation; option.textContent = entry.host; el('address').append(option); }
      await share();
    }
    await refresh(); receive();
  } catch (error) { report(error); } finally { busy = false; el('create').disabled = running || !(await room.multiplayer.getStatus()).canHost; el('join').disabled = running; }
}
async function share() { el('invitation').value = el('address').value; await QRCode.toCanvas(el('qr'), el('invitation').value, {width:320}); }
el('address').addEventListener('change', () => share().catch(report));
el('create').addEventListener('click', () => enter(() => room.multiplayer.create({name:'联机测试',maxPlayers:16})).catch(report));
el('join').addEventListener('click', () => enter(() => room.multiplayer.join({invitation:el('invitation').value.trim(),name:el('name').value})).catch(report));
el('send').addEventListener('click', async () => { try { await room.multiplayer.send({note:el('message').value},{to:el('target').value}); log('已发送：'+el('message').value); } catch (error) { report(error); } });
el('leave').addEventListener('click', async () => { running = false; await room.multiplayer.leave(); el('sharing').hidden = true; await refresh(); });
refresh().catch(report);`
  }
};
module.exports = { spec, roomId: "cn.roomillion.test.lan-probe" };
