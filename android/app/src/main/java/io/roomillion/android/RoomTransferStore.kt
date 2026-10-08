package io.roomillion.android

import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.text.Normalizer
import java.time.Instant
import java.util.Locale
import java.util.UUID
import java.util.zip.ZipFile

data class TransferInspection(val compatibility: RoomCompatibilityReport, val contents: String) {
    val canInstall: Boolean get() = compatibility.canInstall
    fun describe(existingRoom: Boolean = false): String = compatibility.describe() + when (contents) {
        "app-and-data" -> if (existingRoom) "\n\n此包还会恢复数据库和房间附件，替换现有同名房间的数据。"
            else "\n\n此包包含程序、数据库和房间附件，导入时会一并安装。"
        else -> if (existingRoom) "\n\n此包只更新程序，保留现有房间数据。"
            else "\n\n此包只包含程序，导入后会创建新的房间数据空间。"
    }
}

/** Reads the desktop .room transfer container, with a conservative Android size ceiling. */
class RoomTransferStore(private val root: File) {
    private val packages = RoomPackageStore(root)
    private val maxArchive = 256L * 1024 * 1024
    private val maxUnpacked = 384L * 1024 * 1024
    private val maxEntry = 192L * 1024 * 1024
    private val shaPattern = Regex("[a-f0-9]{64}")
    private val idPattern = Regex("[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?")
    private val blobPath = Regex("data/blobs/[a-f0-9]{32}\\.bin")

    init { require(root.mkdirs() || root.isDirectory) }

    fun inspect(input: InputStream, password: String? = null): TransferInspection = withArchive(input, password) { archive ->
        val bundle = archive.getEntry("bundle.json")
        if (bundle == null) {
            val report = FileInput(archive.name).use { packages.inspect(it) }
            TransferInspection(report, "program")
        } else withBundle(archive) { manifest, extracted ->
            val report = File(extracted, "room.zroom").inputStream().use { packages.inspect(it) }
            checkIdentity(manifest, report)
            TransferInspection(report, manifest.getString("contents"))
        }
    }

    fun install(input: InputStream, password: String? = null): InstalledRoom = withArchive(input, password) { archive ->
        if (archive.getEntry("bundle.json") == null) {
            FileInput(archive.name).use { packages.install(it) }
        } else withBundle(archive) { manifest, extracted ->
            val app = File(extracted, "room.zroom")
            val report = app.inputStream().use { packages.inspect(it) }
            checkIdentity(manifest, report)
            require(report.canInstall) { report.blockers.joinToString("；") }
            if (manifest.getString("contents") == "app-only") return@withBundle app.inputStream().use { packages.install(it) }

            val stagingRoot = File(root, ".transfer-stage-${UUID.randomUUID()}")
            require(stagingRoot.mkdir()) { "无法暂存房间数据" }
            try {
                val staged = RoomPackageStore(stagingRoot).install(app.inputStream())
                require(staged.id == report.id) { "应用身份不匹配" }
                val data = staged.data
                require(data.mkdirs() || data.isDirectory)
                val legacy = manifest.getString("formatVersion") == "0.2"
                val currentHome = File(root, staged.id)
                val backup = File(root, ".transfer-backup-${staged.id}")
                require(!backup.exists()) { "房间上次迁移尚未恢复，请重启应用后重试" }
                if (legacy && File(currentHome, "data").isDirectory) {
                    require(File(currentHome, "data").copyRecursively(data, overwrite = true)) { "无法保留旧房间附件" }
                }
                File(extracted, "data.roomdb").copyTo(File(data, "room.db"), overwrite = true)
                if (!legacy) {
                    for (record in manifest.getJSONArray("assets").let { array -> (0 until array.length()).map { array.getJSONObject(it) } }) {
                        val path = record.getString("path").removePrefix("data/")
                        val destination = File(data, path)
                        require(destination.parentFile?.mkdirs() == true || destination.parentFile?.isDirectory == true)
                        File(extracted, record.getString("path")).copyTo(destination)
                    }
                }
                val stagedHome = File(stagingRoot, staged.id)
                var movedOld = false
                if (currentHome.exists()) {
                    require(currentHome.renameTo(backup)) { "无法暂存现有房间" }
                    movedOld = true
                }
                try {
                    require(stagedHome.renameTo(currentHome)) { "无法安装完整房间" }
                    val installed = packages.readInstalled(staged.id)
                    if (movedOld) backup.deleteRecursively()
                    installed
                } catch (error: Exception) {
                    if (currentHome.exists()) currentHome.deleteRecursively()
                    if (movedOld) require(backup.renameTo(currentHome)) { "恢复旧房间失败，请保留应用数据并重启" }
                    throw error
                }
            } finally {
                stagingRoot.deleteRecursively()
            }
        }
    }

