package io.roomillion.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class AiMediaCodecTest {
    @Test fun identifiesImageAndAudioByContentWithoutExposingPath() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "ai-codec-test")
        val broker = BinaryFileBroker(root)
        try {
            val png = broker.beginExport("page.png")
            broker.writeExport(png.token, byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
            val image = AiMediaCodec.resolve("image", broker.export(png.token), "image/png")
            assertEquals("image/png", image.getString("mimeType"))
            assertFalse(image.toString().contains(root.absolutePath))

            val wav = broker.beginExport("sample.wav")
            broker.writeExport(wav.token, "RIFF0000WAVE".toByteArray())
            assertEquals("audio/wav", AiMediaCodec.resolve("audio", broker.export(wav.token), null).getString("mimeType"))
            assertTrue(runCatching { AiMediaCodec.resolve("image", broker.export(wav.token), null) }.isFailure)
            assertTrue(runCatching { AiMediaCodec.resolve("audio", broker.export(wav.token), "audio/mpeg") }.isFailure)
        } finally { broker.clear() }
    }
}
