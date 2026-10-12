# 参与开发

当前为技术预览。提交改动前请阅读房间规范、权限规则及相关测试；不要绕过受控接口，让房间直接访问系统文件或密钥。

公开仓库只包含八个内置示例房间，以 src/main/example-catalog.cjs 的清单为准。未公开示例及相关素材、用户数据和房间包不得加入仓库；新增公开示例需明确确认可公开，并同步更新清单、打包配置与回归测试。内部设计和验收记录保留在本地 docs/，不提交到公开仓库。

## 本地验证

使用 Node.js 22 或更新的兼容版本及 npm：

```sh
npm ci
npm run build:resources
npm test
npm run smoke
```

首次安装依赖需要互联网；离线使用发行版与离线从源码构建是不同需求。Windows 发布使用 `npm run release:portable`，递增一次版本，再运行 `npm run build:portable-folder` 输出同版本目录 ZIP。不要手工改临时版本名。

新增接口要提供参数校验、权限/房间隔离和失败用例；UI 变更应给出对应操作的回归记录。测试仅使用虚构数据，调用真实 AI API 前明确用途及用量。

贡献原创代码适用仓库 Apache-2.0 许可；引入第三方内容时保留其原有许可和署名，并更新依赖清单。不要复制来源不明的许可文本。

安全问题按 `SECURITY.md` 私密报告；普通问题请提供版本、系统、预期结果和最小复现，截图先脱敏。

## 向工作台助手开放房间功能

这是房间提供给助手的接口，与房间调用宿主工具的 `room.tools` 不同。接口随 `.room` 分发；无需接入的房间保持原来的使用方式。在 `manifest.json` 中声明 `actions`，或通过 AI 建房的 `begin_custom_room.actions` 设置：

```json
{
  "actions": [{
    "id": "add",
    "name": "登记物资",
    "description": "新增一条物资记录",
    "effect": "write",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "quantity": { "type": "integer", "minimum": 0 }
      },
      "required": ["name", "quantity"],
      "additionalProperties": false
    }
  }]
}
```

启动时注册处理函数，复用按钮的业务逻辑。兼容尚未提供接口的宿主时先检测 `room.actions`：

```js
if (room.actions) {
  await room.actions.register("add", async (input, context) => {
    context.throwIfCancelled();
    await context.report("正在登记");
    return addInventory(input); // 与表单共用，返回 JSON
  });
}
```

`effect` 为 `read`（查询）、`write`（普通写入）、`destructive`（删除等破坏性操作）或 `external`（对外发送）；后两者需要工作台用户确认。作用类型是开发者声明，不能替代运行权限：数据、AI、网络、文件请求仍经过原有权限检查。助手访问可逐房间关闭，房间不能调用工作台助手 API 或直接访问其他房间的数据。

参数和可选的 `outputSchema` 支持基础 JSON Schema：`type`、`description`、`properties`、`required`、`additionalProperties`（布尔值）、`items`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`minItems`、`maxItems`。不支持引用或组合 schema；输入顶层为对象。未声明的操作、重复 ID、不合法参数和跨房间响应会被拒绝。

桌面单次 JSON 结果最多 8 MiB；安卓受消息桥限制，结果 JSON 必须小于 900,000 字符，单文件沿用 64 MiB 上限。大文件用 `room.artifacts` 保存，并返回 `{ artifacts: [item.id] }`。只发布本次任务需要的文件；工作台仅允许当前对话访问任务明确发布的当前房间制品，复制到目标房间时仍检查数据权限，不共享数据库、真实路径或密钥。文件可由助手传给另一个房间，或由用户在执行记录中保存。桌面与安卓实验宿主共用声明和注册接口；兼容两端的房间也需要遵守各自模块及文件能力范围。

操作可以通过 `context.isCancelled()` / `throwIfCancelled()` 协作停止；`context.taskId` 可用作业务幂等标识。停止聊天不会自动停止房间任务。进程重启不会恢复房间中的 JavaScript 执行：已完成结果仍可查询，未完成查询可重试，执行中写入标为 `uncertain`，需核实后再操作，不能宣称严格的跨进程恰好一次执行。接口变更应更新房间版本，并覆盖连续操作、取消、重启、权限撤销及旧版本升级测试。
