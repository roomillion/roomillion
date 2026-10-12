package io.roomillion.android

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** Host-only chat/tool transport for Pi. Room SDK callers cannot invoke this gateway. */
class RoomAgentGateway(private val models: AiModelStore,
    private val connect: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val deadlineMillis: Long = 180_000, private val supportsThinking: (TextModel) -> Boolean = { false }) {
    fun complete(args: JSONObject, cancellation: AiRequestCancellation): JSONObject {
        cancellation.check()
        val profile = args.optString("profileId").ifBlank { models.defaultProfileId() ?: error("请配置编程模型") }
        val configured = models.read(profile) ?: error("编程模型配置不存在")
        val messages = args.getJSONArray("messages")
        require(messages.length() in 1..1000 && messages.toString().length <= 4_000_000) { "开发上下文过长，请保存后缩短历史" }
        for (i in 0 until messages.length()) require(messages.getJSONObject(i).optString("role") in setOf("system","user","assistant","tool")) { "消息角色无效" }
        val body = JSONObject().put("model", configured.model).put("messages", messages)
            .put("tools", args.getJSONArray("tools")).put("tool_choice", "auto").put("max_tokens", 16384)
        val thinking = args.optString("thinking", "off"); require(thinking in setOf("off", "low", "medium", "high")) { "思考强度无效" }
        if (thinking != "off" && supportsThinking(configured)) body.put("reasoning_effort", thinking)
        val connection = connect(URL(configured.endpoint))
        cancellation.attach(connection)
        val expired=java.util.concurrent.atomic.AtomicBoolean(false)
        val deadline=java.util.Timer(true).apply {schedule(object:java.util.TimerTask(){override fun run(){expired.set(true);connection.disconnect()}},deadlineMillis)}
        try {
            cancellation.check()
            check(!expired.get()) {"编程模型请求超时，请重试或切换模型"}
            connection.requestMethod = "POST"; connection.instanceFollowRedirects = false
            connection.connectTimeout = 30_000; connection.readTimeout = 180_000; connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("User-Agent", "roomillion-android/${BuildConfig.VERSION_NAME}")
            if (configured.providerId in setOf("opencode", "opencode-go")) {
                val session = args.optString("sessionId")
                require(session.matches(Regex("[a-f0-9-]{32,36}"))) { "开发会话无效" }
                connection.setRequestProperty("x-opencode-session", session)
            }
            if (configured.apiKey.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer ${configured.apiKey}")
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            if (code !in 200..299) error("编程模型返回 HTTP $code；请检查模型配置、额度和工具调用支持")
            val bytes = connection.inputStream.use { it.readUpTo(4_000_001) }
            require(bytes.size <= 4_000_000) { "编程模型响应过大" }
            cancellation.check()
            check(!expired.get()) {"编程模型请求超时，请重试或切换模型"}
            return normalize(JSONObject(String(bytes, Charsets.UTF_8)))
        } catch (error: Exception) {
            cancellation.check()
            if(expired.get())throw IllegalStateException("编程模型请求超时，请重试或切换模型")
            // Never expose provider bodies, URLs or exception messages that may echo a credential.
            if (error.message?.startsWith("编程模型返回 HTTP ") == true ||
                error.message in setOf("编程模型响应过大", "模型工具参数未完成", "模型工具调用无效")) throw error
            throw IllegalStateException("编程模型请求失败或响应无效，请重试或切换模型")
        } finally { deadline.cancel();cancellation.release(connection); connection.disconnect() }
    }

    companion object {
        fun normalize(response: JSONObject): JSONObject {
            val choice = response.getJSONArray("choices").getJSONObject(0); val message = choice.getJSONObject("message")
            val content = message.opt("content")
            val text = if (content is JSONArray) (0 until content.length()).mapNotNull { index ->
                content.optJSONObject(index)?.takeIf { it.optString("type") == "text" }?.optString("text")
            }.joinToString("") else if (content is String) content else ""
            val calls = JSONArray(); val input = message.optJSONArray("tool_calls") ?: JSONArray()
            for (i in 0 until input.length()) {
                val call = input.getJSONObject(i); val function = call.getJSONObject("function"); val arguments = function.getString("arguments")
                require(function.getString("name").matches(Regex("[a-z_]{1,64}"))) { "模型工具调用无效" }
                try { JSONObject(arguments) } catch (_: Exception) { error("模型工具参数未完成") }
                // Some providers reuse response-local IDs on later turns. Host-generated
                // transcript IDs prevent an old journal entry being mistaken for a new edit.
                val id = "call_${UUID.randomUUID()}"
                calls.put(JSONObject().put("id", id).put("name", function.getString("name")).put("arguments", arguments))
            }
            return JSONObject().put("text", text).put("toolCalls", calls).put("usage", response.optJSONObject("usage") ?: JSONObject())
                .put("truncated", choice.optString("finish_reason") == "length")
        }
    }
}
