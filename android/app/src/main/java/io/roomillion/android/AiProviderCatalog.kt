package io.roomillion.android

import android.content.Context
import org.json.JSONObject

data class AiCatalogModel(val id: String, val name: String, val endpoint: String, val supportsImages: Boolean,
                          val supportsAudio: Boolean, val reasoning: Boolean = false)
data class AiCatalogProvider(val id: String, val name: String, val description: String, val category: String,
                             val defaultModel: String, val endpoint: String, val models: List<AiCatalogModel>)

/** Offline settings metadata generated from the desktop's pinned provider/model catalog. */
class AiProviderCatalog(context: Context) {
    companion object { const val CUSTOM_ID = "android-custom" }

    val providers: List<AiCatalogProvider> = context.assets.open("ai-providers.json").bufferedReader().use { reader ->
        val root = JSONObject(reader.readText())
        require(root.getInt("formatVersion") == 1) { "AI 提供商目录版本不受支持" }
        val items = root.getJSONArray("providers")
        (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            val entries = item.getJSONArray("models")
            val models = (0 until entries.length()).map { modelIndex ->
                val model = entries.getJSONObject(modelIndex)
                val input = model.getJSONArray("input")
                val types = (0 until input.length()).map(input::getString).toSet()
                AiCatalogModel(model.getString("id"), model.getString("name"),
                    AiModelStore.validateEndpoint(model.getString("endpoint")), "image" in types, "audio" in types, model.optBoolean("reasoning"))
            }
            AiCatalogProvider(item.getString("id"), item.getString("name"), item.getString("description"),
                item.getString("category"), item.getString("defaultModel"),
                AiModelStore.validateEndpoint(item.getString("endpoint")), models)
        }
    }

    fun find(id: String): AiCatalogProvider? = providers.firstOrNull { it.id == id }

    fun acceptsEndpoint(id: String, endpoint: String): Boolean =
        find(id)?.models?.any { it.endpoint == endpoint } == true
}
