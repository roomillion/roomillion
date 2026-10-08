package io.roomillion.android

import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Produces the same plain .room structures consumed by the desktop workbench. */
class RoomTransferExporter(private val roomsRoot: File, private val temporaryRoot: File) {
    fun create(room: InstalledRoom, includeData: Boolean, password: String? = null): File {
        require(password.isNullOrEmpty() || password.length in 8..128) { "密码长度应为 8 至 128 个字符" }
        val stage = File(temporaryRoot, "room-export-${UUID.randomUUID()}")
        require(stage.mkdir()) { "无法建立导出临时目录" }
        val output = File(temporaryRoot, "room-export-${UUID.randomUUID()}.room")
        var protectedOutput: File? = null
        try {
            val program = File(stage, "room.zroom")
            zipFiles(room.program, filesIn(room.program), program, 50L * 1024 * 1024)
            val inspected = program.inputStream().use { RoomPackageStore(roomsRoot).inspect(it) }
            require(inspected.canInstall && inspected.id == room.id) { "房间程序发生变化，无法导出" }
            if (!includeData && password.isNullOrEmpty()) {
                require(program.renameTo(output)) { "无法暂存房间程序包" }
                return output
            }
            val createdAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(Date())
            if (!includeData) {
                val manifest = JSONObject().put("kind", "zhibian-room-transfer").put("formatVersion", "0.3")
                    .put("contents", "app-only")
                    .put("room", JSONObject().put("id", room.id).put("name", room.name).put("version", room.version))
                    .put("createdAt", createdAt).put("app", record("room.zroom", program))
                    .put("data", JSONObject.NULL).put("assets", JSONArray())
                ZipOutputStream(output.outputStream().buffered()).use { zip ->
                    add(zip, "bundle.json", manifest.toString().toByteArray(Charsets.UTF_8))
                    add(zip, "room.zroom", program)
                }
                protectedOutput = File(temporaryRoot, "room-export-${UUID.randomUUID()}.room")
                EncryptedRoomTransfer.protect(output, password!!, protectedOutput)
                require(protectedOutput.inputStream().use { RoomTransferStore(roomsRoot).inspect(it, password) }.canInstall)
                output.delete()
                return protectedOutput
            }

            val database = File(stage, "data.roomdb")
            val active = File(room.data, "room.db")
            if (active.isFile) {
                require(!Files.isSymbolicLink(active.toPath())) { "房间数据库不是普通文件" }
                val probe = SQLiteDatabase.openDatabase(active.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
                probe.use { db -> db.rawQuery("PRAGMA integrity_check", null).use { rows ->
                    require(rows.moveToFirst() && rows.getString(0) == "ok") { "房间数据库损坏，不能导出" }
                } }
                active.copyTo(database)
            } else {
                SQLiteDatabase.openOrCreateDatabase(database, null).use { it.execSQL(
                    "CREATE TABLE IF NOT EXISTS __room_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)") }
            }
            require(database.length() in 1..192L * 1024 * 1024) { "房间数据库超过安卓导出上限" }
            val assetFiles = mutableListOf<File>()
            for (name in listOf("jobs.json", "blobs", "files")) {
                val source = File(room.data, name)
                if (source.exists()) require(!Files.isSymbolicLink(source.toPath())) { "房间附件目录包含链接" }
                if (source.isFile) assetFiles.add(source)
                else if (source.isDirectory) assetFiles.addAll(filesIn(source))
            }
            require(assetFiles.size <= 19_997 && assetFiles.all { it.length() <= 192L * 1024 * 1024 } &&
                assetFiles.sumOf(File::length) + database.length() + program.length() <= 384L * 1024 * 1024) {
                "房间数据超过安卓导出上限"
            }
            val assets = JSONArray()
            for (asset in assetFiles.sortedBy { it.relativeTo(room.data).invariantSeparatorsPath }) {
                require(!Files.isSymbolicLink(asset.toPath())) { "房间附件包含链接" }
                val relative = "data/${asset.relativeTo(room.data).invariantSeparatorsPath}"
                require(relative == "data/jobs.json" || relative == "data/blobs/index.json" ||
                    Regex("data/blobs/[a-f0-9]{32}\\.bin").matches(relative) ||
                    relative.startsWith("data/files/") && relative.removePrefix("data/files/").split('/').all {
                        it.isNotEmpty() && it != "." && it != ".." && !it.contains(Regex("[\\\\:\\u0000-\\u001f]"))
                    }) { "房间附件路径不能安全导出：$relative" }
                assets.put(record(relative, asset))
            }
            val bundle = JSONObject().put("kind", "zhibian-room-transfer").put("formatVersion", "0.3")
                .put("contents", "app-and-data")
                .put("room", JSONObject().put("id", room.id).put("name", room.name).put("version", room.version))
                .put("createdAt", createdAt).put("app", record("room.zroom", program))
                .put("data", record("data.roomdb", database)).put("assets", assets)
            ZipOutputStream(output.outputStream().buffered()).use { zip ->
                add(zip, "bundle.json", bundle.toString().toByteArray(Charsets.UTF_8))
                add(zip, "room.zroom", program)
                add(zip, "data.roomdb", database)
                for (asset in assetFiles) add(zip, "data/${asset.relativeTo(room.data).invariantSeparatorsPath}", asset)
            }
            require(output.length() <= 256L * 1024 * 1024) { "房间传输包超过安卓导出上限" }
            val checked = output.inputStream().use { RoomTransferStore(roomsRoot).inspect(it) }
            require(checked.canInstall && checked.compatibility.id == room.id) { "房间传输包复核失败" }
            if (!password.isNullOrEmpty()) {
                protectedOutput = File(temporaryRoot, "room-export-${UUID.randomUUID()}.room")
                EncryptedRoomTransfer.protect(output, password, protectedOutput)
                require(protectedOutput.inputStream().use { RoomTransferStore(roomsRoot).inspect(it, password) }.canInstall)
                output.delete()
                return protectedOutput
            }
            return output
        } catch (error: Exception) {
            output.delete()
            protectedOutput?.delete()
            throw error
        } finally { stage.deleteRecursively() }
    }

    private fun filesIn(root: File): List<File> = root.walkTopDown().onEnter { dir ->
        require(!Files.isSymbolicLink(dir.toPath())) { "房间目录包含链接" }
        true
    }.filter { it.isFile }.toList().also { files ->
        require(files.size <= 20_000) { "房间文件过多" }
        for (file in files) {
            require(!Files.isSymbolicLink(file.toPath()) && file.canonicalPath.startsWith(root.canonicalPath + File.separator)) {
                "房间文件包含链接或路径越界"
            }
        }
    }.sortedBy { it.relativeTo(root).invariantSeparatorsPath }

    private fun zipFiles(root: File, files: List<File>, destination: File, limit: Long) {
        require(files.sumOf(File::length) <= 200L * 1024 * 1024) { "房间程序解包内容超过安卓导出上限" }
        ZipOutputStream(destination.outputStream().buffered()).use { zip ->
            for (file in files) add(zip, file.relativeTo(root).invariantSeparatorsPath, file)
        }
        require(destination.length() <= limit) { "房间程序包超过安卓导出上限" }
    }

    private fun add(zip: ZipOutputStream, name: String, file: File) {
        zip.putNextEntry(ZipEntry(name))
        file.inputStream().use { it.copyTo(zip) }
        zip.closeEntry()
    }

    private fun add(zip: ZipOutputStream, name: String, bytes: ByteArray) {
        zip.putNextEntry(ZipEntry(name))
        zip.write(bytes)
        zip.closeEntry()
    }

    private fun record(path: String, file: File): JSONObject {
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val bytes = ByteArray(64 * 1024)
            while (true) { val count = input.read(bytes); if (count < 0) break; hash.update(bytes, 0, count) }
        }
        return JSONObject().put("path", path).put("bytes", file.length())
            .put("sha256", hash.digest().joinToString("") { "%02x".format(it) })
    }
}
