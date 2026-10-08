package io.roomillion.android

import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

@RunWith(AndroidJUnit4::class)
class RoomTransferStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private fun root() = File(context.cacheDir, "transfer-test-${System.nanoTime()}")

    @Test fun importPreviewDistinguishesFirstInstallFromProgramUpdateAndDataRestore() {
        val root = root()
        try {
            val transfer = RoomTransferStore(root)
            val program = assets.open("inventory.room").use { transfer.inspect(it) }
            assertTrue(program.describe(false).contains("创建新的房间数据空间"))
            assertFalse(program.describe(false).contains("保留现有房间数据"))
            assets.open("inventory.room").use { transfer.install(it) }
            assertTrue(program.describe(true).contains("保留现有房间数据"))
            val withData = assets.open("desktop-app-and-data.room").use { transfer.inspect(it) }
            assertTrue(withData.describe(false).contains("一并安装"))
            assertTrue(withData.describe(true).contains("替换现有同名房间的数据"))
        } finally { root.deleteRecursively() }
    }

    @Test fun importsActualDesktopExportWithDatabaseAndFiles() {
        val root = root()
        val store = RoomTransferStore(root)
        val report = assets.open("desktop-app-and-data.room").use { store.inspect(it) }
        assertEquals("app-and-data", report.contents)
        assertTrue(report.canInstall)
        val installed = assets.open("desktop-app-and-data.room").use { store.install(it) }
        assertEquals("cn.zhibian.example.inventory", installed.id)
        assertEquals("DESKTOP_ASSET", File(installed.data, "files/private-note.txt").readText())
        val blobs = RoomBlobStore(installed.data)
        val desktopBlob = blobs.list().getJSONObject(0)
        assertEquals("desktop-page.png", desktopBlob.getString("name"))
        assertEquals("image/png", desktopBlob.getString("mimeType"))
        assertEquals(8, blobs.getFile(desktopBlob.getString("id")).second.length())
        blobs.close()
        val db = SQLiteDatabase.openDatabase(File(installed.data, "room.db").absolutePath, null, SQLiteDatabase.OPEN_READONLY)
        db.use {
            it.rawQuery("SELECT value FROM transfer_fixture", null).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("DESKTOP_DATABASE", cursor.getString(0))
            }
        }
        root.deleteRecursively()
    }

    @Test fun damagedTransferCannotReplaceInstalledProgramOrData() {
        val root = root()
        val packages = RoomPackageStore(root)
        val original = assets.open("inventory.room").use { packages.install(it) }
        original.data.mkdirs()
        File(original.data, "keep.txt").writeText("ORIGINAL_DATA")
        val valid = assets.open("desktop-app-and-data.room").use { it.readBytes() }
        val changed = ByteArrayOutputStream().also { out ->
            ZipOutputStream(out).use { output ->
                ZipInputStream(ByteArrayInputStream(valid)).use { input ->
                    while (true) {
                        val entry = input.nextEntry ?: break
                        if (entry.isDirectory) continue
                        val bytes = input.readBytes()
                        output.putNextEntry(ZipEntry(entry.name))
                        output.write(if (entry.name == "data.roomdb") bytes + 1.toByte() else bytes)
                        output.closeEntry()
                    }
                }
            }
        }.toByteArray()
        val transfer = RoomTransferStore(root)
        assertTrue(runCatching { transfer.inspect(ByteArrayInputStream(changed)) }.isFailure)
        assertTrue(runCatching { transfer.install(ByteArrayInputStream(changed)) }.isFailure)
        assertEquals("ORIGINAL_DATA", File(packages.readInstalled(original.id).data, "keep.txt").readText())
        assertFalse(File(packages.readInstalled(original.id).data, "room.db").exists())
        root.deleteRecursively()
    }

    @Test fun recoversInterruptedReplacementBeforeShowingRooms() {
        val root = root()
        val packages = RoomPackageStore(root)
        val original = assets.open("inventory.room").use { packages.install(it) }
        val oldHome = File(root, original.id)
        val backup = File(root, ".transfer-backup-${original.id}")
        assertTrue(oldHome.renameTo(backup))
        val restarted = RoomPackageStore(root)
        assertEquals(original.id, restarted.list().single().id)
        assertFalse(backup.exists())
        root.deleteRecursively()
    }

    @Test fun decryptsDesktopTransferAndRejectsWrongPassword() {
        val root = root()
        val transfer = RoomTransferStore(root)
        assertTrue(assets.open("desktop-encrypted.room").use { input ->
            runCatching { transfer.inspect(input) }.exceptionOrNull() is TransferPasswordRequired
        })
        assertTrue(assets.open("desktop-encrypted.room").use { input ->
            runCatching { transfer.install(input, "incorrect-password") }.isFailure
        })
        assertTrue(RoomPackageStore(root).list().isEmpty())
        val report = assets.open("desktop-encrypted.room").use { transfer.inspect(it, "android-test-password") }
        assertEquals("app-and-data", report.contents)
        assertTrue(report.canInstall)
        val installed = assets.open("desktop-encrypted.room").use { transfer.install(it, "android-test-password") }
        assertEquals("DESKTOP_ASSET", File(installed.data, "files/private-note.txt").readText())
        root.deleteRecursively()
    }

    @Test fun passwordProtectedProgramUpgradeRetainsExistingData() {
        val root = root()
        val packages = RoomPackageStore(root)
        val existing = assets.open("inventory.room").use { packages.install(it) }
        existing.data.mkdirs()
        File(existing.data, "keep.txt").writeText("KEEP_ME")
        val transfer = RoomTransferStore(root)
        val report = assets.open("desktop-encrypted-app-only.room").use { transfer.inspect(it, "android-test-password") }
        assertEquals("app-only", report.contents)
        val installed = assets.open("desktop-encrypted-app-only.room").use { transfer.install(it, "android-test-password") }
        assertEquals("KEEP_ME", File(installed.data, "keep.txt").readText())
        root.deleteRecursively()
    }

    @Test fun encryptedEnvelopeMetadataTamperingDoesNotInstall() {
        val root = root()
        val transfer = RoomTransferStore(root)
        val original = assets.open("desktop-encrypted.room").bufferedReader().use { JSONObject(it.readText()) }
        original.getJSONObject("room").put("name", "冒名房间")
        assertTrue(runCatching {
            transfer.install(ByteArrayInputStream(original.toString().toByteArray()), "android-test-password")
        }.isFailure)
        assertTrue(RoomPackageStore(root).list().isEmpty())
        root.deleteRecursively()
    }

    @Test fun legacyDesktopTransferRestoresDatabaseAndKeepsExistingAssets() {
        val root = root()
        val packages = RoomPackageStore(root)
        val original = assets.open("inventory.room").use { packages.install(it) }
        original.data.mkdirs()
        File(original.data, "keep.txt").writeText("LEGACY_ASSET")
        val transfer = RoomTransferStore(root)
        val inspected = assets.open("desktop-legacy.room").use { transfer.inspect(it) }
        assertTrue(inspected.canInstall)
        val installed = assets.open("desktop-legacy.room").use { transfer.install(it) }
        assertEquals("LEGACY_ASSET", File(installed.data, "keep.txt").readText())
        val db = SQLiteDatabase.openDatabase(File(installed.data, "room.db").absolutePath, null, SQLiteDatabase.OPEN_READONLY)
        db.use { it.rawQuery("SELECT value FROM transfer_fixture", null).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("DESKTOP_DATABASE", cursor.getString(0))
        } }
        root.deleteRecursively()
    }
}
