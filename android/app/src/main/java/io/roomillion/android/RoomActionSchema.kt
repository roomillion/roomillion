package io.roomillion.android

import org.json.JSONArray
import org.json.JSONObject

/** The desktop actions contract; schemas are data, never executable code or references. */
object RoomActionSchema {
    private val types = setOf("object", "array", "string", "number", "integer", "boolean", "null")
    private val keys = setOf("type", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems")
    fun definitions(manifest: JSONObject): JSONArray {
        if (!manifest.has("actions")) return JSONArray()
        val actions = manifest.getJSONArray("actions"); require(actions.length() <= 128) { "房间操作过多" }
        val ids = mutableSetOf<String>()
        for (i in 0 until actions.length()) {
            val action = actions.getJSONObject(i); val id = action.getString("id")
            require(id.matches(Regex("[a-z][a-z0-9.-]{0,63}")) && ids.add(id)) { "房间操作 ID 无效或重复" }
            require(action.keys().asSequence().all { it in setOf("id", "name", "description", "effect", "inputSchema", "outputSchema") }) { "房间操作定义字段无效" }
            require(action.getString("name").isNotBlank() && action.getString("name").length <= 100 && action.getString("description").isNotBlank() && action.getString("description").length <= 2000) { "操作名称或说明无效" }
            require(action.getString("effect") in setOf("read", "write", "destructive", "external")) { "操作 effect 无效" }
            val input = action.getJSONObject("inputSchema"); require(input.getString("type") == "object") { "操作参数顶层必须是 object" }; schema(input)
            if (action.has("outputSchema")) schema(action.getJSONObject("outputSchema"))
        }
        return JSONArray(actions.toString())
    }
    private fun schema(s: JSONObject, depth: Int = 0) {
        require(depth <= 12 && s.optString("type") in types && s.keys().asSequence().all { it in keys }) { "不支持的房间参数定义" }
        if (s.has("description")) require(s.get("description") is String && s.getString("description").length <= 2000)
        if (s.has("enum")) require(s.getJSONArray("enum").length() > 0)
        for (key in listOf("minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems")) if (s.has(key)) {
            val n = s.get(key); require(n is Number && n.toDouble().isFinite() && (key in setOf("minimum", "maximum") || n.toDouble() >= 0 && n.toDouble() % 1.0 == 0.0))
        }
        if (s.getString("type") == "object") {
            val properties = if (s.has("properties")) s.getJSONObject("properties") else JSONObject()
            for (key in properties.keys()) { require(key.matches(Regex("[a-zA-Z][a-zA-Z0-9_-]{0,63}")) && key !in setOf("constructor", "prototype")); schema(properties.getJSONObject(key), depth + 1) }
            if (s.has("required")) { val required = s.getJSONArray("required"); for (i in 0 until required.length()) require(required.get(i) is String && properties.has(required.getString(i))) }
            if (s.has("additionalProperties")) require(s.get("additionalProperties") is Boolean)
        }
        if (s.getString("type") == "array") schema(s.getJSONObject("items"), depth + 1)
    }
    fun validate(s: JSONObject, value: Any?, label: String = "input", depth: Int = 0) {
        require(depth <= 24) { "$label 嵌套过深" }
        val type = s.getString("type")
        val valid = when (type) {
            "object" -> value is JSONObject; "array" -> value is JSONArray; "null" -> value == null || value === JSONObject.NULL
            "string" -> value is String; "boolean" -> value is Boolean
            "integer" -> value is Number && value.toDouble().isFinite() && value.toDouble() % 1.0 == 0.0 && kotlin.math.abs(value.toDouble()) <= 9007199254740991.0
            else -> value is Number && value.toDouble().isFinite()
        }
        require(valid) { "$label 应为 $type" }
        s.optJSONArray("enum")?.let { options -> require((0 until options.length()).any { options.get(it).toString() == value.toString() }) { "$label 不在允许的选项中" } }
        if (value is Number) { if (s.has("minimum")) require(value.toDouble() >= s.getDouble("minimum")); if (s.has("maximum")) require(value.toDouble() <= s.getDouble("maximum")) }
        if (value is String) { if (s.has("minLength")) require(value.length >= s.getInt("minLength")); if (s.has("maxLength")) require(value.length <= s.getInt("maxLength")) }
        if (value is JSONArray) {
            if (s.has("minItems")) require(value.length() >= s.getInt("minItems")); if (s.has("maxItems")) require(value.length() <= s.getInt("maxItems"))
            for (i in 0 until value.length()) validate(s.getJSONObject("items"), value.get(i), "$label[$i]", depth + 1)
        }
        if (value is JSONObject) {
            s.optJSONArray("required")?.let { for (i in 0 until it.length()) require(value.has(it.getString(i))) { "$label 缺少 ${it.getString(i)}" } }
            val properties = s.optJSONObject("properties") ?: JSONObject()
            for (key in value.keys()) if (properties.has(key)) validate(properties.getJSONObject(key), value.get(key), "$label.$key", depth + 1) else require(s.optBoolean("additionalProperties", true)) { "$label 不支持 $key" }
        }
    }
}
