package io.roomillion.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Trusted dispatch only. Replies are bound to the exact room runtime, task and conversation. */
class AndroidRoomActions(private val root: File, private val store: RoomPackageStore,
    private val acquire: (InstalledRoom) -> RoomRuntime, private val release: (RoomRuntime) -> Unit,
    private val changed: () -> Unit = {}) {
    private data class Handler(val runtime: RoomRuntime, val ids: Set<String>, val fingerprint: String)
    private data class Pending(val runtime: RoomRuntime, val result: CompletableFuture<Any>)
    private val tasks = linkedMapOf<String, JSONObject>()
    private val handlers = ConcurrentHashMap<String, Handler>()
    private val pending = ConcurrentHashMap<String, Pending>()
    private val queues = ConcurrentHashMap<String, java.util.concurrent.ExecutorService>()
    private val accessFile = File(root, "access.json")
    private val access: JSONObject
    @Volatile private var closed = false
    init {
        root.mkdirs(); access = if (accessFile.isFile) JSONObject(RoomAgentWorkspace.readAtomic(accessFile)) else JSONObject()
        root.listFiles().orEmpty().filter { it.name.matches(Regex("task_[a-f0-9]{32}\\.json")) }.forEach { file ->
            val task = JSONObject(RoomAgentWorkspace.readAtomic(file))
            if (task.optString("status") in setOf("queued", "running")) {
                task.put("status", if (task.getString("status") == "queued" || task.getString("effect") == "read") "failed" else "uncertain")
                    .put("error", "工作台曾中断，请查看房间结果；写入结果不确定时不要重复操作。")
                save(task)
            }
            tasks[task.getString("id")] = task
        }
    }
    private fun fingerprint(room: InstalledRoom): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(File(room.program, "manifest.json").readBytes())
        val integrity = File(room.program, "integrity.json"); if (integrity.isFile) digest.update(integrity.readBytes())
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    @Synchronized private fun save(task: JSONObject) { RoomAgentWorkspace.atomic(File(root, "${task.getString("id")}.json"), task.toString()) }
    @Synchronized fun assertAccess(id: String) { check(!closed && access.opt(id) != false) { "该房间已关闭助手访问" } }
    @Synchronized fun setAccess(id: String, enabled: Boolean): Boolean {
        store.readInstalled(id); access.put(id, enabled); RoomAgentWorkspace.atomic(accessFile, access.toString())
        if (!enabled) tasks.values.filter { it.getString("roomId") == id && it.getString("status") !in finalStates }.forEach { cancel(it.getString("sessionId"), it.getString("id")) }
        changed(); return enabled
    }
    fun definitions(id: String): JSONObject {
        val room = store.readInstalled(id)
        return JSONObject().put("roomId", id).put("name", room.name).put("actions", RoomActionSchema.definitions(room.manifest))
    }
    fun catalog(query: String = ""): JSONArray {
        val result = JSONArray(); val terms = query.lowercase().split(Regex("\\s+")).filter { it.isNotBlank() }
        for (room in store.list()) {
            val actions = RoomActionSchema.definitions(room.manifest); val summary = JSONArray()
            for (i in 0 until actions.length()) { val action = actions.getJSONObject(i); summary.put(JSONObject().put("id", action.getString("id")).put("name", action.getString("name")).put("description", action.getString("description")).put("effect", action.getString("effect"))) }
            val item = JSONObject().put("id", room.id).put("name", room.name).put("version", room.version).put("enabled", synchronized(this) { access.opt(room.id) != false }).put("actions", summary)
            if (terms.isEmpty() || terms.any { item.toString().lowercase().contains(it) }) result.put(item)
        }
        return result
    }
    fun register(runtime: RoomRuntime, ids: JSONArray): Boolean {
        val current = store.readInstalled(runtime.room.id)
        require(fingerprint(current) == fingerprint(runtime.room)) { "房间已更新，请重新打开" }
        val definitions = RoomActionSchema.definitions(current.manifest)
        val allowed = (0 until definitions.length()).map { definitions.getJSONObject(it).getString("id") }.toSet()
        val values = (0 until ids.length()).map { ids.getString(it) }.toSet()
        require(values.all { it in allowed }) { "只能注册 manifest.actions 中声明的操作" }
        handlers[current.id] = Handler(runtime, values, fingerprint(current)); return true
    }
    fun invalidate(runtime: RoomRuntime) {
        handlers[runtime.room.id]?.takeIf { it.runtime === runtime }?.let { handlers.remove(runtime.room.id, it) }
        pending.values.filter { it.runtime === runtime }.forEach { it.result.completeExceptionally(IllegalStateException("房间已关闭或重载，请检查操作结果")) }
    }
    @Synchronized fun get(session: String, id: String): JSONObject {
        val task = tasks[id] ?: error("任务不存在"); require(task.getString("sessionId") == session) { "任务不属于当前对话" }; return JSONObject(task.toString())
    }
    @Synchronized fun list(session: String): JSONArray = JSONArray(tasks.values.filter { it.getString("sessionId") == session }.map(::publicTask))
    @Synchronized fun existingTask(session: String, key: String): JSONObject? = tasks.values.firstOrNull { it.getString("sessionId") == session && it.getString("callKey") == key }?.let(::publicTask)
    fun publicTask(task: JSONObject): JSONObject {
        val result = JSONObject(task.toString()); result.remove("sessionId"); result.remove("callKey"); result.remove("fingerprint")
        if (result.getString("status") != "confirmation") result.remove("input")
        if (result.has("result") && result.get("result").toString().length > 24000) result.put("result", JSONObject().put("truncated", true).put("preview", result.get("result").toString().take(24000)))
        return result
    }
    @Synchronized fun start(session: String, roomId: String, actionId: String, input: JSONObject, key: String): JSONObject {
        assertAccess(roomId)
        tasks.values.firstOrNull { it.getString("sessionId") == session && it.getString("callKey") == key }?.let { return publicTask(it) }
        val room = store.readInstalled(roomId); val definitions = RoomActionSchema.definitions(room.manifest)
        val action = (0 until definitions.length()).map { definitions.getJSONObject(it) }.firstOrNull { it.getString("id") == actionId } ?: error("房间没有声明此操作")
        RoomActionSchema.validate(action.getJSONObject("inputSchema"), input)
        val task = JSONObject().put("id", "task_" + UUID.randomUUID().toString().replace("-", "")).put("sessionId", session).put("callKey", key)
            .put("roomId", roomId).put("roomName", room.name).put("fingerprint", fingerprint(room)).put("actionId", actionId).put("name", action.getString("name"))
            .put("effect", action.getString("effect")).put("input", JSONObject(input.toString())).put("createdAt", System.currentTimeMillis()).put("updatedAt", System.currentTimeMillis())
            .put("status", if (action.getString("effect") in setOf("destructive", "external")) "confirmation" else "queued")
        save(task); tasks[task.getString("id")] = task; changed()
        if (task.getString("status") == "queued") schedule(task.getString("id")); return publicTask(task)
    }
    @Synchronized fun confirm(session: String, id: String, allowed: Boolean): JSONObject {
        val task = tasks[id] ?: error("任务不存在"); get(session, id); assertAccess(task.getString("roomId"))
        require(task.getString("status") == "confirmation" && fingerprint(store.readInstalled(task.getString("roomId"))) == task.getString("fingerprint")) { "操作已过期或房间已更新，请重新发起" }
        task.put("status", if (allowed) "queued" else "cancelled"); save(task); changed(); if (allowed) schedule(id); return publicTask(task)
    }
    private fun schedule(id: String) {
        val roomId = synchronized(this) { tasks.getValue(id).getString("roomId") }
        queues.getOrPut(roomId) { Executors.newSingleThreadExecutor() }.execute { run(id) }
    }
    private fun run(id: String) {
        var runtime: RoomRuntime? = null; var dispatched = false
        try {
            val task = synchronized(this) { JSONObject(tasks.getValue(id).toString()) }; if (task.getString("status") != "queued") return
            val roomId = task.getString("roomId"); assertAccess(roomId); val room = store.readInstalled(roomId)
            require(fingerprint(room) == task.getString("fingerprint")) { "房间已更新，请重新发起操作" }
            runtime = acquire(room)
            val deadline = System.currentTimeMillis() + 15000
            while (System.currentTimeMillis() < deadline && handlers[roomId]?.let { it.runtime === runtime && task.getString("actionId") in it.ids } != true) {
                if (get(task.getString("sessionId"), id).getString("status") != "queued") return
                Thread.sleep(50)
            }
            require(handlers[roomId]?.let { it.runtime === runtime && it.fingerprint == task.getString("fingerprint") && task.getString("actionId") in it.ids } == true) { "房间没有注册此操作，请打开检查" }
            val future = CompletableFuture<Any>()
            synchronized(this) {
                assertAccess(roomId); require(fingerprint(store.readInstalled(roomId)) == task.getString("fingerprint")) { "房间已更新" }
                val current = tasks.getValue(id); if (current.getString("status") != "queued") return
                current.put("status", "running"); save(current); pending[id] = Pending(runtime, future); changed(); dispatched = true
            }
            runtime.invokeAction(id, task.getString("actionId"), task.getJSONObject("input"))
            val result = future.get()
            val definitions = RoomActionSchema.definitions(room.manifest); val action = (0 until definitions.length()).map { definitions.getJSONObject(it) }.first { it.getString("id") == task.getString("actionId") }
            action.optJSONObject("outputSchema")?.let { RoomActionSchema.validate(it, result, "output") }
            val artifacts = JSONArray(); val ids = (result as? JSONObject)?.optJSONArray("artifacts") ?: JSONArray()
            for (i in 0 until ids.length()) {
                val item = runtime.assistantArtifact(ids.getString(i)).get().first
                require(item.getString("kind") == "artifact") { "只能发布当前房间的制品" }; artifacts.put(item)
            }
            synchronized(this) { val current = tasks.getValue(id); current.put("status", "completed").put("result", result).put("artifacts", artifacts).put("updatedAt", System.currentTimeMillis()); save(current); changed() }
        } catch (error: Exception) {
            synchronized(this) { val task = tasks.getValue(id); if (task.getString("status") != "cancelled") task.put("status", if (dispatched && task.getString("effect") != "read") "uncertain" else "failed"); task.put("error", (error.cause?.message ?: error.message ?: "房间操作失败").take(2000)); save(task); changed() }
        } finally { pending.remove(id); runtime?.let(release) }
    }
    fun receive(runtime: RoomRuntime, payload: JSONObject): Boolean {
        val id = payload.getString("taskId"); val invocation = pending[id] ?: error("操作响应已过期")
        require(invocation.runtime === runtime) { "操作响应不属于当前房间" }
        if (payload.has("progress")) synchronized(this) { tasks.getValue(id).put("progress", payload.getString("progress").take(1000)); changed() }
        else if (payload.optBoolean("ok")) invocation.result.complete(payload.opt("result") ?: JSONObject.NULL)
        else invocation.result.completeExceptionally(IllegalStateException(payload.optString("error", "房间操作失败").take(2000)))
        return true
    }
    @Synchronized fun cancel(session: String, id: String): JSONObject {
        val task = tasks[id] ?: error("任务不存在"); get(session, id)
        if (task.getString("status") !in finalStates) {
            pending[id]?.let { it.runtime.cancelAction(id); it.result.completeExceptionally(IllegalStateException("用户请求停止，请检查是否已完成部分操作")) }
                ?: run { task.put("status", "cancelled"); save(task); changed() }
        }
        return publicTask(task)
    }
    fun waitTask(session: String, id: String, milliseconds: Int = 0): JSONObject {
        val deadline = System.currentTimeMillis() + milliseconds.coerceIn(0, 10000)
        while (get(session, id).getString("status") in setOf("queued", "running") && System.currentTimeMillis() < deadline) Thread.sleep(50)
        return publicTask(get(session, id))
    }
    fun publishedFile(session: String, taskId: String, artifactId: String): Pair<JSONObject, File> {
        val task = get(session, taskId); assertAccess(task.getString("roomId")); require(task.getString("status") == "completed")
        val artifacts = task.optJSONArray("artifacts") ?: JSONArray()
        require((0 until artifacts.length()).any { artifacts.getJSONObject(it).getString("id") == artifactId }) { "文件不是当前对话任务发布的制品" }
        val room = store.readInstalled(task.getString("roomId")); require(room.manifest.optJSONObject("permissions")?.optString("database") == "private") { "房间缺少私有数据权限" }
        val blobs = RoomBlobStore(room.data); try { return blobs.getFile(artifactId) } finally { blobs.close() }
    }
    fun transfer(file: File, item: JSONObject, targetId: String): JSONObject {
        assertAccess(targetId); val runtime = acquire(store.readInstalled(targetId))
        try { return runtime.copyAssistantFile(file, item) { assertAccess(targetId) }.get() } finally { release(runtime) }
    }
    fun stopRoom(id: String) {
        synchronized(this) { tasks.values.filter { it.getString("roomId") == id && it.getString("status") !in finalStates }.forEach { cancel(it.getString("sessionId"), it.getString("id")) } }
    }
    fun close() { closed = true; pending.values.forEach { it.result.completeExceptionally(IllegalStateException("工作台正在退出，请检查任务结果")) }; queues.values.forEach { it.shutdownNow() } }
    companion object { private val finalStates = setOf("completed", "failed", "cancelled", "uncertain") }
}
