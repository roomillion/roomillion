package io.roomillion.android

import android.content.Intent
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WorkbenchAssistantTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun evaluate(view: WebView, code: String): String { val latch = CountDownLatch(1); var value = ""; instrumentation.runOnMainSync { view.evaluateJavascript(code) { value = it; latch.countDown() } }; assertTrue(latch.await(10, TimeUnit.SECONDS)); return value }
    private fun waitFor(view: WebView, code: String, expected: String) { repeat(240) { if (evaluate(view, code).contains(expected)) return; Thread.sleep(100) }; error("期望 $expected，实际 ${evaluate(view, "document.body.innerText")}") }
    private inner class Fixture : AutoCloseable {
        val root = File(context.cacheDir, "assistant-test-${System.nanoTime()}").apply { mkdirs() }
        val store = RoomPackageStore(File(root, "rooms"))
        val inventory: InstalledRoom
        val documents: InstalledRoom
        val meeting: InstalledRoom
        val models = AiModelStore(context)
        val profile = models.saveProfile(null, "助手隔离测试", "https://example.invalid/v1/chat/completions", "test-tools", "")
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        val runtimes = mutableMapOf<String, RoomRuntime>()
        lateinit var surface: FrameLayout
        val actions: AndroidRoomActions
        val sessions: WorkbenchAssistantStore
        var view: WorkbenchAssistantView? = null
        init {
            inventory = instrumentation.context.assets.open("inventory.room").use { store.install(it) }
            documents = instrumentation.context.assets.open("document-workbench.room").use { store.install(it) }
            meeting = instrumentation.context.assets.open("meeting-actions.room").use { store.install(it) }
            instrumentation.runOnMainSync { surface = FrameLayout(activity); activity.setContentView(surface) }
            actions = AndroidRoomActions(File(root, "tasks"), store, { room ->
                var result: RoomRuntime? = null
                instrumentation.runOnMainSync { result = runtimes[room.id] ?: RoomRuntime(activity, room, RoomGrants(), actionHost = actionsRef()).also { runtimes[room.id] = it; surface.addView(it.webView, FrameLayout.LayoutParams(1, 1)) } }
                result!!
            }, {}, { view?.tasksChanged() })
            sessions = WorkbenchAssistantStore(File(root, "sessions"), actions, {})
        }
        private fun actionsRef() = actions
        fun open(provider: (JSONObject, AiRequestCancellation) -> JSONObject) { instrumentation.runOnMainSync { view = WorkbenchAssistantView(activity, models, sessions, actions, provider); surface.addView(view!!.webView, FrameLayout.LayoutParams(-1, -1)) }; waitFor(view!!.webView, "document.documentElement.dataset.assistantReady", "true"); evaluate(view!!.webView, "document.querySelector('#model').value=${JSONObject.quote(profile)}") }
        fun start(room: InstalledRoom, action: String, input: JSONObject, key: String = "t_${System.nanoTime()}", session: String = "test"): JSONObject { val task = actions.start(session, room.id, action, input, key); return actions.waitTask(session, task.getString("id"), 10000) }
        override fun close() { actions.close(); instrumentation.runOnMainSync { view?.close(); runtimes.values.forEach { it.close() }; activity.finish() }; models.remove(profile); Thread.sleep(200); root.deleteRecursively() }
    }
    @Test fun actionsValidateInputsBindRepliesAndRequireConfirmation() { Fixture().use { f ->
        assertTrue(runCatching { f.actions.start("test", f.inventory.id, "add", JSONObject().put("name", "bad").put("quantity", -1), "bad") }.isFailure)
        val first = f.start(f.inventory, "add", JSONObject().put("name", "铅笔").put("quantity", 5), "once"); assertEquals(first.toString(), f.start(f.inventory, "add", JSONObject().put("name", "铅笔").put("quantity", 5), "once").toString())
        assertEquals("completed", first.getString("status")); assertTrue(runCatching { f.actions.get("other", first.getString("id")) }.isFailure)
        val id = first.getJSONObject("result").getInt("id")
        val deletion = f.start(f.inventory, "remove", JSONObject().put("id", id)); assertEquals("confirmation", deletion.getString("status"))
        assertEquals(1, f.start(f.inventory, "list", JSONObject()).getJSONObject("result").getJSONArray("rows").length())
        f.actions.confirm("test", deletion.getString("id"), true); assertEquals("completed", f.actions.waitTask("test", deletion.getString("id"), 10000).getString("status"))
        assertEquals(0, f.start(f.inventory, "list", JSONObject()).getJSONObject("result").getJSONArray("rows").length())
        evaluate(f.runtimes.getValue(f.inventory.id).webView, "room.actions.register('undeclared',()=>{}).catch(e=>window.registrationError=e.message)")
        waitFor(f.runtimes.getValue(f.inventory.id).webView, "window.registrationError", "声明")
        assertTrue(evaluate(f.runtimes.getValue(f.inventory.id).webView, "typeof window.AssistantNative").contains("undefined"))
        assertTrue(runCatching { f.actions.receive(f.runtimes.getValue(f.inventory.id), JSONObject().put("taskId", first.getString("id")).put("ok", true)) }.isFailure)
        val confirmation = f.start(f.inventory, "remove", JSONObject().put("id", id)); val manifest = File(f.inventory.program, "manifest.json"); manifest.writeText(JSONObject(manifest.readText()).put("version", "1.0.2").toString())
        assertTrue(runCatching { f.actions.confirm("test", confirmation.getString("id"), true) }.isFailure)
        f.actions.setAccess(f.inventory.id, false); assertTrue(runCatching { f.start(f.inventory, "list", JSONObject()) }.isFailure)
    } }
    @Test fun foregroundNavigationRetainsRunningRoomThenReleasesIdleInstance() {
        val root = File(context.cacheDir, "assistant-lifecycle-${System.nanoTime()}").apply { mkdirs() }
        val id = "io.roomillion.test.assistant.lifecycle"; val store = RoomPackageStore(File(context.filesDir, "rooms")); val models = AiModelStore(context)
        val profile = models.saveProfile(null, "助手生命周期测试", "https://example.invalid/v1/chat/completions", "test-tools", "")
        val source = File(root, "source"); File(source, "app").mkdirs()
        File(source, "manifest.json").writeText(JSONObject().put("formatVersion", "0.1").put("id", id).put("name", "助手生命周期测试").put("version", "1.0.0").put("runtime", JSONObject().put("roomSdk", "1")).put("entry", "app/index.html").put("actions", JSONArray().put(JSONObject().put("id", "delay").put("name", "等待").put("description", "等待明确结束信号").put("effect", "write").put("inputSchema", JSONObject().put("type", "object")))).toString())
        File(source, "app/index.html").writeText("<!doctype html><script src='main.js'></script>")
        File(source, "app/main.js").writeText("room.actions.register('delay',async()=>{await new Promise(resolve=>window.finishAssistantTask=resolve);return {finished:true}});")
        val archive = File(root, "test.room"); RoomAgentWorkspace.pack(source, archive); archive.inputStream().use { store.install(it) }
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        fun field(name: String): Any? = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)
        var sessionId = ""
        try {
            instrumentation.runOnMainSync { activity.openWorkbenchAssistant() }
            val view = field("assistantView") as WorkbenchAssistantView
            waitFor(view.webView, "document.documentElement.dataset.assistantReady", "true")
            evaluate(view.webView, "document.querySelector('#new').click()")
            Thread.sleep(500); waitFor(view.webView, "document.documentElement.dataset.assistantReady", "true")
            val current = WorkbenchAssistantView::class.java.getDeclaredField("currentSession").apply { isAccessible = true }.get(view) as String; sessionId = current
            val actions = MainActivity::class.java.getDeclaredField("assistantActions\$delegate").apply { isAccessible = true }.get(activity) as Lazy<*>
            val dispatcher = actions.value as AndroidRoomActions
            val task = dispatcher.start(current, id, "delay", JSONObject(), "lifecycle")
            var roomRuntime: RoomRuntime? = null
            repeat(150) { if (roomRuntime == null) { instrumentation.runOnMainSync { @Suppress("UNCHECKED_CAST") val rooms = field("assistantRooms") as Map<String, RoomRuntime>; roomRuntime = rooms[id] }; Thread.sleep(50) } }
            waitFor(roomRuntime!!.webView, "typeof window.finishAssistantTask", "function")
            instrumentation.runOnMainSync { (field("content") as android.widget.LinearLayout).let { container -> (container.getChildAt(0) as android.widget.Button).performClick() } }
            assertEquals("running", dispatcher.get(current, task.getString("id")).getString("status"))
            evaluate(roomRuntime!!.webView, "window.finishAssistantTask()")
            assertEquals("completed", dispatcher.waitTask(current, task.getString("id"), 10000).getString("status"))
            repeat(100) { var retained = false; instrumentation.runOnMainSync { @Suppress("UNCHECKED_CAST") val rooms = field("assistantRooms") as Map<String, RoomRuntime>; retained = rooms.containsKey(id) }; if (retained) Thread.sleep(50) }
            instrumentation.runOnMainSync { @Suppress("UNCHECKED_CAST") val rooms = field("assistantRooms") as Map<String, RoomRuntime>; assertFalse(rooms.containsKey(id)) }
            instrumentation.runOnMainSync { activity.openWorkbenchAssistant() }; assertEquals(current, WorkbenchAssistantView::class.java.getDeclaredField("currentSession").apply { isAccessible = true }.get(view))
            instrumentation.runOnMainSync { activity.openRoomAgent(id) }
            val whileEditing = dispatcher.start(current, id, "delay", JSONObject(), "editing")
            assertEquals("failed", dispatcher.waitTask(current, whileEditing.getString("id"), 10000).getString("status"))
        } finally {
            instrumentation.runOnMainSync { activity.finish() }; models.remove(profile); store.uninstall(id)
            if (sessionId.isNotBlank()) { File(context.filesDir, "workbench-assistant/$sessionId.json").delete(); File(context.filesDir, "workbench-assistant/$sessionId").deleteRecursively(); File(context.filesDir, "assistant-tasks").listFiles().orEmpty().filter { it.name.startsWith("task_") && runCatching { JSONObject(it.readText()).optString("sessionId") == sessionId }.getOrDefault(false) }.forEach { it.delete() } }
            root.deleteRecursively()
            File(context.filesDir, "room-agent/$id").deleteRecursively()
        }
    }
    @Test fun privateFilesTransferOnlyWhenPublishedAndInterruptedWritesNeverReplay() { Fixture().use { f ->
        f.start(f.inventory, "add", JSONObject().put("name", "铅笔").put("quantity", 5))
        val exported = f.start(f.inventory, "export", JSONObject().put("format", "markdown")); val artifact = exported.getJSONArray("artifacts").getJSONObject(0)
        val source = f.actions.publishedFile("test", exported.getString("id"), artifact.getString("id")); val copied = f.actions.transfer(source.second, source.first, f.documents.id)
        assertNotEquals(artifact.getString("id"), copied.getString("id"))
        val pdf = f.start(f.documents, "convert-markdown", JSONObject().put("artifactId", copied.getString("id")).put("format", "pdf")); assertEquals("completed", pdf.getString("status")); val file = f.actions.publishedFile("test", pdf.getString("id"), pdf.getJSONArray("artifacts").getJSONObject(0).getString("id")).second
        assertEquals("%PDF-", file.inputStream().use { String(it.readUpTo(5)) })
        assertTrue(runCatching { f.actions.publishedFile("other", exported.getString("id"), artifact.getString("id")) }.isFailure)
        assertTrue(runCatching { f.actions.publishedFile("test", exported.getString("id"), copied.getString("id")) }.isFailure)
        val taskFile = File(f.root, "tasks/${exported.getString("id")}.json"); val task = JSONObject(taskFile.readText()).put("status", "running").put("effect", "write"); RoomAgentWorkspace.atomic(taskFile, task.toString())
        val restored = AndroidRoomActions(File(f.root, "tasks"), f.store, { error("must not replay") }, {})
        try { assertEquals("uncertain", restored.get("test", exported.getString("id")).getString("status")); assertEquals(exported.getString("id"), restored.start("test", f.inventory.id, "export", JSONObject().put("format", "markdown"), task.getString("callKey")).getString("id")) } finally { restored.close() }
        val session = f.sessions.create().getString("id"); val attachment = f.sessions.attach(session, "test.md", "text/markdown", "# 附件".byteInputStream())
        assertFalse(attachment.has("path")); assertTrue(runCatching { f.sessions.tool(f.sessions.create().getString("id"), "file_other", "transfer_room_file", JSONObject().put("fileId", attachment.getString("id")).put("targetRoomId", f.documents.id)) }.isFailure)
        assertTrue(f.sessions.recover(session, "unknown", "call_room_action").getBoolean("isError"))
        val meeting = f.start(f.meeting, "add", JSONObject().put("title", "验收助手").put("owner", "小明").put("priority", "中").put("dueDate", "2026-10-20")); assertEquals("completed", meeting.getString("status"))
        assertEquals("completed", f.start(f.meeting, "set-status", JSONObject().put("id", meeting.getJSONObject("result").getInt("id")).put("status", "done")).getString("status"))
    } }
    @Test fun actualPiAssistantRunsMultipleTurnsRetriesTransfersAndRecoversConversation() { Fixture().use { f ->
        var calls = 0; var failed = false; var lastTask = ""; var exportTask = ""; var exportedArtifact = ""; var importedArtifact = ""
        fun response(args: JSONObject, cancellation: AiRequestCancellation): JSONObject {
            cancellation.check(); val history = args.getJSONArray("messages"); val last = history.getJSONObject(history.length() - 1)
            val users = (0 until history.length()).map { history.getJSONObject(it) }.filter { it.getString("role") == "user" }; val turn = users.size
            var name = ""; var input = JSONObject()
            if (turn == 2 && !failed) { failed = true; error("隔离测试网络断开") }
            if (last.getString("role") == "user") { name = "call_room_action"; input = when (turn) {
                1 -> JSONObject().put("roomId", f.inventory.id).put("actionId", "add").put("input", JSONObject().put("name", "铅笔").put("quantity", 5))
                2 -> JSONObject().put("roomId", f.inventory.id).put("actionId", "set-quantity").put("input", JSONObject().put("id", 1).put("quantity", 8))
                3 -> JSONObject().put("roomId", f.inventory.id).put("actionId", "export").put("input", JSONObject().put("format", "markdown"))
                4 -> JSONObject().put("roomId", f.inventory.id).put("actionId", "remove").put("input", JSONObject().put("id", 1))
                else -> JSONObject().put("roomId", f.inventory.id).put("actionId", "list").put("input", JSONObject())
            } } else if (last.getString("role") == "tool") {
                val value = JSONObject(last.getString("content")); val previousCalls = history.getJSONObject(history.length() - 2).getJSONArray("tool_calls"); val previous = previousCalls.getJSONObject(0).getJSONObject("function").getString("name")
                if (previous == "call_room_action" || previous == "get_room_task") {
                    lastTask = value.getString("id")
                    if (value.getString("status") in setOf("running", "queued")) { name = "get_room_task"; input.put("taskId", lastTask).put("waitMs", 1000) }
                    else if (turn == 3 && value.optString("actionId") == "export" && value.getString("status") == "completed") { exportTask = lastTask; exportedArtifact = value.getJSONArray("artifacts").getJSONObject(0).getString("id"); name = "transfer_room_file"; input.put("taskId", exportTask).put("artifactId", exportedArtifact).put("targetRoomId", f.documents.id) }
                } else if (previous == "transfer_room_file") { importedArtifact = value.getString("artifactId"); name = "call_room_action"; input.put("roomId", f.documents.id).put("actionId", "convert-markdown").put("input", JSONObject().put("artifactId", importedArtifact).put("format", "pdf")) }
            }
            return JSONObject().put("text", if (name.isBlank()) "本轮完成 $turn" else "").put("toolCalls", JSONArray().apply { if (name.isNotBlank()) put(JSONObject().put("id", "call_${++calls}").put("name", name).put("arguments", input.toString())) })
        }
        f.open(::response)
        fun send(text: String, turn: Int) { evaluate(f.view!!.webView, "document.querySelector('#prompt').value=${JSONObject.quote(text)};document.querySelector('#form').requestSubmit()"); waitFor(f.view!!.webView, "document.querySelector('#messages').textContent", "本轮完成 $turn"); waitFor(f.view!!.webView, "document.querySelector('#send').disabled", "false") }
        send("登记 5 支铅笔", 1)
        val initialSession = f.sessions.list().getJSONObject(0).getString("id")
        assertEquals(f.sessions.read(initialSession).getJSONArray("messages").toString(), 1, f.start(f.inventory, "list", JSONObject()).getJSONObject("result").getJSONArray("rows").length())
        send("改成 8 支", 2); send("把物资清单转成 PDF", 3)
        val session = f.sessions.list().getJSONObject(0).getString("id"); val pdfTasks = f.actions.list(session); assertTrue((0 until pdfTasks.length()).any { pdfTasks.getJSONObject(it).optString("actionId") == "convert-markdown" && pdfTasks.getJSONObject(it).optString("status") == "completed" })
        assertTrue(failed); assertEquals(f.actions.list(session).toString(), 1, f.start(f.inventory, "list", JSONObject()).getJSONObject("result").getJSONArray("rows").length()); assertEquals(8, f.start(f.inventory, "list", JSONObject()).getJSONObject("result").getJSONArray("rows").getJSONObject(0).getInt("quantity"))
        send("删除铅笔", 4); assertEquals("confirmation", f.actions.get(session, lastTask).getString("status"))
        evaluate(f.view!!.webView, "document.querySelector('#taskTab').click();[...document.querySelectorAll('#tasks button')].find(b=>b.textContent==='确认执行').click()")
        repeat(100) { if (f.actions.get(session, lastTask).getString("status") == "confirmation") Thread.sleep(50) }
        assertEquals("completed", f.actions.waitTask(session, lastTask, 10000).getString("status"))
        evaluate(f.view!!.webView, "document.querySelector('#chatTab').click()"); send("再检查结果", 5)
        assertEquals(0, f.start(f.inventory, "list", JSONObject()).getJSONObject("result").getJSONArray("rows").length())
        instrumentation.runOnMainSync { f.view!!.close(); f.surface.removeAllViews(); f.runtimes.values.forEach { f.surface.addView(it.webView, FrameLayout.LayoutParams(1, 1)) }; f.view = null }
        f.open(::response); assertEquals(5, f.sessions.read(session).getJSONArray("messages").let { messages -> (0 until messages.length()).count { messages.getJSONObject(it).optString("role") == "user" } })
        assertTrue(evaluate(f.view!!.webView, "document.querySelector('#messages').innerText").contains("再检查结果")); assertTrue(evaluate(f.view!!.webView, "document.documentElement.scrollWidth<=document.documentElement.clientWidth+2").contains("true"))
    } }
}
