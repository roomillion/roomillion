package io.roomillion.android

import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class RoomTransferExporterTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets

    @Test fun exportedProgramCanBeImportedAgain() {
        val root = File(context.cacheDir, "export-app-test-${System.nanoTime()}")
        val source = RoomPackageStore(File(root, "source"))
        val installed = assets.open("inventory.room").use { source.install(it) }
        val exported = RoomTransferExporter(File(root, "source"), root).create(installed, false)
        val target = RoomTransferStore(File(root, "target"))
        val report = exported.inputStream().use { target.inspect(it) }
        assertEquals("program", report.contents)
        assertTrue(report.canInstall)
        assertEquals(installed.id, exported.inputStream().use { target.install(it) }.id)
        root.deleteRecursively()
    }

    @Test fun exportedDataRoundTripsWithoutLosingDatabaseOrAsset() {
        val root = File(context.cacheDir, "export-data-test-${System.nanoTime()}")
        val source = RoomPackageStore(File(root, "source"))
        val installed = assets.open("inventory.room").use { source.install(it) }
        installed.data.mkdirs()
        val db = SQLiteDatabase.openOrCreateDatabase(File(installed.data, "room.db"), null)
        db.use {
            it.execSQL("CREATE TABLE transfer(value TEXT)")
            it.execSQL("INSERT INTO transfer(value) VALUES('ANDROID_DATABASE')")
        }
        File(installed.data, "files").mkdirs()
        File(installed.data, "files/note.md").writeText("ANDROID_ASSET")
        val blobs = RoomBlobStore(installed.data)
        val opened = blobs.begin(org.json.JSONObject().put("name", "page.png").put("mimeType", "image/png"))
        blobs.write(opened.getString("token"), byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
        val blobId = blobs.finish(opened.getString("token")).getString("id")
        blobs.close()
        val exported = RoomTransferExporter(File(root, "source"), root).create(installed, true)
        val target = RoomTransferStore(File(root, "target"))
        assertEquals("app-and-data", exported.inputStream().use { target.inspect(it) }.contents)
        val migrated = exported.inputStream().use { target.install(it) }
        assertEquals("ANDROID_ASSET", File(migrated.data, "files/note.md").readText())
        val importedBlobs = RoomBlobStore(migrated.data)
        assertEquals(blobId, importedBlobs.list().getJSONObject(0).getString("id"))
        assertEquals(4, importedBlobs.getFile(blobId).second.length())
        importedBlobs.close()
        SQLiteDatabase.openDatabase(File(migrated.data, "room.db").absolutePath, null, SQLiteDatabase.OPEN_READONLY).use {
            it.rawQuery("SELECT value FROM transfer", null).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("ANDROID_DATABASE", cursor.getString(0))
            }
        }
        root.deleteRecursively()
    }

    @Test fun passwordProtectedAndroidExportRoundTripsAndWrongPasswordFails() {
        val root = File(context.cacheDir, "export-protected-test-${System.nanoTime()}")
        val source = RoomPackageStore(File(root, "source"))
        val installed = assets.open("inventory.room").use { source.install(it) }
        installed.data.mkdirs()
        File(installed.data, "files").mkdirs()
        File(installed.data, "files/private.txt").writeText("SECRET_ANDROID_DATA")
        val exporter = RoomTransferExporter(File(root, "source"), root)
        val encrypted = exporter.create(installed, true, "android-export-password")
        assertTrue(runCatching { encrypted.inputStream().use { RoomTransferStore(File(root, "target")).inspect(it, "wrong-password") } }.isFailure)
        val target = RoomTransferStore(File(root, "target"))
        val migrated = encrypted.inputStream().use { target.install(it, "android-export-password") }
        assertEquals("SECRET_ANDROID_DATA", File(migrated.data, "files/private.txt").readText())
        val programOnly = exporter.create(installed, false, "android-export-password")
        assertEquals("app-only", programOnly.inputStream().use { target.inspect(it, "android-export-password") }.contents)
        root.deleteRecursively()
    }
}
