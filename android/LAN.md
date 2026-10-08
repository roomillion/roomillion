# 房间联机接口（首版）

桌面工作台和安卓手机均可作为主机或玩家。用户先连接同一个可互通的局域网，再使用主机分享的加入信息；安卓也可以先开启手机热点，供其他设备连接。无需互联网、云端服务器或额外依赖；AI 模型调用仍按各宿主的 AI 配置运行。

工作台原生服务处理连接与消息，房间只处理游戏规则和界面。两端均提供 `room.multiplayer`，与普通 `room.network` 和互联网开关独立。首版使用 TLS 加密的可靠消息连接；加入信息包含主机证书指纹，客户端先核对证书，再提交加入凭证。以后附近直连可以提供另一种网络链路，继续使用同一套房间接口。

## 房间声明与授权

```json
{"permissions":{"multiplayer":["host","join"]}}
```

AI 建房工具使用 `capabilities.multiplayer` 声明同样的数组。导入后的房间需要用户授权；不能借另一个房间的会话交换消息。桌面和安卓均可创建或加入，`getStatus().canHost` 为 `true`。

## 接口

| 方法 | 行为 |
| --- | --- |
| `getStatus()` | 返回 `supported/canHost/transport/role/connected/peerId/sessionId`；主机另外返回 `invitations` 与 `peers` |
| `create({name,maxPlayers})` | 桌面或安卓创建游戏；总人数包括主机，默认 16，允许 2–32。应先连接局域网或开启手机热点；硬件实际可连接人数仍受网络设备限制 |
| `join({invitation,name})` | 加入相同房间 ID、相同版本的游戏；`invitation` 是主机分享的完整字符串 |
| `send(data,{to})` | 主机默认 `to:'all'`，也可指定玩家 `peerId`；玩家只能发给 `host`。返回宿主生成的消息 `id`，不代表游戏规则已处理完成 |
| `read({timeoutMs})` | 返回 `{events,...状态}`；默认等待最多 15000 毫秒，可指定 0–15000。同一会话只开一个读取循环 |
| `leave()` | 离开游戏；主机调用会结束整场游戏 |

`invitations` 为 `[{host,invitation}]`，有多张网卡时会提供多个地址。选择当前局域网或手机热点对应的地址分享；可以把 `invitation` 用离线二维码模块显示，也可以直接复制。字符串包含加入凭证，不要把它记录到公共日志或发到外网。

电脑和手机连接相同网络后，电脑直接调用 `create()`，无需创建电脑热点。当前使用局域网 IPv4 地址；Windows 首次提示防火墙授权时，允许工作台在当前专用网络接受连接；路由器访客网络的设备隔离会阻止玩家加入。桌面关闭主机房间、撤销开房权限或退出程序会结束游戏，普通标签切换不销毁房间时会继续服务；电脑休眠会中断连接。

```js
const status = await room.multiplayer.getStatus();
if (status.canHost) {
  const game = await room.multiplayer.create({ name: '狼人杀', maxPlayers: 12 });
  // 显示 game.invitations，供玩家复制或扫描。
} else {
  await room.multiplayer.join({ invitation: userInput, name: '玩家' });
}

// 主机发送私密身份；peerId 来自 joined 事件或主机 peers 列表。
await room.multiplayer.send({ type: 'identity', role: 'seer' }, { to: peerId });
// 玩家提交意图，主机核对游戏阶段、玩家身份和是否已经投票。
await room.multiplayer.send({ type: 'vote', target: targetPeerId }, { to: 'host' });
```

读取事件时检查 `type`：

- 主机：`created`、`joined`、`reconnected`、`disconnected`、`left`、`message`。
- 玩家：`connected`、`disconnected`、`message`。
- `message` 含 `{id,from,data}`；玩家收到的 `from` 只能是 `host`，主机收到的 `from` 是宿主绑定的玩家 ID，不能由玩家伪造。
- 加入、重连后，主机应向该玩家发送允许查看的完整状态快照。公开信息广播，身份和私密行动分别发送；不要把全部角色广播后仅在界面隐藏。

```js
let running = true;
async function receive() {
  while (running) {
    const batch = await room.multiplayer.read();
    for (const event of batch.events) handleGameEvent(event);
  }
}
// 停止时先设 running=false，再 leave()；处理异常，避免失败后空转重试。
```

连接短暂中断后，客户端会尝试用原身份重连。等待接收确认的消息会重新发送，并在宿主内存中去重；这不代替房间的游戏规则校验或持久化。消息进入原生队列即确认接收，房间应及时读取，并用自己的状态版本、行动编号及快照处理游戏恢复。

## 当前范围与验收

AI 创建房间的隔离运行检查支持查询 `getStatus()`（返回 `isolated: true`），但不会创建或连接真实联机游戏。该检查可验证离线界面和接口可用性，不能代替跨设备联机测试。

单条 JSON 最多 64 KiB；接收队列和每玩家待发送队列最多 1 MiB，待确认消息最多 128 条。达到上限会拒绝发送或断开相应连接，避免慢玩家占满内存。暂时掉线的座位保留供重连，主动离开后释放。

安卓房间上方的“联机与手机热点”可以自动创建仅本地热点、查看热点名称和密码、复制游戏加入信息，以及结束联机。自动热点需要系统授权；不支持自动创建时，可以在系统设置手动开启热点。结束游戏不会自动停止热点，用户可继续开下一局；工作台销毁时释放本应用创建的热点。

主机有前台服务通知以维持连接进程；关闭、切换房间或销毁工作台会结束该房间的游戏。前台服务不保证 WebView 中的计时器在锁屏时精确运行，房间应按时间戳恢复阶段。当前未实现自动发现、自动传输房间包、Wi-Fi Direct、异地联机、换主机接续或跨进程游戏恢复。

测试覆盖两个安卓客户端的广播/私密消息、错误证书与凭证拒绝、人数上限、重连及未确认消息补发；桌面测试覆盖原生主机/客户端、恶意帧、发送者隔离、授权撤销和关闭清理。跨端验收脚本通过 ADB 转发分别验证安卓主机与桌面玩家、桌面主机与安卓及桌面玩家互通；真实局域网、防火墙、热点无线链路、锁屏省电和厂商设备人数上限仍需多台真机验收。

`node scripts/build-lan-test-room.cjs` 会生成 `release/android-lan-acceptance/房间/局域网联机测试.room`，包含开房、加入、二维码和公开/私密消息按钮。这是虚构数据的验收房间，不进入公开示例目录或 APK 内置示例。安装当前 debug 与 androidTest APK 后，设置 `ANDROID_HOME`，运行 `node scripts/android-lan-interop.cjs emulator-5554` 验证桌面到安卓主机的实际协议。

`node scripts/desktop-lan-android-interop.cjs emulator-5554` 通过 ADB 反向转发验证电脑开房：安卓原生客户端和另一桌面客户端同时加入，并核对广播、私密消息隔离及安卓确认。两套脚本仅接受专用模拟器，不操作用户真机。
