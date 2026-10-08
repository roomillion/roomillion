package io.roomillion.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class RoomBlobStoreTest {
    @Test fun desktopCompatibleIndexPersistsAcrossSessionsAndRoomsStayIsolated() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "blob-test-${UUID.randomUUID()}")
        val first = RoomBlobStore(File(root, "first"))
        try {
            val options = JSONObject().put("name", "../扫描页.png").put("mimeType", "image/png")
                .put("kind", "artifact").put("metadata", JSONObject().put("page", 12))
            val opened = first.begin(options)
            val token = opened.getString("token")
            assertEquals(2, first.write(token, byteArrayOf(0, 255.toByte())).getInt("bytes"))
            assertEquals(5, first.write(token, byteArrayOf(10, 20, 30)).getInt("bytes"))
            val saved = first.finish(token)
            assertEquals("artifact", saved.getString("kind"))
            assertEquals(12, saved.getJSONObject("metadata").getInt("page"))
            assertFalse(saved.getString("name").contains("/"))
            assertTrue(Regex("[a-f0-9]{32}").matches(saved.getString("id")))
            val index = JSONObject(File(root, "first/blobs/index.json").readText())
            assertEquals(1, index.getInt("formatVersion"))
            assertEquals(saved.getString("id"), index.getJSONArray("items").getJSONObject(0).getString("id"))
            first.close()
            val reopened = RoomBlobStore(File(root, "first"))
            val id = saved.getString("id")
            assertEquals(1, reopened.list(JSONObject().put("kind", "artifact")).length())
            val chunk = reopened.read(id, JSONObject().put("offset", 1).put("length", 3))
            assertArrayEquals(byteArrayOf(255.toByte(), 10, 20),
                android.util.Base64.decode(chunk.getString("base64"), android.util.Base64.DEFAULT))
            assertEquals(4, chunk.getInt("nextOffset"))
            val other = RoomBlobStore(File(root, "other"))
            assertTrue(runCatching { other.read(id) }.isFailure)
            assertEquals(0, other.list().length())
            assertTrue(reopened.remove(id))
            assertFalse(reopened.remove(id))
            assertEquals(0, reopened.list().length())
            reopened.close()
            other.close()
        } finally { root.deleteRecursively() }
    }

    @Test fun abortedWriteLeavesNoIndexOrFile() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "blob-abort-${UUID.randomUUID()}")
        val store = RoomBlobStore(root)
        try {
            val opened = store.begin()
            store.write(opened.getString("token"), "not saved".toByteArray())
            assertTrue(store.abort(opened.getString("token")))
            assertEquals(0, store.list().length())
            assertFalse(File(root, "blobs/${opened.getString("id")}.bin").exists())
        } finally { store.close(); root.deleteRecursively() }
    }
}
