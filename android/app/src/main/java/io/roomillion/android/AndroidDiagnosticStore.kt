package io.roomillion.android

import android.content.Context
import android.os.Build
import android.webkit.WebView
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Stores only allowlisted event labels; never accepts request bodies, errors, names or paths. */
class AndroidDiagnosticStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("android-diagnostics", Context.MODE_PRIVATE)

    companion object {
        private const val MAX_EVENTS = 100
        private val TYPES = setOf("room.inspect", "room.install", "room.open", "room.export", "ai.generate")
        private val OUTCOMES = setOf("success", "failure", "cancelled")
    }

    @Synchronized
    fun record(type: String, outcome: String) {
        require(type in TYPES && outcome in OUTCOMES) { "诊断事件类型无效" }
        val stored = runCatching { JSONArray(preferences.getString("events", "[]")) }.getOrDefault(JSONArray())
        val next = JSONArray()
        for (index in maxOf(0, stored.length() - MAX_EVENTS + 1) until stored.length()) next.put(stored.get(index))
        next.put(JSONObject().put("time", Instant.now().toString()).put("type", type).put("outcome", outcome))
        check(preferences.edit().putString("events", next.toString()).commit()) { "诊断状态保存失败" }
    }

    @Synchronized
    fun report(roomCount: Int, modelCount: Int): JSONObject {
        require(roomCount >= 0 && modelCount >= 0)
        val events = runCatching { JSONArray(preferences.getString("events", "[]")) }.getOrDefault(JSONArray())
        val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
        val webViewVersion = WebView.getCurrentWebViewPackage()?.versionName.orEmpty()
        return JSONObject().put("formatVersion", "0.1")
            .put("createdAt", Instant.now().toString())
            .put("privacyNotice", "仅包含环境版本、房间与模型数量、最近操作类型及结果；不包含房间名称或 ID、密钥、AI 对话、文件内容、路径或网址。")
            .put("environment", JSONObject()
                .put("appVersion", version)
                .put("androidApi", Build.VERSION.SDK_INT)
                .put("abi", Build.SUPPORTED_ABIS.firstOrNull().orEmpty())
                .put("webViewVersion", webViewVersion)
                .put("webMessageListener", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
                .put("documentStartScript", WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)))
            .put("roomCount", roomCount)
            .put("textModelCount", modelCount)
            .put("events", events)
    }

    fun clear() {
        check(preferences.edit().clear().commit()) { "诊断状态清除失败" }
    }
}
