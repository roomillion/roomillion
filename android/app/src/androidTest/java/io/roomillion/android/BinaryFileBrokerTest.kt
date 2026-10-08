package io.roomillion.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File

@RunWith(AndroidJUnit4::class)
class BinaryFileBrokerTest {
    @Test fun callerLimitStopsUnknownSizeStreamAndRemovesPartialCopy() {
        val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        val root = File(cache, "binary-limit-test-${System.nanoTime()}")
        val broker = BinaryFileBroker(root)
        try {
            val error = runCatching {
                broker.import(ByteArrayInputStream(ByteArray(17)), "long.wav", "audio/wav", 16)
            }.exceptionOrNull()
            assertTrue(error?.message.orEmpty().contains("超过 16 字节"))
            assertTrue(root.listFiles().orEmpty().isEmpty())
            assertTrue(runCatching {
                broker.import(ByteArrayInputStream(byteArrayOf(1)), "short.wav", "audio/wav", 0)
            }.isFailure)
        } finally { broker.clear() }
    }

    @Test fun selectedFileIsReadInBoundedChunksAndRevokedOnClose() {
        val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        val first = BinaryFileBroker(File(cache, "binary-test-${System.nanoTime()}"))
        val second = BinaryFileBroker(File(cache, "binary-test-${System.nanoTime()}-other"))
        try {
            val bytes = ByteArray(BinaryFileBroker.CHUNK_BYTES + 17) { index -> (index % 251).toByte() }
            val handle = first.import(ByteArrayInputStream(bytes), "scan.png", "image/png")
            assertEquals(bytes.size.toLong(), handle.size)
            assertFalse(handle.publicInfo().toString().contains(cache.absolutePath))
            val (head, headEnd) = first.read(handle.token, 0, BinaryFileBroker.CHUNK_BYTES)
            assertFalse(headEnd)
            val (tail, tailEnd) = first.read(handle.token, head.size.toLong(), BinaryFileBroker.CHUNK_BYTES)
            assertTrue(tailEnd)
            assertArrayEquals(bytes, head + tail)
            assertTrue(runCatching { second.read(handle.token, 0, 1) }.isFailure)
            assertTrue(runCatching { first.read(handle.token, -1, 1) }.isFailure)
            assertTrue(runCatching { first.read(handle.token, 0, BinaryFileBroker.CHUNK_BYTES + 1) }.isFailure)
            assertTrue(first.close(handle.token))
            assertTrue(runCatching { first.read(handle.token, 0, 1) }.isFailure)
            assertFalse(first.close(handle.token))
        } finally { first.clear(); second.clear() }
    }

    @Test fun stagedExportAppendsChunksAndDeletesItsTemporaryCopy() {
        val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        val broker = BinaryFileBroker(File(cache, "export-test-${System.nanoTime()}"))
        try {
            val export = broker.beginExport("结果.pdf")
            assertEquals(2L, broker.writeExport(export.token, byteArrayOf(1, 2)))
            assertEquals(5L, broker.writeExport(export.token, byteArrayOf(3, 4, 5)))
            assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5), broker.export(export.token).file.readBytes())
            assertTrue(runCatching { broker.writeExport(export.token, ByteArray(BinaryFileBroker.CHUNK_BYTES + 1)) }.isFailure)
            assertTrue(broker.abortExport(export.token))
            assertFalse(export.file.exists())
            assertTrue(runCatching { broker.export(export.token) }.isFailure)
        } finally { broker.clear() }
    }
}
