package io.roomillion.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Persistent conversations and a tool journal. An unknown write is never replayed on reopen. */
class WorkbenchAssistantStore(private val root: File, private val actions: AndroidRoomActions,
    private val openRoom: (String) -> Unit) {
    init { root.mkdirs() }
    private fun file(id: String): File { require(id.matches(Regex("[a-f0-9-]{36}"))) { "助手对话 ID 无效" }; return File(root, "$id.json") }
    @Synchronized fun read(id: String): JSONObject = JSONObject(RoomAgentWorkspace.readAtomic(file(id)))
    @Synchronized private fun write(session: JSONObject) { RoomAgentWorkspace.atomic(file(session.getString("id")), session.toString()) }
    @Synchronized fun list(): JSONArray = JSONArray(root.listFiles().orEmpty().filter { it.name.matches(Regex("[a-f0-9-]{36}\\.json")) }.map { JSONObject(RoomAgentWorkspace.readAtomic(it)) }.sortedByDescending { it.optLong("updatedAt") }.map { JSONObject().put("id", it.getString("id")).put("title", it.getString("title")) })
    @Synchronized fun create(): JSONObject {
        val session = JSONObject().put("id", UUID.randomUUID().toString()).put("title", "新的助手对话").put("messages", JSONArray()).put("files", JSONArray()).put("journal", JSONObject()).put("retries", 2).put("thinking", "medium").put("updatedAt", System.currentTimeMillis())
        write(session); return session
    }
    @Synchronized fun save(id: String, input: JSONObject): JSONObject {
        val session = read(id); val messages = input.getJSONArray("messages"); require(messages.toString().length <= 4_000_000) { "对话过长，请导出并建立新对话" }
        for (i in 0 until messages.length()) require(messages.getJSONObject(i).getString("role") in setOf("system", "user", "assistant", "toolResult"))
        val retries = input.getInt("retries"); require(retries in 0..5)
        val thinking = input.getString("thinking"); require(thinking in setOf("off", "low", "medium", "high"))
        session.put("messages", JSONArray(messages.toString())).put("profileId", input.optString("profileId")).put("retries", retries).put("thinking", thinking).put("running", input.optBoolean("running")).put("updatedAt", System.currentTimeMillis())
        if (session.getString("title") == "新的助手对话") (0 until messages.length()).map { messages.getJSONObject(it) }.firstOrNull { it.getString("role") == "user" }?.let { session.put("title", textOf(it).take(30)) }
        write(session); return JSONObject().put("saved", true)
    }
    @Synchronized fun publicSession(id: String): JSONObject { val session = read(id); session.remove("journal"); session.put("tasks", actions.list(id)).put("interrupted", session.optBoolean("running")); return session }
    @Synchronized fun attach(id: String, name: String, mimeType: String, input: java.io.InputStream): JSONObject {
        val session = read(id); val fileId = "file_" + UUID.randomUUID().toString().replace("-", ""); val folder = File(root, id).apply { mkdirs() }; val destination = File(folder, fileId)
        try {
            destination.outputStream().use { output -> val buffer = ByteArray(256 * 1024); var total = 0L; while (true) { val n = input.read(buffer); if (n < 0) break; total += n; require(total <= RoomBlobStore.MAX_BLOB_BYTES) { "附件超过安卓文件大小上限 64 MiB" }; output.write(buffer, 0, n) } }
            val item = JSONObject().put("id", fileId).put("name", name.replace(Regex("[\\/\\\\\\u0000-\\u001f]"), "_").take(200)).put("mimeType", mimeType.take(160)).put("size", destination.length())
            session.getJSONArray("files").put(item); write(session); return item
        } catch (e: Exception) { destination.delete(); throw e }
    }
    @Synchronized private fun taskForCall(session: String, key: String): JSONObject? {
        // The original task ID is in the journal's result; interrupted starts are
        // resolved by the action service's durable call key through existingTask.
        return actions.existingTask(session, key)
    }
    @Synchronized fun recover(id: String, key: String, name: String): JSONObject {
        require(key.matches(Regex("[A-Za-z0-9_-]{1,120}"))) { "工具调用 ID 无效" }
        val session = read(id); val journal = session.getJSONObject("journal").optJSONObject(key)
        if (journal?.optBoolean("done") == true) return JSONObject().put("value", journal.opt("result") ?: JSONObject.NULL)
        if (name == "call_room_action") taskForCall(id, key)?.let { return JSONObject().put("value", it) }
        if (journal != null && name == "transfer_room_file") { journal.put("uncertain", true); write(session) }
        return JSONObject().put("isError", true).put("value", JSONObject().put("interrupted", true).put("message", "工具曾中断，结果未确认。先查看任务或房间状态，不要重复写入。"))
    }
    fun tool(id: String, key: String, name: String, args: JSONObject): Any {
        require(key.matches(Regex("[A-Za-z0-9_-]{1,120}"))) { "工具调用 ID 无效" }
        synchronized(this) {
            val session = read(id); val journal = session.getJSONObject("journal"); val old = journal.optJSONObject(key)
            if (old?.optBoolean("done") == true) return old.opt("result") ?: JSONObject.NULL
            require(old?.optBoolean("uncertain") != true) { "此前文件传递结果不确定，请先检查目标房间" }
            // Read-only calls can safely retry; writes may only resolve an already saved task.
            if (old != null && name == "call_room_action") taskForCall(id, key)?.let { return it }
            if (old != null && name in setOf("call_room_action", "transfer_room_file")) error("此前操作结果不确定，请先检查房间")
            journal.put(key, JSONObject().put("name", name).put("done", false)); write(session)
        }
        val result: Any = when (name) {
            "find_rooms" -> { val all = actions.catalog(args.optString("query")); val offset = args.optInt("offset", 0); val limit = args.optInt("limit", 20); require(offset >= 0 && limit in 1..100); val page = JSONArray(); for (i in offset until minOf(all.length(), offset + limit)) page.put(all.get(i)); JSONObject().put("rooms", page).put("total", all.length()).put("nextOffset", if (offset + limit < all.length()) offset + limit else JSONObject.NULL) }
            "inspect_room_actions" -> actions.definitions(args.getString("roomId"))
            "call_room_action" -> { val task = actions.start(id, args.getString("roomId"), args.getString("actionId"), args.getJSONObject("input"), key); actions.waitTask(id, task.getString("id"), 1000) }
            "get_room_task" -> if (!args.has("taskId")) actions.list(id) else {
                val wait = args.optInt("waitMs", 0); require(wait in 0..10000); val result = actions.waitTask(id, args.getString("taskId"), wait)
                if (args.has("offset")) { val text = (actions.get(id, args.getString("taskId")).opt("result") ?: JSONObject.NULL).toString(); val offset = args.getInt("offset"); val limit = args.optInt("limit", 16000); require(offset >= 0 && limit in 1..24000); result.remove("result"); result.put("text", text.substring(offset.coerceAtMost(text.length), (offset.toLong() + limit).coerceAtMost(text.length.toLong()).toInt())).put("characters", text.length) }; result
            }
            "cancel_room_task" -> actions.cancel(id, args.getString("taskId"))
            "open_room" -> { actions.definitions(args.getString("roomId")); openRoom(args.getString("roomId")); JSONObject().put("opened", args.getString("roomId")) }
            "transfer_room_file" -> {
                val source = if (args.has("fileId")) {
                    val fileId = args.getString("fileId"); require(fileId.matches(Regex("file_[a-f0-9]{32}")))
                    val files = read(id).getJSONArray("files"); val item = (0 until files.length()).map { files.getJSONObject(it) }.firstOrNull { it.getString("id") == fileId } ?: error("附件不属于当前对话")
                    item to File(File(root, id), fileId)
                } else actions.publishedFile(id, args.getString("taskId"), args.getString("artifactId"))
                val item = actions.transfer(source.second, source.first, args.getString("targetRoomId")); JSONObject().put("targetRoomId", args.getString("targetRoomId")).put("artifactId", item.getString("id")).put("name", item.getString("name")).put("size", item.getLong("size"))
            }
            else -> error("不支持的助手工具")
        }
        synchronized(this) { val session = read(id); session.getJSONObject("journal").put(key, JSONObject().put("name", name).put("done", true).put("result", result)); write(session) }
        return result
    }
    companion object { fun textOf(m: JSONObject): String { val content = m.opt("content"); return if (content is String) content else if (content is JSONArray) (0 until content.length()).mapNotNull { content.optJSONObject(it)?.takeIf { it.optString("type") == "text" }?.optString("text") }.joinToString("\n") else "" } }
}
