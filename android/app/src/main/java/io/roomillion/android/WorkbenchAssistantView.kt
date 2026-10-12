package io.roomillion.android

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/** Trusted Pi page with a distinct origin; no assistant bridge is injected into rooms. */
class WorkbenchAssistantView(private val activity: MainActivity, private val models: AiModelStore,
    private val sessions: WorkbenchAssistantStore, private val actions: AndroidRoomActions,
    private val modelRequest: ((JSONObject, AiRequestCancellation) -> JSONObject)? = null) {
    val webView = WebView(activity)
    private val worker = Executors.newSingleThreadExecutor()
    private val providerCatalog = AiProviderCatalog(activity)
    private val gateway = RoomAgentGateway(models, supportsThinking = { model -> providerCatalog.find(model.providerId)?.models?.firstOrNull { it.id == model.model }?.reasoning == true })
    private val origin = "https://assistant.roomillion.invalid"
    @Volatile private var cancellation: AiRequestCancellation? = null
    @Volatile private var closed = false
    @Volatile private var currentSession = ""
    init { configure() }
    @SuppressLint("SetJavaScriptEnabled") private fun configure() {
        require(androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_MESSAGE_LISTENER)) { "系统 WebView 缺少安全消息桥能力" }
        webView.settings.apply { javaScriptEnabled = true; domStorageEnabled = false; allowFileAccess = false; allowContentAccess = false; javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false) }
        val loader = WebViewAssetLoader.Builder().setDomain("assistant.roomillion.invalid").addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(activity)).build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                if (request.url.scheme != "https" || request.url.host != "assistant.roomillion.invalid" || request.url.port != -1 || !request.url.path.orEmpty().startsWith("/assets/assistant/")) return denied()
                val result = loader.shouldInterceptRequest(request.url) ?: return denied()
                result.responseHeaders = mapOf("Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options" to "nosniff"); return result
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        WebViewCompat.addWebMessageListener(webView, "AssistantNative", setOf(origin)) { view, message, source, main, reply ->
            if (closed || view !== webView || !main || source.toString() != origin) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener; if (raw.length > 5_000_000) return@addWebMessageListener
            try {
                val request = JSONObject(raw); val id = request.getString("id"); require(id.matches(Regex("[0-9]{1,12}")))
                val method = request.getString("method"); val args = request.optJSONObject("args") ?: JSONObject()
                fun finish(result: Result<Any>) { activity.runOnUiThread { if (!closed) reply.postMessage(result.fold({ JSONObject().put("id", id).put("ok", true).put("result", it) }, { JSONObject().put("id", id).put("ok", false).put("error", it.message ?: "助手操作失败") }).toString()) } }
                when (method) {
                    "cancel" -> { cancellation?.cancel(); finish(Result.success(JSONObject().put("stopped", true))) }
                    "copy" -> { val text = args.getString("text"); require(text.length <= 2_000_000); (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("工作台助手", text)); finish(Result.success(JSONObject())) }
                    "attach" -> {
                        val session = currentSession; sessions.read(session)
                        activity.selectBinary({ uri -> if (uri == null) finish(Result.success(JSONObject().put("cancelled", true))) else worker.execute { finish(runCatching {
                            check(!closed); val name = activity.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "附件"
                            val item = activity.contentResolver.openInputStream(uri)?.use { sessions.attach(session, name, activity.contentResolver.getType(uri) ?: "application/octet-stream", it) } ?: error("无法读取附件"); JSONObject().put("file", item).put("session", sessions.publicSession(session))
                        }) } }, { finish(Result.failure(it)) })
                    }
                    "saveArtifact" -> {
                        val session = currentSession
                        worker.execute { val result = runCatching { actions.publishedFile(session, args.getString("taskId"), args.getString("artifactId")) }; activity.runOnUiThread {
                            if (closed) return@runOnUiThread
                            result.onFailure { finish(Result.failure(it)) }.onSuccess { (item, _) -> activity.saveBinary(item.getString("name"), { uri ->
                                if (uri == null) finish(Result.success(JSONObject().put("cancelled", true))) else worker.execute { finish(runCatching {
                                    check(!closed); val source = actions.publishedFile(session, args.getString("taskId"), args.getString("artifactId")).second
                                    activity.contentResolver.openOutputStream(uri, "wt")?.use { output -> source.inputStream().use { it.copyTo(output) } } ?: error("无法保存文件")
                                    JSONObject().put("saved", item.getString("name"))
                                }) }
                            }, { finish(Result.failure(it)) }) }
                        } }
                    }
                    "export" -> worker.execute { val result = runCatching { sessions.publicSession(currentSession).toString(2) }; activity.runOnUiThread { if (!closed) result.onSuccess { activity.exportText("工作台助手对话.json", it, { finish(Result.success(JSONObject().put("exported", true))) }, { finish(Result.failure(it)) }) }.onFailure { finish(Result.failure(it)) } } }
                    else -> {
                        val token = if (method == "model") AiRequestCancellation().also { cancellation = it } else null
                        worker.execute { finish(runCatching { check(!closed); token?.check(); dispatch(method, args, token) }) }
                    }
                }
            } catch (_: Exception) { /* Invalid messages grant no capabilities. */ }
        }
        webView.loadUrl("$origin/assets/assistant/index.html")
    }
    private fun denied() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    private fun dispatch(method: String, args: JSONObject, token: AiRequestCancellation?): Any = when (method) {
        "load" -> {
            val id = if (args.optBoolean("create")) sessions.create().getString("id") else args.optString("sessionId").ifBlank { sessions.list().optJSONObject(0)?.getString("id") ?: sessions.create().getString("id") }
            currentSession = id
            JSONObject().put("session", sessions.publicSession(id)).put("sessions", sessions.list()).put("models", models.listPublic()).put("catalog", actions.catalog()).put("tools", JSONArray(activity.assets.open("assistant/tools.json").bufferedReader().use { it.readText() }))
        }
        "save" -> sessions.save(currentSession, args)
        "models" -> models.listPublic()
        "state" -> JSONObject().put("sessionId", currentSession).put("tasks", actions.list(currentSession)).put("sessions", sessions.list()).put("catalog", actions.catalog())
        "model" -> { val active = requireNotNull(token); args.put("sessionId", currentSession); try { modelRequest?.invoke(args, active) ?: gateway.complete(args, active) } finally { if (cancellation === active) cancellation = null } }
        "tool" -> sessions.tool(currentSession, args.getString("id"), args.getString("name"), args.getJSONObject("args"))
        "recover" -> sessions.recover(currentSession, args.getString("id"), args.getString("name"))
        "confirm" -> actions.confirm(currentSession, args.getString("taskId"), args.getBoolean("allowed"))
        "cancelTask" -> actions.cancel(currentSession, args.getString("taskId"))
        "access" -> actions.setAccess(args.getString("roomId"), args.getBoolean("enabled"))
        else -> error("不支持的助手操作")
    }
    fun tasksChanged() {
        val session = currentSession; if (closed || session.isBlank()) return
        val tasks = actions.list(session)
        activity.runOnUiThread { if (!closed && currentSession == session) webView.evaluateJavascript("window.assistantTasksChanged && window.assistantTasksChanged(${JSONObject.quote(session)},$tasks);", null) }
    }
    fun close() { if (closed) return; closed = true; cancellation?.cancel(); worker.shutdownNow(); webView.stopLoading(); (webView.parent as? android.view.ViewGroup)?.removeView(webView); webView.destroy() }
}
