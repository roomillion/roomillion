package io.roomillion.android

import android.content.Intent
import android.widget.Button
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.espresso.matcher.ViewMatchers.withHint
import androidx.test.espresso.matcher.ViewMatchers.withText
import org.hamcrest.Matchers.allOf
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

@RunWith(AndroidJUnit4::class)
class AiProviderCatalogTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    private fun startSettings(): MainActivity {
        val activity = instrumentation.startActivitySync(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        onView(withText("设置 AI 模型")).perform(click())
        return activity
    }

    private fun selectProvider(currentName: String, id: String) {
        val provider = AiProviderCatalog(context).find(id)!!
        onView(withText("提供商：$currentName")).perform(scrollTo(), click())
        onView(withHint("搜索提供商")).perform(replaceText(id), closeSoftKeyboard())
        onView(withText("${provider.name} · ${provider.category}")).perform(click())
    }

    @Test fun addingPresetPreservesExistingModelAndRestoresProviderOnEdit() {
        val store = AiModelStore(context)
        store.clear()
        val original = store.saveProfile(null, "已有自定义模型", "https://models.example.test/v1/chat/completions", "original", "old-secret")
        val catalog = AiProviderCatalog(context)
        val provider = catalog.find("opencode-go")!!
        val model = provider.models.first { it.id == "glm-5.3-flash" }
        val activity = startSettings()
        try {
            selectProvider(catalog.providers.first().name, provider.id)
            onView(withText("从目录选择模型")).perform(scrollTo(), click())
            onView(withHint("搜索模型")).perform(replaceText(model.id), closeSoftKeyboard())
            onView(withText("${model.name} · ${model.id}")).perform(click())
            onView(withHint("API 密钥")).perform(scrollTo(), replaceText("new-secret"), closeSoftKeyboard())
            onView(allOf(withText("添加模型"), isAssignableFrom(Button::class.java))).perform(scrollTo(), click())
            val profiles = store.listPublic()
            assertEquals(2, profiles.length())
            assertEquals("old-secret", store.read(original)!!.apiKey)
            assertEquals(original, store.defaultProfileId())
            val added = (0 until profiles.length()).map { profiles.getJSONObject(it) }.first { it.getString("id") != original }
            assertEquals(provider.id, added.getString("providerId"))
            assertEquals(provider.name, added.getString("providerName"))
            assertFalse(added.toString().contains("new-secret"))
            val saved = store.read(added.getString("id"))!!
            assertEquals(model.endpoint, saved.endpoint)
            assertEquals(model.id, saved.model)
            assertEquals("new-secret", saved.apiKey)
            assertEquals(model.supportsImages, saved.supportsImages)
            onView(withText("编辑 ${saved.label}")).perform(scrollTo(), click())
            onView(withText("提供商：${provider.name}")).perform(scrollTo()).check(matches(withText("提供商：${provider.name}")))
            onView(withHint("模型名称（也可手动输入）")).check(matches(withText(model.id)))
            assertTrue(context.assets.open("compliance/pi-ai-LICENSE.txt").use { it.readBytes().size } > 100)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            store.clear()
        }
    }

    @Test fun switchingProviderDoesNotCarryPreviousCredential() {
        val store = AiModelStore(context)
        store.clear()
        val first = AiProviderCatalog(context).find("xiaomi-token-plan-cn")!!
        val id = store.saveProfile(null, "原配置", first.endpoint, first.defaultModel, "private-old-key", providerId = first.id)
        val activity = startSettings()
        try {
            onView(withText("编辑 原配置 · 默认")).perform(scrollTo(), click())
            selectProvider(first.name, "deepseek")
            onView(withText("保存修改")).perform(scrollTo(), click())
            val saved = store.read(id)!!
            assertEquals("deepseek", saved.providerId)
            assertEquals("", saved.apiKey)
            assertEquals(1, store.listPublic().length())
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            store.clear()
        }
    }

    @Test fun customConfigurationKeepsItsCredentialUntilTheEndpointChanges() {
        val store = AiModelStore(context)
        store.clear()
        val id = store.saveProfile(null, "自定义", "https://models.example.test/v1/chat/completions", "original", "private-old-key")
        val activity = startSettings()
        try {
            onView(withText("编辑 自定义 · 默认")).perform(scrollTo(), click())
            onView(withText("保存修改")).perform(scrollTo(), click())
            assertEquals("private-old-key", store.read(id)!!.apiKey)
            onView(withText("编辑 自定义 · 默认")).perform(scrollTo(), click())
            onView(withHint("HTTPS 聊天补全接口完整地址")).perform(scrollTo(), replaceText("https://other.example.test/chat/completions"), closeSoftKeyboard())
            onView(withText("保存修改")).perform(scrollTo(), click())
            assertEquals("", store.read(id)!!.apiKey)
            assertEquals(AiProviderCatalog.CUSTOM_ID, store.read(id)!!.providerId)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            store.clear()
        }
    }

    @Test fun presetRequestUsesSelectedRouteAndOpenCodeHeadersWithoutExposingKey() {
        val provider = AiProviderCatalog(context).find("opencode-go")!!
        val model = provider.models.first { it.id == "glm-5.3-flash" }
        val fake = object : HttpURLConnection(URL(model.endpoint)) {
            override fun connect() {}
            override fun disconnect() {}
            override fun usingProxy() = false
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream("""{"choices":[{"message":{"content":"正常"}}]}""".toByteArray())
        }
        val store = AiModelStore(context) { url -> assertEquals(model.endpoint, url.toString()); fake }
        store.clear()
        try {
            val id = store.saveProfile(null, "预设", model.endpoint, model.id, "chosen-key", providerId = provider.id)
            assertEquals("正常", store.generate("问候", JSONObject().put("profileId", id)).getString("text"))
            assertEquals("Bearer chosen-key", fake.getRequestProperty("Authorization"))
            assertTrue(fake.getRequestProperty("x-opencode-session").matches(Regex("[0-9a-f-]{36}")))
            assertTrue(fake.getRequestProperty("User-Agent").startsWith("roomillion-android/"))
            assertFalse(store.listPublic().toString().contains("chosen-key"))
            assertTrue(runCatching { store.saveProfile(null, "错误地址", "https://other.example.test/chat/completions", model.id,
                "chosen-key", providerId = provider.id) }.isFailure)
            assertEquals(1, store.listPublic().length())
        } finally { store.clear() }
    }
}