    private inline fun <T> withArchive(input: InputStream, password: String?, block: (ZipFile) -> T): T {
        val temporary = File(root, ".transfer-input-${UUID.randomUUID()}")
        val decrypted = File(root, ".transfer-unlocked-${UUID.randomUUID()}")
        try {
            input.use { source -> temporary.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val count = source.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= maxArchive) { "房间包超过安卓导入上限（256 MiB）" }
                    output.write(buffer, 0, count)
                }
            } }
            require(temporary.length() >= 4) { "房间包为空或损坏" }
            val isZip = temporary.inputStream().use { bytes -> bytes.read() == 0x50 && bytes.read() == 0x4b }
            val envelope = if (isZip) null else EncryptedRoomTransfer.unlock(temporary, password, decrypted)
            return ZipFile(if (isZip) temporary else decrypted).use { zip ->
                if (envelope != null) {
                    val entry = zip.getEntry("bundle.json") ?: error("加密房间包缺少传输清单")
                    require(entry.size in 1..1_000_000) { "加密房间包清单无效" }
                    val bundle = zip.getInputStream(entry).use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
                    require(EncryptedRoomTransfer.matches(envelope, bundle)) { "加密房间包外层信息与内部清单不一致" }
                }
                block(zip)
            }
        } finally { temporary.delete(); decrypted.delete() }
    }

    private inline fun <T> withBundle(archive: ZipFile, block: (JSONObject, File) -> T): T {
        val stage = File(root, ".transfer-extract-${UUID.randomUUID()}")
        require(stage.mkdir()) { "无法建立传输临时目录" }
        try {
            val names = mutableSetOf<String>()
            var unpacked = 0L
            val entries = archive.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val name = entry.name.trimEnd('/')
                if (name.isEmpty()) continue
                validatePath(name)
                val key = Normalizer.normalize(name, Normalizer.Form.NFC).lowercase(Locale.ROOT)
                require(names.add(key) && names.size <= 20_000) { "房间传输包路径重复或文件过多" }
                val dest = File(stage, name)
                require(dest.canonicalPath.startsWith(stage.canonicalPath + File.separator)) { "房间路径越界" }
                if (entry.isDirectory) { require(dest.mkdirs() || dest.isDirectory); continue }
                require(dest.parentFile?.mkdirs() == true || dest.parentFile?.isDirectory == true)
                archive.getInputStream(entry).use { source -> dest.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var entryBytes = 0L
                    while (true) {
                        val count = source.read(buffer)
                        if (count < 0) break
                        entryBytes += count; unpacked += count
                        require(entryBytes <= maxEntry && unpacked <= maxUnpacked) { "房间传输包解压后超过安卓上限" }
                        output.write(buffer, 0, count)
                    }
                } }
            }
            val bundleFile = File(stage, "bundle.json")
            require(bundleFile.isFile && bundleFile.length() in 1..1_000_000) { "房间传输清单无效" }
            val manifest = JSONObject(bundleFile.readText(Charsets.UTF_8))
            require(manifest.getString("kind") == "zhibian-room-transfer") { "不支持的房间传输格式" }
            val version = manifest.getString("formatVersion")
            require(version in setOf("0.2", "0.3")) { "不支持的房间传输版本" }
            val contents = manifest.getString("contents")
            require(contents in setOf("app-only", "app-and-data")) { "房间传输内容无效" }
            val room = manifest.getJSONObject("room")
            require(idPattern.matches(room.getString("id")) && room.getString("name").length in 1..80 &&
                room.getString("version").length in 1..80) { "房间信息无效" }
            require(runCatching { Instant.parse(manifest.getString("createdAt")) }.isSuccess) { "房间创建时间无效" }
            val expected = mutableSetOf("bundle.json", "room.zroom")
            verifyRecord(manifest.getJSONObject("app"), "room.zroom", stage, 50L * 1024 * 1024)
            if (contents == "app-and-data") {
                expected.add("data.roomdb")
                verifyRecord(manifest.getJSONObject("data"), "data.roomdb", stage, maxEntry)
                validateDatabase(File(stage, "data.roomdb"))
            } else require(manifest.isNull("data")) { "纯程序包包含数据清单" }
            if (version == "0.3") {
                val assets = manifest.getJSONArray("assets")
                require(assets.length() <= 19_997) { "房间附件数量过多" }
                for (i in 0 until assets.length()) {
                    val record = assets.getJSONObject(i)
                    val path = record.getString("path")
                    require(contents == "app-and-data" && assetPathAllowed(path)) { "房间附件路径无效" }
                    require(expected.add(path)) { "房间附件路径重复" }
                    verifyRecord(record, path, stage, maxEntry, allowEmpty = true)
                }
                validateAssets(stage, expected)
            } else require(!manifest.has("assets")) { "旧版传输包包含附件清单" }
            val actual = stage.walkTopDown().filter { it.isFile }.map { it.relativeTo(stage).invariantSeparatorsPath }.toSet()
            require(actual == expected) { "房间传输包包含未登记文件或缺失文件" }
            return block(manifest, stage)
        } finally { stage.deleteRecursively() }
    }

    private fun checkIdentity(manifest: JSONObject, report: RoomCompatibilityReport) {
        val room = manifest.getJSONObject("room")
        require(room.getString("id") == report.id && room.getString("name") == report.name &&
            room.getString("version") == report.version) { "房间传输清单与程序身份不匹配" }
    }

    private fun verifyRecord(record: JSONObject, path: String, stage: File, limit: Long, allowEmpty: Boolean = false) {
        require(record.getString("path") == path) { "房间文件清单路径不匹配" }
        val bytes = record.getLong("bytes")
        require(bytes >= (if (allowEmpty) 0 else 1) && bytes <= limit) { "房间文件大小无效：$path" }
        val sha = record.getString("sha256")
        require(shaPattern.matches(sha)) { "房间文件哈希无效：$path" }
        val file = File(stage, path)
        require(file.isFile && file.length() == bytes && digest(file) == sha) { "房间文件完整性校验失败：$path" }
    }

    private fun validateDatabase(file: File) {
        val db = SQLiteDatabase.openDatabase(file.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
        try {
            db.rawQuery("PRAGMA integrity_check", null).use { cursor ->
                require(cursor.moveToFirst() && cursor.getString(0) == "ok") { "房间数据库完整性校验失败" }
            }
        } finally { db.close() }
    }

    private fun validateAssets(stage: File, paths: Set<String>) {
        if (paths.any { it.startsWith("data/blobs/") }) {
            require("data/blobs/index.json" in paths) { "房间 Blob 索引缺失" }
            val index = JSONObject(File(stage, "data/blobs/index.json").readText(Charsets.UTF_8))
            require(index.getInt("formatVersion") == 1) { "房间 Blob 索引版本无效" }
            val items = index.getJSONArray("items")
            val listed = mutableSetOf("data/blobs/index.json")
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                val id = item.getString("id")
                require(Regex("[a-f0-9]{32}").matches(id)) { "房间 Blob ID 无效" }
                val path = "data/blobs/$id.bin"
                require(listed.add(path) && path in paths && File(stage, path).length() == item.getLong("size")) { "房间 Blob 索引与文件不匹配" }
            }
            require(listed == paths.filter { it.startsWith("data/blobs/") }.toSet()) { "房间 Blob 文件未登记" }
        }
        if ("data/jobs.json" in paths) {
            val jobs = JSONObject(File(stage, "data/jobs.json").readText(Charsets.UTF_8))
            require(jobs.getInt("formatVersion") == 1 && jobs.getJSONArray("jobs") != null) { "房间任务检查点无效" }
        }
    }

    private fun assetPathAllowed(path: String): Boolean = path == "data/jobs.json" ||
        path == "data/blobs/index.json" || blobPath.matches(path) ||
        (path.length <= 1200 && path.startsWith("data/files/") && path.removePrefix("data/files/").split('/').all {
            it.isNotEmpty() && it != "." && it != ".." && !it.contains(Regex("[\\\\:\\u0000-\\u001f]"))
        })

    private fun validatePath(path: String) {
        require(path.isNotEmpty() && !path.startsWith('/') && !path.contains('\\') && path.length <= 1200) { "房间路径无效" }
        require(path.split('/').all { it.isNotEmpty() && it != "." && it != ".." && !it.endsWith('.') && !it.endsWith(' ') &&
            !it.contains(Regex("[<>:\"|?*\\u0000-\\u001f]")) }) { "房间路径无效" }
    }

    private fun digest(file: File): String {
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val bytes = ByteArray(64 * 1024)
            while (true) { val count = input.read(bytes); if (count < 0) break; hash.update(bytes, 0, count) }
        }
        return hash.digest().joinToString("") { "%02x".format(it) }
    }

    private fun FileInput(path: String) = File(path).inputStream()
}
