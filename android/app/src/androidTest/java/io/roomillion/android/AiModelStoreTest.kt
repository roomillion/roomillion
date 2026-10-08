package io.roomillion.android

import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class AiModelStoreTest {
    @Test fun cancellationSurvivesTransportDisconnectFailure() {
        val connection = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { throw IllegalStateException("transport already closed") }
            override fun usingProxy() = false
        }
        val cancellation = AiRequestCancellation()
        cancellation.attach(connection)
        cancellation.cancel()
        assertTrue(cancellation.isCancelled)
    }

    @Test fun cancelledRequestNeverConnects() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        var opened = false
        val store = AiModelStore(context) { opened = true; error("取消后不应建立连接") }
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "test-model", "fake-secret")
            val cancellation = AiRequestCancellation().also { it.cancel() }
            assertTrue(runCatching { store.generate("测试", cancellation = cancellation) }
                .exceptionOrNull() is CancellationException)
            assertFalse(opened)
        } finally { store.clear() }
    }

    @Test fun cancellingInFlightRequestDisconnectsAndStopsResponse() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val waitingForResponse = CountDownLatch(1)
        val disconnected = CountDownLatch(1)
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false; disconnected.countDown() }
            override fun usingProxy() = false
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getResponseCode(): Int {
                waitingForResponse.countDown()
                assertTrue(disconnected.await(5, TimeUnit.SECONDS))
                return 200
            }
            override fun getInputStream() = ByteArrayInputStream(
                """{"choices":[{"message":{"content":"不应返回"}}]}""".toByteArray())
        }
        val store = AiModelStore(context) { fake }
        val worker = Executors.newSingleThreadExecutor()
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "test-model", "fake-secret")
            val cancellation = AiRequestCancellation()
            val future = worker.submit<JSONObject> { store.generate("测试", cancellation = cancellation) }
            assertTrue(waitingForResponse.await(5, TimeUnit.SECONDS))
            cancellation.cancel()
            assertTrue(disconnected.await(5, TimeUnit.SECONDS))
            assertTrue(runCatching { future.get(5, TimeUnit.SECONDS) }.exceptionOrNull()?.cause is CancellationException)
        } finally { worker.shutdownNow(); store.clear() }
    }

    @Test fun savedModelHasVisibleConnectionTestControl() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val store = AiModelStore(context)
        store.clear()
        store.saveProfile(null, "测试模型", "https://models.example.test/v1/chat/completions", "test-model", "fake-secret")
        val activity = instrumentation.startActivitySync(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        fun find(root: View, label: String): Button? {
            if (root is Button && root.text.toString().contains(label)) return root
            if (root is ViewGroup) for (index in 0 until root.childCount) {
                find(root.getChildAt(index), label)?.let { return it }
            }
            return null
        }
        try {
            instrumentation.runOnMainSync {
                find(activity.window.decorView, "设置 AI 模型")!!.performClick()
                find(activity.window.decorView, "编辑 测试模型")!!.performClick()
                assertNotNull(find(activity.window.decorView, "测试连接（发送一次简短请求）"))
            }
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            store.clear()
        }
    }

    @Test fun connectionTestUsesChosenProfileAndSmallRequest() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val sent = ByteArrayOutputStream()
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = sent
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream("""{"choices":[{"message":{"content":"连接正常"}}]}""".toByteArray())
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            val id = store.saveProfile(null, "测试模型", "https://models.example.test/v1/chat/completions", "test-model", "fake-secret")
            assertEquals("test-model", store.testConnection(id))
            val request = JSONObject(sent.toString("UTF-8"))
            assertEquals(32, request.getInt("max_tokens"))
            assertTrue(request.getJSONArray("messages").getJSONObject(0).getString("content").contains("连接正常"))
        } finally { store.clear() }
    }

    @Test fun streamingErrorCannotEchoCredentialToRoom() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream(
                ("data: {\"error\":\"Invalid token stream-secret-987\"}\n\n").toByteArray())
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "test-model", "stream-secret-987")
            val error = runCatching { store.generate("测试", JSONObject().put("stream", true)) }.exceptionOrNull()!!
            assertFalse(error.message.orEmpty().contains("stream-secret-987"))
            assertEquals("AI 服务流式返回错误", error.message)
        } finally { store.clear() }
    }

    @Test fun encryptedCredentialAndPublicMetadata() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = AiModelStore(context)
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "test-model", "sentinel-secret-901")
            assertEquals("sentinel-secret-901", store.read()!!.apiKey)
            assertFalse(store.publicModel()!!.toString().contains("sentinel-secret-901"))
            assertFalse(store.publicModel()!!.toString().contains("models.example.test"))
            val persisted = File(context.applicationInfo.dataDir, "shared_prefs/ai-model.xml").readText()
            assertFalse(persisted.contains("sentinel-secret-901"))
            assertTrue(persisted.contains("secret"))
            assertTrue(runCatching { store.save("http://models.example.test/v1/chat/completions", "bad", "key") }.isFailure)
            assertEquals("test-model", store.read()!!.model)
        } finally { store.clear() }
    }

    @Test fun aiRequestUsesHostCredentialAndParsesChatResponse() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val sent = ByteArrayOutputStream()
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = sent
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream(
                """{"choices":[{"message":{"content":"模拟回答"}}],"usage":{"total_tokens":12}}""".toByteArray())
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "test-model", "fake-secret")
            val result = store.generate("请回答", JSONObject().put("maxTokens", 123))
            assertEquals("模拟回答", result.getString("text"))
            assertEquals("test-model", result.getString("model"))
            assertEquals("Bearer fake-secret", fake.getRequestProperty("Authorization"))
            assertFalse(fake.instanceFollowRedirects)
            val request = JSONObject(sent.toString("UTF-8"))
            assertEquals("请回答", request.getJSONArray("messages").getJSONObject(0).getString("content"))
            assertEquals(123, request.getInt("max_tokens"))
        } finally { store.clear() }
    }

    @Test fun multipleProfilesKeepIndependentKeysAndSwitchDefault() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val requests = mutableListOf<Pair<String, String?>>()
        val store = AiModelStore(context) { url ->
            object : HttpURLConnection(url) {
                override fun connect() { connected = true }
                override fun disconnect() { connected = false }
                override fun usingProxy() = false
                override fun getOutputStream() = ByteArrayOutputStream()
                override fun getResponseCode() = 200
                override fun getInputStream(): ByteArrayInputStream {
                    requests.add(url.toString() to getRequestProperty("Authorization"))
                    return ByteArrayInputStream("""{"choices":[{"message":{"content":"通过"}}]}""".toByteArray())
                }
            }
        }
        store.clear()
        try {
            val first = store.saveProfile(null, "模型甲", "https://one.example.test/v1/chat/completions", "one", "secret-one")
            val second = store.saveProfile(null, "模型乙", "https://two.example.test/v1/chat/completions", "two", "secret-two")
            assertEquals(first, store.defaultProfileId())
            assertEquals(2, store.listPublic().length())
            store.setDefault(second)
            assertEquals(second, store.publicModel()!!.getString("id"))
            assertEquals(second, store.generate("问题").getString("profileId"))
            assertEquals(first, store.generate("问题", JSONObject().put("profileId", first)).getString("profileId"))
            assertEquals(listOf("Bearer secret-two", "Bearer secret-one"), requests.map { it.second })
            assertFalse(store.listPublic().toString().contains("secret-one"))
            assertFalse(store.listPublic().toString().contains("secret-two"))
            store.saveProfile(first, "模型甲改名", "https://one.example.test/v1/chat/completions", "one", "secret-one")
            assertEquals(2, store.listPublic().length())
            assertEquals("模型乙", store.read(second)!!.label)
            store.remove(second)
            assertEquals(first, store.defaultProfileId())
            assertEquals(1, store.listPublic().length())
        } finally { store.clear() }
    }

    @Test fun streamingModelKeepsDeltaOrderAndFinalText() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val sent = ByteArrayOutputStream()
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = sent
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream((
                "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n" +
                "data: {\"choices\":[],\"usage\":{\"total_tokens\":2}}\n\n" +
                "data: [DONE]\n").toByteArray(Charsets.UTF_8))
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "stream-model", "test-key")
            val chunks = mutableListOf<Pair<String, String>>()
            val result = store.generate("问候", JSONObject().put("stream", true)) { delta, full -> chunks.add(delta to full) }
            assertEquals(listOf("你" to "你", "好" to "你好"), chunks)
            assertEquals("你好", result.getString("text"))
            assertEquals(2, result.getJSONObject("usage").getInt("total_tokens"))
            assertTrue(JSONObject(sent.toString("UTF-8")).getBoolean("stream"))
        } finally { store.clear() }
    }

    @Test fun compatibleProviderTextPartsAreJoinedWithoutLeakingNonTextParts() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream(
                """{"choices":[{"message":{"content":[{"type":"text","text":"你"},{"type":"image_url","text":"忽略"},{"type":"output_text","text":"好"}]}}]}""".toByteArray())
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "parts-model", "fake-key")
            assertEquals("你好", store.generate("问候").getString("text"))
        } finally { store.clear() }
    }

    @Test fun streamingTextPartsAndEmptyDeltasProduceOneTextAnswer() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream((
                "data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"分\"},{\"type\":\"text\",\"text\":\"段\"}]}}]}\n\n" +
                "data: [DONE]\n").toByteArray(Charsets.UTF_8))
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "parts-model", "fake-key")
            val chunks = mutableListOf<Pair<String, String>>()
            val result = store.generate("问候", JSONObject().put("stream", true)) { delta, full -> chunks.add(delta to full) }
            assertEquals("分段", result.getString("text"))
            assertEquals(listOf("分段" to "分段"), chunks)
        } finally { store.clear() }
    }

    @Test fun providerErrorCannotEchoCredentialToRoom() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getResponseCode() = 401
            override fun getErrorStream() = ByteArrayInputStream("Invalid bearer room-secret-123".toByteArray())
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            store.save("https://models.example.test/v1/chat/completions", "test-model", "room-secret-123")
            val error = runCatching { store.generate("测试") }.exceptionOrNull()!!
            assertTrue(error.message.orEmpty().contains("HTTP 401"))
            assertFalse(error.message.orEmpty().contains("room-secret-123"))
            assertFalse(error.message.orEmpty().contains("Invalid bearer"))
        } finally { store.clear() }
    }

    @Test fun multimodalProfilePublishesCapabilitiesAndSendsImageAudioParts() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val sent = ByteArrayOutputStream()
        val fake = object : HttpURLConnection(URL("https://models.example.test/v1/chat/completions")) {
            override fun connect() { connected = true }
            override fun disconnect() { connected = false }
            override fun usingProxy() = false
            override fun getOutputStream() = sent
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream("""{"choices":[{"message":{"content":"看到了，也听到了"}}]}""".toByteArray())
        }
        val store = AiModelStore(context) { fake }
        store.clear()
        try {
            val id = store.saveProfile(null, "多模态", "https://models.example.test/v1/chat/completions", "multi", "fake-key",
                supportsImages = true, supportsAudio = true)
            val public = store.listPublic().getJSONObject(0)
            assertTrue(public.getBoolean("supportsImages"))
            assertTrue(public.getBoolean("supportsAudio"))
            assertEquals(3, public.getJSONArray("input").length())
            assertFalse(public.toString().contains("fake-key"))
            val options = JSONObject().put("profileId", id)
                .put("images", org.json.JSONArray().put(JSONObject().put("mimeType", "image/png").put("data", "aW1hZ2U=")))
                .put("audio", org.json.JSONArray().put(JSONObject().put("mimeType", "audio/wav").put("data", "YXVkaW8=")))
            assertEquals("看到了，也听到了", store.generate("描述", options).getString("text"))
            val content = JSONObject(sent.toString("UTF-8")).getJSONArray("messages").getJSONObject(0).getJSONArray("content")
            assertEquals("text", content.getJSONObject(0).getString("type"))
            assertEquals("data:image/png;base64,aW1hZ2U=", content.getJSONObject(1).getJSONObject("image_url").getString("url"))
            assertEquals("wav", content.getJSONObject(2).getJSONObject("input_audio").getString("format"))
            assertEquals("YXVkaW8=", content.getJSONObject(2).getJSONObject("input_audio").getString("data"))
        } finally { store.clear() }
    }

    @Test fun modelMustDeclareMultimodalInputBeforeMediaRequest() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = AiModelStore(context)
        store.clear()
        try {
            store.saveProfile(null, "仅文本", "https://models.example.test/v1/chat/completions", "text", "fake-key")
            val image = JSONObject().put("images", org.json.JSONArray().put(JSONObject().put("mimeType", "image/png").put("data", "aW1hZ2U=")))
            assertTrue(runCatching { store.generate("描述", image) }.exceptionOrNull()?.message.orEmpty().contains("图片输入"))
            val audio = JSONObject().put("audio", org.json.JSONArray().put(JSONObject().put("mimeType", "audio/wav").put("data", "YXVkaW8=")))
            assertTrue(runCatching { store.generate("描述", audio) }.exceptionOrNull()?.message.orEmpty().contains("音频输入"))
        } finally { store.clear() }
    }
}
