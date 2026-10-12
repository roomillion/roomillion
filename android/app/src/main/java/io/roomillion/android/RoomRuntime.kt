package io.roomillion.android

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.SequenceInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.UUID

data class RoomRuntimeTestOptions(val aiResponses: List<String>, val pickText: JSONObject?,
    val errors: MutableList<String>, val ready: () -> Unit) { var aiIndex=0 }

class RoomRuntime(private val activity: MainActivity, val room: InstalledRoom, private val grants: RoomGrants,
    private val test: RoomRuntimeTestOptions? = null, private val actionHost: AndroidRoomActions? = null) {
    val webView: WebView
    private val host = "r-${sha256(room.id).take(24)}.roomillion.invalid"
    private val origin = "https://$host"
    private val roomUrl = "$origin/room/${room.entry}"
    private val dbWorker = Executors.newSingleThreadExecutor()
    private val fileWorker = Executors.newSingleThreadExecutor()
    private val lanWorker = Executors.newFixedThreadPool(3)
    private var lan: RoomLanSession? = null
    private val binaryFiles = BinaryFileBroker(File(activity.cacheDir, "room-binary-${UUID.randomUUID()}"))
    private val aiMediaFiles = BinaryFileBroker(File(activity.cacheDir, "room-ai-media-${UUID.randomUUID()}"))
    private val aiMediaTokens = mutableSetOf<String>()
    private val activeAiRequests = mutableSetOf<AiRequestCancellation>()
    private val blobStore = RoomBlobStore(room.data)
    private val documents = RoomPdfDocumentService(File(activity.cacheDir, "room-pdf-${room.id.hashCode()}"), blobStore)
    private var openedDatabase: android.database.sqlite.SQLiteDatabase? = null
    private val database: android.database.sqlite.SQLiteDatabase
        get() = openedDatabase ?: run {
            room.data.mkdirs()
            android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(File(room.data, "room.db"), null)
                .also { openedDatabase = it }
        }
    @Volatile private var closed = false
    private val documentStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    init {
        require(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "系统 WebView 缺少安全消息桥能力" }
        webView = WebView(activity)
        configureWebView()
        if(test!=null)webView.webChromeClient=object:android.webkit.WebChromeClient(){
            override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                val text=message.message()
                // Old Android 12 Chromium ignores this newer CSP token and emits
                // an ERROR-level compatibility notice. It is not a room exception.
                val oldWasmNotice=text.startsWith("The source list for the Content Security Policy directive 'script-src' contains an invalid source:") && text.contains("'wasm-unsafe-eval'") && text.endsWith("It will be ignored.")
                if(message.messageLevel()==android.webkit.ConsoleMessage.MessageLevel.ERROR && !oldWasmNotice)test.errors.add(text.take(500))
                return true
            }
        }
        val loader = WebViewAssetLoader.Builder().setDomain(host)
            .addPathHandler("/room/", WebViewAssetLoader.PathHandler { relative -> loadResource(relative) })
            .build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                if (uri.scheme != "https" || uri.host != host || uri.port != -1) return denied()
                if (uri.path == "/_roomillion/bridge.js" && !documentStartSupported) {
                    val bridge=activity.assets.open("room-bridge.js")
                    return serve("bridge.js",if(test==null)bridge else java.io.SequenceInputStream(java.io.ByteArrayInputStream("window.addEventListener('error',e=>console.error(e.message));window.addEventListener('unhandledrejection',e=>console.error(String(e.reason)));".toByteArray()),bridge))
                }
                if (uri.path.orEmpty().startsWith("/_modules/")) return loadModule(uri.path.orEmpty())
                if (!uri.path.orEmpty().startsWith("/room/")) return denied()
                return loader.shouldInterceptRequest(uri) ?: denied()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return uri.scheme != "https" || uri.host != host || !uri.path.orEmpty().startsWith("/room/")
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                actionHost?.invalidate(this@RoomRuntime)
                if (!url.startsWith("$origin/room/")) view.stopLoading()
            }
            override fun onPageFinished(view: WebView,url: String) { test?.ready?.invoke() }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                if(test==null)return false
                test.errors.add("测试页面渲染进程终止");test.ready();return true
            }
        }
        val origins = setOf(origin)
        WebViewCompat.addWebMessageListener(webView, "RoomillionNative", origins) { view, message, sourceOrigin, isMainFrame, reply ->
            if (closed || view !== webView || !isMainFrame || sourceOrigin.toString() != origin) return@addWebMessageListener
            val data = message.data ?: return@addWebMessageListener
            if (data.length > 1_000_000) return@addWebMessageListener
            try {
                val request = JSONObject(data)
                val id = request.getString("id")
                if (!id.matches(Regex("[0-9]{1,12}"))) return@addWebMessageListener
                dispatch(request, { result -> if (!closed) reply.postMessage(JSONObject().put("id", id).put("ok", true).put("result", result).toString()) },
                    { error -> if (!closed) reply.postMessage(JSONObject().put("id", id).put("ok", false).put("error", error.message ?: "操作失败").toString()) },
                    { delta, fullText -> if (!closed) reply.postMessage(JSONObject().put("id", id).put("event", "chunk")
                        .put("delta", delta).put("fullText", fullText).toString()) })
            } catch (_: Exception) { /* malformed messages receive no privileged response */ }
        }
        if (documentStartSupported) {
            val bridge = activity.assets.open("room-bridge.js").bufferedReader().use { it.readText() }
            WebViewCompat.addDocumentStartJavaScript(webView, bridge, origins)
            if(test!=null)WebViewCompat.addDocumentStartJavaScript(webView,"window.addEventListener('error',e=>console.error(e.message));window.addEventListener('unhandledrejection',e=>console.error(String(e.reason)));",origins)
        }
        webView.loadUrl(roomUrl)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(false)
            setAcceptThirdPartyCookies(webView, false)
        }
        webView.setDownloadListener { _, _, _, _, _ -> /* file export goes through the broker */ }
    }

    private fun loadResource(relative: String): WebResourceResponse {
        val path = Uri.decode(relative)
        if (path.isEmpty() || path.startsWith('/') || path.contains('\\') || path.split('/').any { it == ".." || it == "." || it.isEmpty() }) return denied()
        val file = File(room.program, path)
        if (!file.canonicalPath.startsWith(room.program.canonicalPath + File.separator) || !file.isFile) return denied()
        val input = file.inputStream()
        return serve(file.name, if (!documentStartSupported && file.extension.equals("html", ignoreCase = true))
            prependBridge(input) else input)
    }

    /** A local script is inserted before room scripts when the installed WebView lacks document-start scripts. */
    private fun prependBridge(input: InputStream): InputStream {
        val head = input.readUpTo(4096)
        val marker = "<script src=\"/_roomillion/bridge.js\"></script>".toByteArray(Charsets.UTF_8)
        var position = if (head.size >= 3 && head[0] == 0xef.toByte() && head[1] == 0xbb.toByte() &&
            head[2] == 0xbf.toByte()) 3 else 0
        while (position < head.size && head[position] in byteArrayOf(9, 10, 12, 13, 32)) position++
        val doctype = "<!doctype".toByteArray(Charsets.US_ASCII)
        if (position + doctype.size <= head.size && doctype.indices.all { offset ->
                head[position + offset].toInt().toChar().lowercaseChar() == doctype[offset].toInt().toChar()
            }) {
            val end = (position + doctype.size until head.size).firstOrNull { head[it] == '>'.code.toByte() } ?: -1
            position = if (end >= 0) end + 1 else 0
        } else position = if (head.size >= 3 && head[0] == 0xef.toByte() && head[1] == 0xbb.toByte() &&
            head[2] == 0xbf.toByte()) 3 else 0
        val injected = ByteArrayOutputStream(head.size + marker.size)
        injected.write(head, 0, position)
        injected.write(marker)
        injected.write(head, position, head.size - position)
        return SequenceInputStream(ByteArrayInputStream(injected.toByteArray()), input)
    }

    private fun loadModule(rawPath: String): WebResourceResponse {
        val path = Uri.decode(rawPath).removePrefix("/_modules/")
        val parts = path.split('/')
        if (parts.size !in 2..3 || parts.any { !it.matches(Regex("[A-Za-z0-9@._-]{1,140}")) || it == "." || it == ".." }) return denied()
        val id = parts[0]
        if (id !in AndroidModuleCatalog.supported) return denied()
        if (parts.size == 3 && (id != "document.pdf.view@1" ||
            parts[1] !in setOf("cmaps", "standard_fonts", "wasm"))) return denied()
        val declared = room.manifest.optJSONArray("hostModules") ?: return denied()
        if ((0 until declared.length()).none { declared.optString(it) == id }) return denied()
        val asset = "android-modules/${parts.joinToString("/")}"
        return try { serve(parts.last(), activity.assets.open(asset)) } catch (_: Exception) { denied() }
    }

    private fun serve(name: String, input: InputStream): WebResourceResponse {
        val type = when (name.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "wasm" -> "application/wasm"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
        val headers = mapOf(
            "Content-Security-Policy" to "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
            "X-Content-Type-Options" to "nosniff"
        )
        return WebResourceResponse(type, if (type.startsWith("text/") || type == "application/json") "UTF-8" else null,
            200, "OK", headers, input)
    }

    private fun denied(): WebResourceResponse = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
        mapOf("Cache-Control" to "no-store"), ByteArrayInputStream("Forbidden".toByteArray()))

    private fun permitted(kind: String, value: String? = null): Boolean {
        val permissions = room.manifest.optJSONObject("permissions") ?: return false
        return when (kind) {
            "database" -> permissions.optString("database") == "private"
            "files" -> {
                val files = permissions.optJSONArray("files") ?: return false
                val userAllowed = when (value) { "pick" -> grants.pick; "export" -> grants.export; else -> false }
                userAllowed && (0 until files.length()).any { files.optString(it) == value }
            }
            "ai" -> grants.ai && permissions.optJSONObject("ai") != null
            "multiplayer" -> {
                val declared = permissions.optJSONArray("multiplayer") ?: return false
                (0 until declared.length()).any { index -> when (declared.optString(index)) {
                    "host" -> grants.host && (value == null || value == "host")
                    "join" -> grants.join && (value == null || value == "join")
                    else -> false
                } }
            }
            else -> false
        }
    }

    private fun permittedAiRole(role: String): Boolean {
        if (!permitted("ai")) return false
        val roles = room.manifest.optJSONObject("permissions")?.optJSONObject("ai")?.optJSONArray("roles") ?: return false
        return (0 until roles.length()).any { roles.optString(it) == role }
    }

    private fun prepareAiMedia(options: JSONObject): JSONObject {
        val prepared = JSONObject(options.toString())
        var totalBytes = 0L
        val usedTokens = mutableSetOf<String>()
        try {
            for ((field, kind) in listOf("images" to "image", "audio" to "audio")) {
                require(!prepared.has(field) || prepared.optJSONArray(field) != null) { "AI 媒体输入必须是数组" }
                val parts = prepared.optJSONArray(field) ?: continue
                require(parts.length() <= AiMediaCodec.MAX_ITEMS) { "AI 媒体文件过多" }
                val resolved = JSONArray()
                for (index in 0 until parts.length()) {
                    val part = parts.getJSONObject(index)
                    require(part.length() in 1..2 && !part.has("data") &&
                        (part.has("uploadToken") != part.has("blobId"))) { "AI 媒体引用无效" }
                    val staged = if (part.has("blobId")) {
                        require(permitted("database")) { "房间没有私有数据权限" }
                        val (item, file) = blobStore.getFile(part.getString("blobId"))
                        BinaryExport("", item.getString("name"), file, item.getLong("size"))
                    } else {
                        val token = part.getString("uploadToken")
                        require(token in aiMediaTokens && usedTokens.add(token)) { "AI 媒体令牌无效或已使用" }
                        aiMediaFiles.export(token)
                    }
                    totalBytes += staged.size
                    require(totalBytes <= AiMediaCodec.MAX_REQUEST_BYTES) { "单次 AI 媒体总量超过 16 MiB" }
                    resolved.put(AiMediaCodec.resolve(kind, staged, part.optString("mimeType").takeIf { it.isNotBlank() }))
                }
                prepared.put(field, resolved)
            }
            return prepared
        } finally {
            for (token in usedTokens) {
                aiMediaFiles.abortExport(token)
                aiMediaTokens.remove(token)
            }
        }
    }

    private fun dispatch(request: JSONObject, succeed: (Any?) -> Unit, fail: (Exception) -> Unit,
                         chunk: (String, String) -> Unit) {
        try {
            val args = request.optJSONArray("args") ?: JSONArray()
            if(test!=null) {
                val method=request.getString("method")
                when {
                    method=="ai.listModels"->{require(permitted("ai")){"房间没有 AI 权限"};succeed(JSONArray().put(JSONObject().put("id","test-model").put("model","isolated-mock").put("label","隔离模拟模型").put("ready",true).put("isDefault",true).put("supportsImages",true).put("supportsAudio",true).put("input",JSONArray(listOf("text","image","audio")))));return}
                    method=="ai.generate"->{
                        require(permitted("ai")){"房间没有 AI 权限"};args.getString(0)
                        val options=args.optJSONObject(1)?:JSONObject()
                        if((options.optJSONArray("images")?.length()?:0)>0)require(permittedAiRole("vision")){"房间没有视觉 AI 权限"}
                        if((options.optJSONArray("audio")?.length()?:0)>0)require(permittedAiRole("audio")){"房间没有音频 AI 权限"}
                        require(test.aiIndex<test.aiResponses.size){"隔离测试不调用真实 AI，请按调用顺序提供 aiResponses"}
                        val text=test.aiResponses[test.aiIndex++];if(options.optBoolean("stream"))chunk(text,text)
                        succeed(JSONObject().put("text",text).put("model","isolated-mock"));return}
                    method=="files.pickText"->{require(permitted("files","pick")){"房间没有读取文件权限"};succeed(test.pickText?:JSONObject.NULL);return}
                    method=="files.exportText"->{require(permitted("files","export")){"房间没有导出文件权限"};args.getString(1);succeed(JSONObject().put("path","测试导出").put("name",args.getString(0)));return}
                    method.startsWith("files.") || method.startsWith("ai.") && method !in setOf("ai.mediaBegin","ai.mediaWrite","ai.mediaAbort") || method.startsWith("multiplayer.")->{
                        if(method=="multiplayer.getStatus"){require(permitted("multiplayer")){"房间没有局域网联机权限"};succeed(JSONObject().put("supported",true).put("canHost",grants.host).put("connected",false).put("isolated",true))}
                        else if(method=="multiplayer.leave"){require(permitted("multiplayer")){"房间没有局域网联机权限"};succeed(true)}
                        else fail(IllegalStateException("隔离测试不调用真实文件、模型或联机服务"));return
                    }
                }
            }
            when (request.getString("method")) {
                "actions.register" -> {
                    // Validation hosts can register declarations but cannot reach assistant tasks.
                    val ids = args.getJSONArray(0)
                    val allowed = RoomActionSchema.definitions(room.manifest)
                    require((0 until ids.length()).all { i -> (0 until allowed.length()).any { allowed.getJSONObject(it).getString("id") == ids.getString(i) } }) { "只能注册 manifest.actions 中声明的操作" }
                    succeed(actionHost?.register(this, ids) ?: true)
                }
                "actions.reply" -> succeed(requireNotNull(actionHost) { "此环境不接受助手任务响应" }.receive(this, args.getJSONObject(0)))
                "getInfo" -> succeed(JSONObject().put("id", room.id).put("name", room.name).put("version", room.version)
                    .put("limits", JSONObject().put("aiMediaBytes", AiMediaCodec.MAX_REQUEST_BYTES)
                        .put("directBinaryBytes", 32 * 1024 * 1024)))
                "multiplayer.getStatus" -> { require(permitted("multiplayer")) { "房间没有局域网联机权限" }; succeed(multiplayerStatus()) }
                "multiplayer.create", "multiplayer.join", "multiplayer.send", "multiplayer.read", "multiplayer.leave" -> {
                    val method = request.getString("method").substringAfter('.')
                    val permission = when (method) { "create" -> "host"; "join" -> "join"; else -> null }
                    require(permitted("multiplayer", permission)) { "房间没有相应的局域网联机权限" }
                    if (method == "leave") { stopMultiplayer(); succeed(true) }
                    else {
                        val session = lan ?: if (method in setOf("create", "join")) {
                            RoomLanSession(activity.applicationContext, room.id, room.version).also { lan = it }
                        } else error("尚未加入游戏")
                        lanWorker.execute {
                            val result = runCatching { when (method) {
                                "create" -> session.create(lanOptions(args, 0))
                                "join" -> session.join(args.getJSONObject(0))
                                "send" -> session.send(args.get(0), lanOptions(args, 1))
                                else -> session.read(lanOptions(args, 0))
                            } }
                            activity.runOnUiThread {
                                if (!closed) result.onSuccess(succeed).onFailure {
                                    if (method in setOf("create", "join") && lan === session && session.isClosed()) lan = null
                                    fail(it as? Exception ?: Exception(it))
                                }
                            }
                        }
                    }
                }
                "db.query" -> { require(permitted("database")) { "房间没有数据库权限" }; dbAction({ query(args) }, succeed, fail) }
                "db.run" -> { require(permitted("database")) { "房间没有数据库权限" }; dbAction({ run(args) }, succeed, fail) }
                "storage.get" -> { require(permitted("database")) { "房间没有存储权限" }; dbAction({ storageGet(args.getString(0)) }, succeed, fail) }
                "storage.set" -> { require(permitted("database")) { "房间没有存储权限" }; dbAction({ storageSet(args.getString(0), args.get(1)) }, succeed, fail) }
                "blobs.list" -> {
                    require(permitted("database")) { "房间没有私有数据权限" }
                    fileAction({ blobStore.list(args.optJSONObject(0) ?: JSONObject()) }, succeed, fail)
                }
                "blobs.begin" -> {
                    require(permitted("database")) { "房间没有私有数据权限" }
                    fileAction({ blobStore.begin(args.optJSONObject(0) ?: JSONObject()) }, succeed, fail)
                }
                "blobs.write" -> {
                    require(permitted("database")) { "房间没有私有数据权限" }
                    val encoded = args.getString(1)
                    require(encoded.length <= 400_000) { "Blob 分块过大" }
                    fileAction({ blobStore.write(args.getString(0), android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)) }, succeed, fail)
                }
                "blobs.finish" -> {
                    require(permitted("database")) { "房间没有私有数据权限" }
                    fileAction({ blobStore.finish(args.getString(0)) }, succeed, fail)
                }
                "blobs.abort" -> fileAction({ blobStore.abort(args.getString(0)) }, succeed, fail)
                "blobs.read" -> {
                    require(permitted("database")) { "房间没有私有数据权限" }
                    fileAction({ blobStore.read(args.getString(0), args.optJSONObject(1) ?: JSONObject()) }, succeed, fail)
                }
                "blobs.remove" -> {
                    require(permitted("database")) { "房间没有私有数据权限" }
                    fileAction({ blobStore.remove(args.getString(0)) }, succeed, fail)
                }
                "documents.markdownToPdf" -> {
                    require(permitted("database")) { "房间没有私有数据权限" }
                    fileAction({ documents.render(args.get(0), args.optJSONObject(1) ?: JSONObject()) }, succeed, fail)
                }
                "files.pickText" -> {
                    require(permitted("files", "pick")) { "房间没有选择文件权限" }
                    activity.pickText({ succeed(it ?: JSONObject.NULL) }, fail)
                }
                "files.openBinary" -> {
                    require(permitted("files", "pick")) { "房间没有选择文件权限" }
                    val options = args.optJSONObject(0) ?: JSONObject()
                    val maxBytes = if (options.has("maxBytes")) {
                        val value = options.get("maxBytes")
                        require(value is Number && value.toDouble().isFinite() &&
                            value.toDouble() == value.toLong().toDouble() && value.toLong() in 1..BinaryFileBroker.MAX_FILE_BYTES) {
                            "文件大小上限无效"
                        }
                        value.toLong()
                    } else BinaryFileBroker.MAX_FILE_BYTES
                    val extensions = options.optJSONArray("extensions")?.let { array ->
                        require(array.length() <= 40) { "文件类型过多" }
                        (0 until array.length()).map { array.getString(it).lowercase() }.also { items ->
                            require(items.all { it.matches(Regex("[a-z0-9]{1,12}")) }) { "文件类型无效" }
                        }
                    }.orEmpty()
                    activity.selectBinary({ uri ->
                        if (uri == null) { succeed(JSONObject.NULL); return@selectBinary }
                        fileAction({
                            var selectedSize: Long? = null
                            val name = activity.contentResolver.query(uri, arrayOf(
                                android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)
                                ?.use { cursor ->
                                    if (!cursor.moveToFirst()) null else {
                                        val sizeColumn = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                                        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) selectedSize = cursor.getLong(sizeColumn)
                                        val nameColumn = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                                        if (nameColumn >= 0 && !cursor.isNull(nameColumn)) cursor.getString(nameColumn) else null
                                    }
                                } ?: "已选文件"
                            val extension = name.substringAfterLast('.', "").lowercase()
                            require(extensions.isEmpty() || extension in extensions) { "选择的文件类型不在房间允许列表中" }
                            val claimedSize = selectedSize
                            require(claimedSize == null || claimedSize < 0 || claimedSize <= maxBytes) {
                                "选择的文件超过 ${BinaryFileBroker.limitLabel(maxBytes)}；请使用较小文件"
                            }
                            val type = activity.contentResolver.getType(uri) ?: "application/octet-stream"
                            activity.contentResolver.openInputStream(uri)?.use { binaryFiles.import(it, name, type, maxBytes).publicInfo() }
                                ?: error("无法读取选择的文件")
                        }, succeed, fail)
                    }, fail)
                }
                "files.readBinary" -> {
                    require(permitted("files", "pick")) { "房间没有选择文件权限" }
                    val token = args.getString(0)
                    val options = args.optJSONObject(1) ?: JSONObject()
                    val offset = options.optLong("offset", 0)
                    val length = options.optInt("length", BinaryFileBroker.CHUNK_BYTES)
                    fileAction({
                        val (bytes, eof) = binaryFiles.read(token, offset, length)
                        JSONObject().put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                            .put("offset", offset).put("nextOffset", offset + bytes.size).put("eof", eof)
                    }, succeed, fail)
                }
                "files.closeBinary" -> {
                    require(permitted("files", "pick")) { "房间没有选择文件权限" }
                    fileAction({ binaryFiles.close(args.getString(0)) }, succeed, fail)
                }
                "files.beginExport" -> {
                    require(permitted("files", "export")) { "房间没有导出文件权限" }
                    fileAction({ binaryFiles.beginExport(args.optString(0, "export.bin")).let {
                        JSONObject().put("token", it.token).put("path", it.name).put("name", it.name).put("bytes", 0)
                    } }, succeed, fail)
                }
                "files.writeExport" -> {
                    require(permitted("files", "export")) { "房间没有导出文件权限" }
                    val encoded = args.getString(1)
                    require(encoded.length <= 400_000) { "导出分块过大" }
                    fileAction({ JSONObject().put("bytes", binaryFiles.writeExport(args.getString(0),
                        android.util.Base64.decode(encoded, android.util.Base64.DEFAULT))) }, succeed, fail)
                }
                "files.finishExport" -> {
                    require(permitted("files", "export")) { "房间没有导出文件权限" }
                    val token = args.getString(0)
                    val export = binaryFiles.export(token)
                    activity.saveBinary(export.name, { uri ->
                        if (uri == null) { succeed(JSONObject.NULL); return@saveBinary }
                        fileAction({
                            require(export.file.isFile && export.file.length() == export.size) { "导出内容已变化" }
                            activity.contentResolver.openOutputStream(uri, "wt")?.use { output ->
                                export.file.inputStream().use { it.copyTo(output) }
                            } ?: error("无法写入所选位置")
                            binaryFiles.abortExport(token)
                            JSONObject().put("path", export.name).put("name", export.name).put("bytes", export.size)
                        }, succeed, fail)
                    }, fail)
                }
                "files.abortExport" -> {
                    require(permitted("files", "export")) { "房间没有导出文件权限" }
                    fileAction({ binaryFiles.abortExport(args.getString(0)) }, succeed, fail)
                }
                "files.exportText" -> {
                    require(permitted("files", "export")) { "房间没有导出文件权限" }
                    activity.exportText(args.getString(0), args.getString(1), { succeed(it ?: JSONObject.NULL) }, fail)
                }
                "ai.listModels" -> { require(permitted("ai")) { "房间没有 AI 权限" }; succeed(activity.listAiModels()) }
                "ai.mediaBegin" -> {
                    val kind = args.getString(0)
                    require(kind == "image" || kind == "audio") { "AI 媒体类型无效" }
                    require(permittedAiRole(if (kind == "image") "vision" else "audio")) { "房间没有对应的图片或音频 AI 权限" }
                    fileAction({
                        require(aiMediaTokens.size < AiMediaCodec.MAX_ITEMS) { "暂存的 AI 媒体文件过多" }
                        aiMediaFiles.beginExport("ai-$kind.bin").let {
                            aiMediaTokens.add(it.token)
                            JSONObject().put("token", it.token).put("maxChunkBytes", BinaryFileBroker.CHUNK_BYTES)
                        }
                    }, succeed, fail)
                }
                "ai.mediaWrite" -> {
                    require(permitted("ai")) { "房间没有 AI 权限" }
                    val token = args.getString(0)
                    val encoded = args.getString(1)
                    require(encoded.length <= 400_000) { "AI 媒体分块过大" }
                    fileAction({
                        require(token in aiMediaTokens) { "AI 媒体令牌无效或已过期" }
                        val bytes = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)
                        require(aiMediaTokens.sumOf { aiMediaFiles.export(it).size } + bytes.size <= AiMediaCodec.MAX_REQUEST_BYTES) {
                            "AI 媒体暂存总量超过 16 MiB"
                        }
                        val size = aiMediaFiles.writeExport(token, bytes)
                        JSONObject().put("bytes", size)
                    }, succeed, fail)
                }
                "ai.mediaAbort" -> {
                    require(permitted("ai")) { "房间没有 AI 权限" }
                    fileAction({ aiMediaTokens.remove(args.getString(0)) && aiMediaFiles.abortExport(args.getString(0)) }, succeed, fail)
                }
                "ai.generate" -> {
                    require(permitted("ai")) { "房间没有 AI 权限" }
                    val prompt = args.getString(0)
                    val options = args.optJSONObject(1) ?: JSONObject()
                    if ((options.optJSONArray("images")?.length() ?: 0) > 0) require(permittedAiRole("vision")) { "房间没有视觉 AI 权限" }
                    if ((options.optJSONArray("audio")?.length() ?: 0) > 0) require(permittedAiRole("audio")) { "房间没有音频 AI 权限" }
                    val cancellation = AiRequestCancellation()
                    activeAiRequests.add(cancellation)
                    fileWorker.execute {
                        val result = runCatching { prepareAiMedia(options) }
                        activity.runOnUiThread {
                            if (closed) {
                                cancellation.cancel()
                                activeAiRequests.remove(cancellation)
                            } else result.onSuccess { prepared -> activity.generateAi(prompt, prepared,
                                { activeAiRequests.remove(cancellation); succeed(it) },
                                { activeAiRequests.remove(cancellation); fail(it) },
                                chunk, cancellation) }
                                .onFailure { activeAiRequests.remove(cancellation); fail(it as? Exception ?: Exception(it)) }
                        }
                    }
                }
                else -> fail(IllegalArgumentException("安卓工作台尚不支持此房间接口"))
            }
        } catch (error: Exception) { fail(error) }
    }

    private fun dbAction(action: () -> Any, succeed: (Any?) -> Unit, fail: (Exception) -> Unit) {
        dbWorker.execute {
            val result = runCatching(action)
            activity.runOnUiThread {
                if (!closed) result.onSuccess(succeed).onFailure { fail(it as? Exception ?: Exception(it)) }
            }
        }
    }

    private fun lanOptions(args: JSONArray, index: Int): JSONObject {
        if (index >= args.length()) return JSONObject()
        require(args.get(index) is JSONObject) { "联机参数必须是对象" }
        return args.getJSONObject(index)
    }

    private fun fileAction(action: () -> Any, succeed: (Any?) -> Unit, fail: (Exception) -> Unit) {
        fileWorker.execute {
            val result = runCatching(action)
            activity.runOnUiThread {
                if (!closed) result.onSuccess(succeed).onFailure { fail(it as? Exception ?: Exception(it)) }
            }
        }
    }

    private fun sqlAndParams(args: JSONArray): Pair<String, JSONArray> {
        val sql = args.getString(0)
        require(sql.length in 1..100_000 && !Regex("(?i)\\b(ATTACH|DETACH|LOAD_EXTENSION|VACUUM\\s+INTO)\\b").containsMatchIn(sql)) { "SQL 操作不允许" }
        val values = args.optJSONArray(1) ?: JSONArray()
        require(values.length() <= 1000) { "SQL 参数过多" }
        return sql to values
    }

    private fun sqlParam(value: Any): Any? = when (value) {
        JSONObject.NULL -> null
        is String, is Number -> value
        is JSONObject -> {
            require(value.length() == 1 && value.has("__roomillionSqlBlobBase64")) { "SQL 参数类型无效" }
            val encoded = value.getString("__roomillionSqlBlobBase64")
            require(encoded.length <= ((512 * 1024 + 2) / 3) * 4) { "数据库二进制参数超过 512 KiB" }
            val bytes = java.util.Base64.getDecoder().decode(encoded)
            require(bytes.size <= 512 * 1024) { "数据库二进制参数超过 512 KiB" }
            bytes
        }
        else -> throw IllegalArgumentException("SQL 参数只支持文本、数字、null 和不超过 512 KiB 的二进制值")
    }

    private fun query(args: JSONArray): JSONArray {
        val (sql, params) = sqlAndParams(args)
        val rows = JSONArray()
        database.rawQueryWithFactory({ _, driver, editTable, query ->
            for (index in 0 until params.length()) {
                when (val value = sqlParam(params.get(index))) {
                    null -> query.bindNull(index + 1)
                    is String -> query.bindString(index + 1, value)
                    is Int, is Long -> query.bindLong(index + 1, (value as Number).toLong())
                    is Number -> query.bindDouble(index + 1, value.toDouble())
                    is ByteArray -> query.bindBlob(index + 1, value)
                    else -> throw IllegalArgumentException("SQL 参数类型无效")
                }
            }
            android.database.sqlite.SQLiteCursor(driver, editTable, query)
        }, sql, emptyArray(), "").use { cursor ->
            while (cursor.moveToNext()) {
                require(rows.length() < 100_000) { "查询结果过多" }
                val item = JSONObject()
                for (index in 0 until cursor.columnCount) {
                    val value: Any = when (cursor.getType(index)) {
                        android.database.Cursor.FIELD_TYPE_NULL -> JSONObject.NULL
                        android.database.Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(index)
                        android.database.Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(index)
                        android.database.Cursor.FIELD_TYPE_BLOB -> {
                            val bytes = cursor.getBlob(index)
                            require(bytes.size <= 512 * 1024) { "数据库二进制结果超过 512 KiB，请使用房间文件或附件接口" }
                            JSONObject().put("__roomillionSqlBlobBase64", java.util.Base64.getEncoder().encodeToString(bytes))
                        }
                        else -> cursor.getString(index)
                    }
                    item.put(cursor.getColumnName(index), value)
                }
                rows.put(item)
            }
        }
        return rows
    }

    private fun run(args: JSONArray): JSONObject {
        val (sql, _) = sqlAndParams(args)
        val values = args.optJSONArray(1) ?: JSONArray()
        val binds = Array<Any?>(values.length()) { index -> sqlParam(values.get(index)) }
        database.execSQL(sql, binds)
        database.rawQuery("SELECT changes(), last_insert_rowid()", null).use { cursor ->
            cursor.moveToFirst()
            return JSONObject().put("changes", cursor.getInt(0)).put("lastInsertId", cursor.getLong(1))
        }
    }

    private fun storageGet(key: String): Any {
        require(key.length in 1..300) { "存储键无效" }
        database.execSQL("CREATE TABLE IF NOT EXISTS __room_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        database.rawQuery("SELECT value FROM __room_kv WHERE key=?", arrayOf(key)).use { cursor ->
            return if (cursor.moveToFirst()) org.json.JSONTokener(cursor.getString(0)).nextValue() else JSONObject.NULL
        }
    }

    private fun storageSet(key: String, value: Any): Any {
        require(key.length in 1..300) { "存储键无效" }
        database.execSQL("CREATE TABLE IF NOT EXISTS __room_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        val serialized = JSONArray().put(value).toString().drop(1).dropLast(1)
        database.execSQL("INSERT OR REPLACE INTO __room_kv (key,value) VALUES (?,?)", arrayOf(key, serialized))
        return true
    }

    fun notifyModelsChanged() {
        if (!closed) webView.evaluateJavascript("window.dispatchEvent(new Event('roomillion:models-changed'))", null)
    }

    fun multiplayerStatus(): JSONObject = lan?.status() ?: JSONObject().put("supported", true).put("canHost", true)
        .put("transport", "lan").put("role", JSONObject.NULL).put("connected", false).put("peerId", JSONObject.NULL)
    fun stopMultiplayer() { lan?.close(); lan = null }
    fun matches(current: InstalledRoom, currentGrants: RoomGrants): Boolean = !closed && room.id == current.id && room.version == current.version && room.manifest.toString() == current.manifest.toString() && grants == currentGrants

    fun invokeAction(taskId: String, actionId: String, input: JSONObject) {
        val request = JSONObject().put("taskId", taskId).put("actionId", actionId).put("input", input)
        activity.runOnUiThread { if (!closed) webView.evaluateJavascript("window.__roomillionActionInvoke(JSON.parse(${JSONObject.quote(request.toString())}));", null) else actionHost?.invalidate(this) }
    }
    fun cancelAction(taskId: String) { activity.runOnUiThread { if (!closed) webView.evaluateJavascript("window.__roomillionActionCancel(${JSONObject.quote(taskId)});", null) } }
    fun assistantArtifact(id: String): java.util.concurrent.CompletableFuture<Pair<JSONObject, File>> {
        val future = java.util.concurrent.CompletableFuture<Pair<JSONObject, File>>()
        fileWorker.execute { try { check(!closed); require(permitted("database")) { "房间缺少私有数据权限" }; future.complete(blobStore.getFile(id)) } catch (e: Exception) { future.completeExceptionally(e) } }
        return future
    }
    fun copyAssistantFile(file: File, item: JSONObject, checkAccess: () -> Unit): java.util.concurrent.CompletableFuture<JSONObject> {
        val future = java.util.concurrent.CompletableFuture<JSONObject>()
        fileWorker.execute {
            var token: String? = null
            try {
                check(!closed); checkAccess(); require(permitted("database")) { "房间缺少私有数据权限" }
                val opened = blobStore.begin(JSONObject().put("name", item.getString("name")).put("mimeType", item.optString("mimeType", "application/octet-stream")).put("kind", "artifact")); token = opened.getString("token")
                file.inputStream().use { input -> val bytes = ByteArray(RoomBlobStore.CHUNK_BYTES); while (true) { check(!closed); checkAccess(); val count = input.read(bytes); if (count < 0) break; blobStore.write(token!!, bytes.copyOf(count)) } }
                future.complete(blobStore.finish(token)); token = null
            } catch (e: Exception) { token?.let { blobStore.abort(it) }; future.completeExceptionally(e) }
        }
        return future
    }

    fun close() {
        if (closed) return
        closed = true
        actionHost?.invalidate(this)
        stopMultiplayer()
        lanWorker.shutdownNow()
        activeAiRequests.forEach { it.cancel() }
        activeAiRequests.clear()
        webView.stopLoading()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        dbWorker.execute { openedDatabase?.close(); openedDatabase = null }
        dbWorker.shutdown()
        fileWorker.execute { binaryFiles.clear(); aiMediaFiles.clear(); aiMediaTokens.clear(); blobStore.close() }
        fileWorker.shutdown()
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }
}
