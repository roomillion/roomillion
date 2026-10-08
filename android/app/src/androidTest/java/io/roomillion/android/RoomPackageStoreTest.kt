package io.roomillion.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@RunWith(AndroidJUnit4::class)
class RoomPackageStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun packageBytes(files: Map<String, ByteArray>): ByteArray {
        val checks = JSONArray()
        for ((name, bytes) in files) {
            val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            checks.put(JSONObject().put("path", name).put("size", bytes.size).put("sha256", sha))
        }
        val all = files + mapOf("integrity.json" to JSONObject().put("algorithm", "sha256").put("files", checks).toString().toByteArray())
        return ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                for ((name, bytes) in all) {
                    zip.putNextEntry(ZipEntry(name))
                    zip.write(bytes)
                    zip.closeEntry()
                }
            }
        }.toByteArray()
    }

    private fun basicFiles(version: String = "1.0.0") = mapOf(
        "manifest.json" to JSONObject()
            .put("formatVersion", "0.1").put("id", "io.roomillion.test.fixture")
            .put("name", "测试房间").put("version", version)
            .put("entry", "app/index.html")
            .put("runtime", JSONObject().put("roomSdk", "1"))
            .put("permissions", JSONObject().put("database", "private"))
            .toString().toByteArray(),
        "app/index.html" to "<html><body>测试</body></html>".toByteArray()
    )

    private fun temporaryStore(): RoomPackageStore {
        val directory = File(context.cacheDir, "package-test-${System.nanoTime()}")
        return RoomPackageStore(directory)
    }

    @Test fun installsPublicInventoryProgram() {
        val store = temporaryStore()
        val installed = InstrumentationRegistry.getInstrumentation().context.assets.open("inventory.room").use { store.install(it) }
        assertEquals("cn.zhibian.example.inventory", installed.id)
        assertTrue(File(installed.program, installed.entry).isFile)
        assertEquals(1, store.list().size)
    }

    @Test fun installablePublicExamplesAreBundledInTheApp() {
        val assets = context.assets
        val expected = BundledExamples.all.map { it.fileName }.toSet()
        assertEquals(expected, assets.list("examples").orEmpty().toSet())
        val store = temporaryStore()
        for (example in BundledExamples.all) {
            val asset = "examples/${example.fileName}"
            val report = assets.open(asset).use { store.inspect(it) }
            assertTrue("${example.name}: ${report.blockers}", report.canInstall)
            val installed = assets.open(asset).use { store.install(it) }
            assertEquals(example.name, installed.name)
            assertTrue(File(installed.program, installed.entry).isFile)
        }
        assertEquals(expected.size, store.list().size)
    }

    @Test fun rejectsPathTraversalAndCorruptIntegrity() {
        val store = temporaryStore()
        val escaping = packageBytes(basicFiles() + ("../outside.txt" to "bad".toByteArray()))
        assertTrue(runCatching { store.install(ByteArrayInputStream(escaping)) }.isFailure)
        // Manifest content is deliberately changed after the archive's integrity was generated.
        // Rebuilding a ZIP while retaining its old integrity record exercises the hash check.
        val files = basicFiles().toMutableMap()
        val original = files["manifest.json"]!!
        files["manifest.json"] = original + byteArrayOf(32)
        val mismatch = ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                for ((name, bytes) in files) { zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry() }
                val manifestSha = MessageDigest.getInstance("SHA-256").digest(original).joinToString("") { "%02x".format(it) }
                val html = files["app/index.html"]!!
                val htmlSha = MessageDigest.getInstance("SHA-256").digest(html).joinToString("") { "%02x".format(it) }
                val integrity = JSONObject().put("algorithm", "sha256").put("files", JSONArray()
                    .put(JSONObject().put("path", "manifest.json").put("size", original.size).put("sha256", manifestSha))
                    .put(JSONObject().put("path", "app/index.html").put("size", html.size).put("sha256", htmlSha)))
                zip.putNextEntry(ZipEntry("integrity.json")); zip.write(integrity.toString().toByteArray()); zip.closeEntry()
            }
        }.toByteArray()
        assertTrue(runCatching { store.install(ByteArrayInputStream(mismatch)) }.isFailure)
        assertTrue(store.list().isEmpty())
        assertFalse(File(context.cacheDir, "outside.txt").exists())
    }

    @Test fun upgradePreservesPrivateDataAndFailedUpgradePreservesProgram() {
        val store = temporaryStore()
        val first = store.install(ByteArrayInputStream(packageBytes(basicFiles())))
        first.data.mkdirs()
        File(first.data, "room.db").writeText("private-data")
        val second = store.install(ByteArrayInputStream(packageBytes(basicFiles("1.0.1"))))
        assertEquals("1.0.1", second.version)
        assertEquals("private-data", File(second.data, "room.db").readText())
        // Invalid packages must not replace an installed version.
        val truncated = packageBytes(basicFiles("2.0.0")).copyOf(20)
        assertTrue(runCatching { store.install(ByteArrayInputStream(truncated)) }.isFailure)
        assertEquals("1.0.1", store.readInstalled(second.id).version)
    }

    @Test fun uninstallDeletesProgramAndPrivateDataWithoutEscapingRoomDirectory() {
        val store = temporaryStore()
        val installed = store.install(ByteArrayInputStream(packageBytes(basicFiles())))
        installed.data.mkdirs()
        File(installed.data, "private.txt").writeText("user data")
        val home = requireNotNull(installed.program.parentFile)
        val root = requireNotNull(home.parentFile)
        val neighbor = File(root, "keep.txt").apply { writeText("keep") }
        assertTrue(runCatching { store.uninstall("../keep.txt") }.isFailure)
        assertTrue(store.uninstall(installed.id))
        assertFalse(store.uninstall(installed.id))
        assertFalse(home.exists())
        assertEquals("keep", neighbor.readText())
        val reinstalled = store.install(ByteArrayInputStream(packageBytes(basicFiles())))
        assertFalse(File(reinstalled.data, "private.txt").exists())
        val outside = File(root.parentFile, "uninstall-outside-${System.nanoTime()}")
        outside.mkdirs()
        val link = File(root, "io.roomillion.test.link")
        try {
            Files.createSymbolicLink(link.toPath(), outside.toPath())
            assertTrue(runCatching { store.uninstall(link.name) }.isFailure)
            assertTrue("卸载不能跟随目录链接删除外部数据", outside.isDirectory)
        } finally {
            Files.deleteIfExists(link.toPath())
            outside.deleteRecursively()
        }
    }

    @Test fun rejectsUnsupportedTransferAndEncryptedPackagesClearly() {
        val store = temporaryStore()
        val transfer = packageBytes(mapOf("room.zroom" to "nested".toByteArray()))
        val transferError = runCatching { store.install(ByteArrayInputStream(transfer)) }.exceptionOrNull()
        assertTrue(transferError?.message.orEmpty().contains("完整房间传输包"))
        val encryptedError = runCatching { store.install(ByteArrayInputStream("{\"format\":\"encrypted\"}".toByteArray())) }.exceptionOrNull()
        assertTrue(encryptedError?.message.orEmpty().contains("加密传输包"))
    }

    @Test fun rejectsUnportedHostModules() {
        val store = temporaryStore()
        val files = basicFiles().toMutableMap()
        val manifest = JSONObject(String(files["manifest.json"]!!))
            .put("hostModules", JSONArray().put("document.pdf.compose@1"))
        files["manifest.json"] = manifest.toString().toByteArray()
        val error = runCatching { store.install(ByteArrayInputStream(packageBytes(files))) }.exceptionOrNull()
        assertTrue(error?.message.orEmpty().contains("宿主模块"))
    }

    @Test fun acceptsAuditedModulesButRequiresDeclaredDependencies() {
        val store = temporaryStore()
        val files = basicFiles().toMutableMap()
        val manifest = JSONObject(String(files["manifest.json"]!!))
            .put("hostModules", JSONArray().put("security.sanitize@1").put("document.markdown@1"))
        files["manifest.json"] = manifest.toString().toByteArray()
        assertTrue(store.inspect(ByteArrayInputStream(packageBytes(files))).canInstall)
        manifest.put("hostModules", JSONArray().put("document.markdown@1"))
        files["manifest.json"] = manifest.toString().toByteArray()
        val missing = store.inspect(ByteArrayInputStream(packageBytes(files)))
        assertFalse(missing.canInstall)
        assertTrue(missing.blockers.any { it.contains("需要 security.sanitize@1") })
        manifest.put("hostModules", JSONArray().put("document.word.preview@1"))
        files["manifest.json"] = manifest.toString().toByteArray()
        val preview = store.inspect(ByteArrayInputStream(packageBytes(files)))
        assertFalse(preview.canInstall)
        assertTrue(preview.blockers.any { it.contains("archive.zip@1") })
    }

    @Test fun allEightPublicRoomsReceiveConservativeCompatibilityReports() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val store = temporaryStore()
        val names = listOf("inventory", "meeting-actions", "ai-debate", "ai-model-benchmark",
            "audio-analysis", "browser", "document-workbench", "offline-3d-collector")
        val reports = names.associateWith { name -> assets.open("$name.room").use { store.inspect(it) } }
        assertTrue(store.list().isEmpty())
        assertTrue(reports.getValue("inventory").canInstall)
        assertTrue(reports.getValue("meeting-actions").canInstall)
        assertTrue(reports.getValue("document-workbench").canInstall)
        assertFalse(reports.getValue("offline-3d-collector").canInstall)
        assertTrue(reports.getValue("browser").warnings.any { it.contains("浏览器") })
        assertTrue(reports.getValue("audio-analysis").warnings.any { it.contains("audio") || it.contains("音频") || it.contains("pickBinary") })
        assertTrue(reports.getValue("ai-model-benchmark").warnings.any { it.contains("图片") || it.contains("vision") })
        for (report in reports.values) assertTrue(report.describe().contains("静态检查无法证明"))
    }
}
