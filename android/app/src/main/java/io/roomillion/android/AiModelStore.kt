package io.roomillion.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.CancellationException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class TextModel(val id: String, val label: String, val endpoint: String, val model: String, val apiKey: String,
                     val supportsImages: Boolean, val supportsAudio: Boolean,
                     val providerId: String = AiProviderCatalog.CUSTOM_ID)

/** Disconnects an in-flight model call when its room is closed. */
class AiRequestCancellation {
    @Volatile var isCancelled = false
        private set
    private var connection: HttpURLConnection? = null

    @Synchronized fun attach(value: HttpURLConnection) {
        if (isCancelled) {
            runCatching { value.disconnect() }
            throw CancellationException("AI 请求已取消")
        }
        connection = value
    }

    fun cancel() {
        val active = synchronized(this) {
            isCancelled = true
            connection.also { connection = null }
        }
        runCatching { active?.disconnect() }
    }

    @Synchronized fun release(value: HttpURLConnection) {
        if (connection === value) connection = null
    }

    fun check() {
        if (isCancelled) throw CancellationException("AI 请求已取消")
    }
}

/** Trusted host-only AI configuration. The room bridge never receives the credential. */
class AiModelStore(context: Context, private val connect: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    private val preferences = context.getSharedPreferences("ai-model", Context.MODE_PRIVATE)
    private val providers by lazy { AiProviderCatalog(context) }

    companion object {
        private const val KEY_ALIAS = "roomillion-android-ai-key-v1"
        const val PROFILE_ID = "android-default"

        fun validateEndpoint(value: String): String {
            val uri = URI(value.trim())
            require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null && uri.query == null) {
                "模型接口必须是 HTTPS 完整地址，且不能含账号、查询参数或片段"
            }
            require(uri.port == -1 || uri.port in 1..65535) { "模型接口端口无效" }
            return uri.toString()
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }

    @Synchronized
    private fun records(): MutableList<JSONObject> {
        val stored = preferences.getString("profiles", null)
        if (stored != null) {
            val array = JSONArray(stored)
            return (0 until array.length()).map { array.getJSONObject(it) }.toMutableList()
        }
        val endpoint = preferences.getString("endpoint", null) ?: return mutableListOf()
        val model = preferences.getString("model", null) ?: return mutableListOf()
        return mutableListOf(JSONObject().put("id", PROFILE_ID).put("label", model)
            .put("endpoint", endpoint).put("model", model)
            .put("iv", preferences.getString("iv", ""))
            .put("secret", preferences.getString("secret", ""))
            .put("hasCredential", preferences.getBoolean("hasCredential", false)))
    }

    @Synchronized
    private fun writeRecords(items: List<JSONObject>, defaultId: String?) {
        val array = JSONArray()
        items.forEach(array::put)
        check(preferences.edit().putString("profiles", array.toString())
            .putString("defaultId", defaultId).remove("endpoint").remove("model")
            .remove("iv").remove("secret").remove("hasCredential").commit()) { "模型配置保存失败" }
    }

    @Synchronized
    fun saveProfile(id: String?, label: String, endpoint: String, model: String, apiKey: String,
                    supportsImages: Boolean? = null, supportsAudio: Boolean? = null, providerId: String? = null): String {
        val validEndpoint = validateEndpoint(endpoint)
        require(model.isNotBlank() && model.length <= 200) { "模型名称无效" }
        require(label.isNotBlank() && label.length <= 80) { "显示名称无效" }
        require(apiKey.length <= 20_000) { "模型密钥过长" }
        val items = records()
        if (id != null) require(items.any { it.getString("id") == id } || id == PROFILE_ID && items.isEmpty()) { "要编辑的模型不存在" }
        val profileId = id ?: "android-${UUID.randomUUID()}"
        val previous = items.firstOrNull { it.getString("id") == profileId }
        val selectedProvider = providerId ?: previous?.optString("providerId", AiProviderCatalog.CUSTOM_ID) ?: AiProviderCatalog.CUSTOM_ID
        require(selectedProvider == AiProviderCatalog.CUSTOM_ID || providers.acceptsEndpoint(selectedProvider, validEndpoint)) {
            "所选提供商与接口地址不匹配，请改用自定义接口"
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(apiKey.toByteArray(StandardCharsets.UTF_8))
        val record = JSONObject().put("id", profileId).put("label", label.trim())
            .put("endpoint", validEndpoint).put("model", model.trim())
            .put("providerId", selectedProvider)
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("secret", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .put("hasCredential", apiKey.isNotEmpty())
            .put("supportsImages", supportsImages ?: previous?.optBoolean("supportsImages") ?: false)
            .put("supportsAudio", supportsAudio ?: previous?.optBoolean("supportsAudio") ?: false)
        val index = items.indexOfFirst { it.getString("id") == profileId }
        if (index >= 0) items[index] = record else items.add(record)
        writeRecords(items, preferences.getString("defaultId", null)?.takeIf { chosen -> items.any { it.getString("id") == chosen } }
            ?: items.first().getString("id"))
        return profileId
    }

    fun save(endpoint: String, model: String, apiKey: String) {
        saveProfile(PROFILE_ID, model, endpoint, model, apiKey)
    }

    @Synchronized
    fun defaultProfileId(): String? {
        val items = records()
        val chosen = preferences.getString("defaultId", null)
        return chosen?.takeIf { id -> items.any { it.getString("id") == id } } ?: items.firstOrNull()?.getString("id")
    }

    @Synchronized
    fun listPublic(): JSONArray {
        val defaultId = defaultProfileId()
        val result = JSONArray()
        for (profile in records()) result.put(JSONObject().put("id", profile.getString("id"))
            .put("label", profile.getString("label")).put("model", profile.getString("model"))
            .put("providerId", profile.optString("providerId", AiProviderCatalog.CUSTOM_ID))
            .put("providerName", providers.find(profile.optString("providerId"))?.name ?: "自定义接口")
            .put("input", JSONArray().put("text").apply {
                if (profile.optBoolean("supportsImages")) put("image")
                if (profile.optBoolean("supportsAudio")) put("audio")
            })
            .put("supportsImages", profile.optBoolean("supportsImages"))
            .put("supportsAudio", profile.optBoolean("supportsAudio"))
            .put("hasCredential", profile.optBoolean("hasCredential", false))
            .put("ready", true).put("isDefault", profile.getString("id") == defaultId)
            .put("isSelected", profile.getString("id") == defaultId))
        return result
    }

    fun publicModel(): JSONObject? = listPublic().let { models ->
        (0 until models.length()).mapNotNull(models::optJSONObject).firstOrNull { it.optBoolean("isDefault") }
    }

    @Synchronized
    fun read(profileId: String? = null): TextModel? {
        val id = profileId ?: defaultProfileId() ?: return null
        val profile = records().firstOrNull { it.getString("id") == id } ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(profile.getString("iv"), Base64.NO_WRAP)))
        return TextModel(id, profile.getString("label"), profile.getString("endpoint"), profile.getString("model"),
            String(cipher.doFinal(Base64.decode(profile.getString("secret"), Base64.NO_WRAP)), StandardCharsets.UTF_8),
            profile.optBoolean("supportsImages"), profile.optBoolean("supportsAudio"),
            profile.optString("providerId", AiProviderCatalog.CUSTOM_ID))
    }

    @Synchronized
    fun setDefault(profileId: String) {
        val items = records()
        require(items.any { it.getString("id") == profileId }) { "所选模型不存在" }
        writeRecords(items, profileId)
    }

    @Synchronized
    fun remove(profileId: String) {
        val items = records()
        require(items.removeAll { it.getString("id") == profileId }) { "所选模型不存在" }
        val nextDefault = defaultProfileId().takeIf { it != profileId && items.any { item -> item.getString("id") == it } }
            ?: items.firstOrNull()?.getString("id")
        writeRecords(items, nextDefault)
    }

    fun clear() {
        check(preferences.edit().clear().commit()) { "清除模型配置失败" }
    }

    fun testConnection(profileId: String): String {
        val result = generate("请简短回复：连接正常。", JSONObject().put("profileId", profileId)
            .put("maxTokens", 32).put("timeoutMs", 20_000))
        require(result.getString("text").isNotBlank()) { "模型连接成功，但没有返回文本" }
        return result.getString("model")
    }

    fun generate(prompt: String, options: JSONObject = JSONObject(), cancellation: AiRequestCancellation? = null,
                 onChunk: ((String, String) -> Unit)? = null): JSONObject {
        cancellation?.check()
        require(prompt.isNotBlank() && prompt.length <= 2_000_000) { "AI 提示内容无效或过长" }
        val selected = options.optString("profileId").takeIf { it.isNotBlank() } ?: defaultProfileId()
            ?: error("请先在安卓工作台配置文本 AI 模型")
        val configured = read(selected) ?: error("所选安卓模型不存在")
        val images = options.optJSONArray("images") ?: JSONArray()
        val audio = options.optJSONArray("audio") ?: JSONArray()
        require(images.length() == 0 || configured.supportsImages) { "所选模型未启用图片输入能力" }
        require(audio.length() == 0 || configured.supportsAudio) { "所选模型未启用音频输入能力" }
        val maxTokens = options.optInt("maxTokens", 2000)
        require(maxTokens in 1..100_000) { "最大输出 Token 无效" }
        val timeout = options.optInt("timeoutMs", 120_000)
        require(timeout in 1000..600_000) { "AI 超时时间无效" }
        val content: Any = if (images.length() == 0 && audio.length() == 0) prompt else JSONArray().apply {
            put(JSONObject().put("type", "text").put("text", prompt))
            for (index in 0 until images.length()) {
                val item = images.getJSONObject(index)
                val mimeType = item.getString("mimeType")
                require(mimeType in setOf("image/png", "image/jpeg", "image/webp", "image/gif")) { "AI 图片格式无效" }
                put(JSONObject().put("type", "image_url").put("image_url",
                    JSONObject().put("url", "data:$mimeType;base64,${item.getString("data")}")))
            }
            for (index in 0 until audio.length()) {
                val item = audio.getJSONObject(index)
                val format = when (item.getString("mimeType")) {
                    "audio/wav" -> "wav"; "audio/mpeg" -> "mp3"; "audio/ogg" -> "ogg"
                    "audio/flac" -> "flac"; "audio/mp4" -> "m4a"; "audio/webm" -> "webm"
                    else -> throw IllegalArgumentException("AI 音频格式无效")
                }
                put(JSONObject().put("type", "input_audio").put("input_audio",
                    JSONObject().put("data", item.getString("data")).put("format", format)))
            }
        }
        val body = JSONObject().put("model", configured.model)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            .put("max_tokens", maxTokens)
        val streaming = options.optBoolean("stream", false)
        if (streaming) body.put("stream", true)
        if (options.has("temperature")) body.put("temperature", options.getDouble("temperature"))
        val connection = connect(URL(configured.endpoint))
        cancellation?.attach(connection)
        try {
            cancellation?.check()
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = minOf(timeout, 30_000)
            connection.readTimeout = timeout
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (configured.providerId in setOf("opencode", "opencode-go") &&
                providers.acceptsEndpoint(configured.providerId, configured.endpoint)) {
                connection.setRequestProperty("User-Agent", "roomillion-android/${BuildConfig.VERSION_NAME}")
                // Android room calls currently send independent single-prompt requests.
                connection.setRequestProperty("x-opencode-session", UUID.randomUUID().toString())
            }
            if (configured.apiKey.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer ${configured.apiKey}")
            connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            val status = connection.responseCode
            cancellation?.check()
            if (status !in 200..299) {
                error("AI 服务返回 HTTP $status；请检查接口地址、密钥或额度")
            }
            val (text, usage) = connection.inputStream.use { input ->
                if (streaming) readStream(input, onChunk)
                else {
                    val bytes = input.readUpTo(2_000_001)
                    require(bytes.size <= 2_000_000) { "AI 服务响应过大" }
                    val parsed = JSONObject(String(bytes, StandardCharsets.UTF_8))
                    responseText(parsed.getJSONArray("choices").getJSONObject(0).getJSONObject("message").opt("content")) to
                        (parsed.optJSONObject("usage") ?: JSONObject.NULL)
                }
            }
            cancellation?.check()
            require(text.isNotBlank()) { "AI 服务没有返回文本内容" }
            return JSONObject().put("text", text).put("model", configured.model)
                .put("profileId", configured.id).put("usage", usage)
        } catch (error: Exception) {
            if (cancellation?.isCancelled == true) throw CancellationException("AI 请求已取消")
            val message = when {
                error.message?.matches(Regex("AI 服务返回 HTTP [0-9]{3}；请检查接口地址、密钥或额度")) == true -> error.message!!
                error.message == "AI 服务响应过大" -> "AI 服务响应过大"
                error.message == "AI 服务流式返回错误" -> "AI 服务流式返回错误"
                error.message == "AI 服务没有返回文本内容" -> "AI 服务没有返回文本内容"
                error is java.net.SocketTimeoutException -> "模型服务连接或响应超时"
                error is java.net.UnknownHostException -> "模型服务域名无法解析"
                error is java.net.ConnectException -> "无法连接模型服务"
                error is javax.net.ssl.SSLException -> "模型服务 TLS 连接失败"
                else -> "AI 请求失败，请在工作台检查模型接口、密钥与网络"
            }
            throw IllegalStateException(message)
        } finally {
            cancellation?.release(connection)
            runCatching { connection.disconnect() }
        }
    }

    private fun readStream(input: java.io.InputStream, onChunk: ((String, String) -> Unit)?): Pair<String, Any> {
        val source = BufferedInputStream(input)
        val line = ByteArrayOutputStream()
        val full = StringBuilder()
        var usage: Any = JSONObject.NULL
        var total = 0
        var done = false
        fun parseLine() {
            val value = line.toString("UTF-8").trimEnd('\r')
            line.reset()
            if (value.isBlank()) return
            if (!value.startsWith("data:")) {
                if (value.startsWith('{')) {
                    val parsed = JSONObject(value)
                    val text = responseText(parsed.getJSONArray("choices").getJSONObject(0).getJSONObject("message").opt("content"))
                    full.append(text)
                    if (text.isNotEmpty()) onChunk?.invoke(text, full.toString())
                    usage = parsed.optJSONObject("usage") ?: JSONObject.NULL
                    done = true
                }
                return
            }
            val data = value.removePrefix("data:").trim()
            if (data == "[DONE]") { done = true; return }
            val event = JSONObject(data)
            if (event.has("error")) error("AI 服务流式返回错误")
            usage = event.optJSONObject("usage") ?: usage
            val choices = event.optJSONArray("choices")
            if (choices != null && choices.length() > 0) {
                val objectDelta = choices.getJSONObject(0).optJSONObject("delta")
                val delta = if (objectDelta == null || objectDelta.isNull("content")) "" else responseText(objectDelta.opt("content"))
                if (delta.isNotEmpty()) {
                    full.append(delta)
                    require(full.length <= 2_000_000) { "AI 服务响应过大" }
                    onChunk?.invoke(delta, full.toString())
                }
            }
        }
        while (!done) {
            val byte = source.read()
            if (byte < 0) { if (line.size() > 0) parseLine(); break }
            total++
            require(total <= 2_000_000 && line.size() <= 65_536) { "AI 服务响应过大" }
            if (byte == 10) parseLine() else line.write(byte)
        }
        return full.toString() to usage
    }

    /** Some compatible chat APIs return text as content parts instead of one string. */
    private fun responseText(content: Any?): String = when (content) {
        is String -> content
        is JSONArray -> buildString {
            for (index in 0 until content.length()) {
                when (val part = content.opt(index)) {
                    is String -> append(part)
                    is JSONObject -> if (part.optString("type") in setOf("text", "output_text", "")) {
                        val text = part.opt("text")
                        if (text is String) append(text)
                    }
                }
            }
        }
        else -> ""
    }
}
