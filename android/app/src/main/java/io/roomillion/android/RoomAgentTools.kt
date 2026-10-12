package io.roomillion.android

import org.json.JSONArray
import org.json.JSONObject

object RoomAgentTools {
    fun declarations(): JSONArray {
        fun field(type: String, description: String = "") = JSONObject().put("type",type).put("description",description)
        fun tool(name: String,description: String,fields: Map<String,JSONObject> = emptyMap(),required: List<String> = emptyList()): JSONObject =
            JSONObject().put("name",name).put("description",description).put("parameters",JSONObject().put("type","object")
                .put("properties",JSONObject(fields)).put("required",JSONArray(required)).put("additionalProperties",false))
        val step=JSONObject().put("type","object").put("properties",JSONObject()
            .put("type",field("string").put("enum",JSONArray(listOf("click","input","assert_text","assert_count","wait"))))
            .put("selector",field("string")).put("text",field("string")).put("count",field("integer")))
            .put("required",JSONArray(listOf("type","selector"))).put("additionalProperties",false)
        return JSONArray(listOf(
            tool("inspect_capabilities","查看当前安卓 SDK、离线模块和隔离测试边界"),
            tool("inspect_room","列出当前房间开发副本的清单、文件和修订；不读取业务数据"),
            tool("read_file","分页读取程序源码",mapOf("path" to field("string"),"offset" to field("integer"),"length" to field("integer")),listOf("path")),
            tool("write_file","写入当前草稿的完整文本文件；revision 必须是最新修订",mapOf("path" to field("string"),"text" to field("string"),"revision" to field("integer")),listOf("path","text","revision")),
            tool("patch_file","替换源码中唯一匹配的原文；revision 必须是最新修订",mapOf("path" to field("string"),"search" to field("string"),"replacement" to field("string"),"revision" to field("integer")),listOf("path","search","replacement","revision")),
            tool("test_room","在独立安卓测试进程验证启动、重开和业务动作，至少包含一个结果断言。AI 模拟响应按调用顺序提供；不联网、不选择真实文件、不读取原房间数据",mapOf(
                "actions" to field("array").put("items",step).put("minItems",1).put("maxItems",60),
                "aiResponses" to field("array").put("items",field("string")),"pickText" to field("object").put("properties",JSONObject().put("name",field("string")).put("text",field("string")))),listOf("actions")),
            tool("apply_room","应用已测试的当前草稿，保留业务数据和上一版；变更权限时用户需点击应用更新确认"),
            tool("rollback_room","恢复此开发会话保存的上一版程序，保留业务数据")
        ))
    }
    fun capabilities(): JSONObject = JSONObject().put("platform","android").put("modules",JSONArray(AndroidModuleCatalog.supported.toList()))
        .put("roomActions", "可在 manifest.actions 声明 id/name/description/effect/inputSchema/outputSchema，并调用 room.actions.register(id, async(input,context)=>result)。effect 为 read/write/destructive/external；删除和对外发送由工作台助手确认。context 提供 report/isCancelled/throwIfCancelled。result.artifacts 可发布本房间制品 ID，助手负责受控传递文件；不共享数据库、路径或密钥。复用按钮业务逻辑，测试按钮行为及操作结果；大数据通过制品发布。")
        .put("sdk",JSONArray(listOf("getInfo","db.query/run","storage.get/set","ai.listModels/generate/onModelsChanged","blobs/artifacts","files.pickText/pickBinary/openBinary/readBinary/closeBinary/exportText/exportBinary/beginExport/writeExport/finishExport/abortExport","documents.markdownToPdf","multiplayer.getStatus/create/join/send/read/leave")))
        .put("limits",JSONObject().put("aiMediaBytes",AiMediaCodec.MAX_REQUEST_BYTES).put("directBinaryBytes",32*1024*1024))
        .put("test", "独立进程、空白业务数据；只使用提供的 AI/文本文件模拟，禁止真实模型、文件选择器和联机。声明 actions 检查修改后的实际行为。")
}
