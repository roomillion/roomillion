package io.roomillion.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID

/** Room-private attachments using the same index and binary filenames as the desktop workbench. */
class RoomBlobStore(private val data: File) {
    companion object {
        const val CHUNK_BYTES = 256 * 1024
        const val MAX_BLOB_BYTES = 64L * 1024 * 1024
        private const val MAX_STAGED_BYTES = 128L * 1024 * 1024
        private val ID = Regex("[a-f0-9]{32}")
    }

    private data class Writer(val token: String, val id: String, val name: String, val mimeType: String,
                              val kind: String, val metadata: JSONObject, val file: File,
                              val output: FileOutputStream, val createdAt: Long, var size: Long = 0)

    private val root = File(data, "blobs")
    private val staging = File(data, ".blob-staging-${UUID.randomUUID()}")
    private val writers = mutableMapOf<String, Writer>()

    init {
        require(data.mkdirs() || data.isDirectory)
        require(root.mkdirs() || root.isDirectory)
        require(staging.mkdirs() || staging.isDirectory)
        data.listFiles()?.filter { it != staging && it.name.startsWith(".blob-staging-") &&
            System.currentTimeMillis() - it.lastModified() > 24L * 60 * 60 * 1000 }?.forEach { it.deleteRecursively() }
    }

    private fun blobFile(id: String): File {
        require(ID.matches(id)) { "Blob ID 无效" }
        return File(root, "$id.bin")
    }

    private fun load(): MutableList<JSONObject> {
        val index = File(root, "index.json")
        if (!index.isFile) return mutableListOf()
        require(index.length() in 1..4_000_000) { "Blob 索引无效或过大" }
        val value = JSONObject(index.readText(Charsets.UTF_8))
        require(value.getInt("formatVersion") == 1) { "Blob 索引版本无效" }
        val items = value.getJSONArray("items")
        require(items.length() <= 20_000) { "Blob 数量过多" }
        return (0 until items.length()).map { items.getJSONObject(it) }.toMutableList()
    }

    private fun save(items: List<JSONObject>) {
        val array = JSONArray()
        items.forEach(array::put)
        val temporary = File(staging, "index-${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(JSONObject().put("formatVersion", 1).put("items", array).toString().toByteArray(Charsets.UTF_8))
                stream.fd.sync()
            }
            require(temporary.renameTo(File(root, "index.json"))) { "Blob 索引保存失败" }
        } finally { temporary.delete() }
    }

    private fun publicItem(item: JSONObject): JSONObject = JSONObject()
        .put("id", item.getString("id")).put("name", item.getString("name"))
        .put("mimeType", item.getString("mimeType")).put("kind", item.getString("kind"))
        .put("size", item.getLong("size")).put("createdAt", item.getLong("createdAt"))
        .put("updatedAt", item.getLong("updatedAt"))
        .put("metadata", item.optJSONObject("metadata") ?: JSONObject())

    fun list(options: JSONObject = JSONObject()): JSONArray {
        val kind = options.optString("kind").takeIf { it.isNotEmpty() }
        val output = JSONArray()
        load().filter { kind == null || it.optString("kind") == kind }
            .sortedByDescending { it.getLong("updatedAt") }.forEach { output.put(publicItem(it)) }
        return output
    }

    fun begin(options: JSONObject = JSONObject()): JSONObject {
        require(writers.size < 8) { "同时写入的 Blob 过多" }
        val id = UUID.randomUUID().toString().replace("-", "")
        val token = UUID.randomUUID().toString()
        val name = (options.optString("name").ifBlank { "artifact.bin" }).replace(Regex("[\\/\\\\\\u0000-\\u001f]"), "_").take(240)
        val mimeType = options.optString("mimeType", "application/octet-stream").take(160).ifBlank { "application/octet-stream" }
        val kind = options.optString("kind").takeIf { it in setOf("blob", "artifact") } ?: "blob"
        val metadata = options.optJSONObject("metadata")?.let { JSONObject(it.toString()) } ?: JSONObject()
        require(metadata.toString().length <= 32_000) { "Blob 元数据过大" }
        val file = File(staging, "$id.$token.tmp")
        require(file.createNewFile()) { "无法建立 Blob 暂存文件" }
        try {
            val writer = Writer(token, id, name, mimeType, kind, metadata, file, FileOutputStream(file), System.currentTimeMillis())
            writers[token] = writer
            return JSONObject().put("token", token).put("id", id).put("name", name)
                .put("mimeType", mimeType).put("kind", kind).put("size", 0)
        } catch (error: Exception) { file.delete(); throw error }
    }

    fun write(token: String, bytes: ByteArray): JSONObject {
        val writer = writers[token] ?: error("Blob 写入任务不存在或已关闭")
        require(bytes.size <= CHUNK_BYTES) { "Blob 写入分块超过 256 KiB" }
        require(writer.size + bytes.size <= MAX_BLOB_BYTES &&
            writers.values.sumOf { it.size } + bytes.size <= MAX_STAGED_BYTES) { "Blob 暂存空间已达到上限" }
        if (bytes.isNotEmpty()) writer.output.write(bytes)
        writer.size += bytes.size
        return JSONObject().put("id", writer.id).put("bytes", writer.size)
    }

    fun finish(token: String): JSONObject {
        val writer = writers.remove(token) ?: error("Blob 写入任务不存在或已关闭")
        try {
            writer.output.fd.sync()
            writer.output.close()
            val target = blobFile(writer.id)
            require(writer.file.renameTo(target)) { "Blob 文件保存失败" }
            try {
                val now = System.currentTimeMillis()
                val record = JSONObject().put("id", writer.id).put("name", writer.name)
                    .put("mimeType", writer.mimeType).put("kind", writer.kind)
                    .put("metadata", writer.metadata).put("size", writer.size)
                    .put("createdAt", writer.createdAt).put("updatedAt", now)
                val items = load()
                items.add(record)
                save(items)
                return publicItem(record)
            } catch (error: Exception) { target.delete(); throw error }
        } finally {
            runCatching { writer.output.close() }
            writer.file.delete()
        }
    }

    fun abort(token: String): Boolean {
        val writer = writers.remove(token) ?: return false
        runCatching { writer.output.close() }
        writer.file.delete()
        return true
    }

    fun read(id: String, options: JSONObject = JSONObject()): JSONObject {
        val item = load().firstOrNull { it.getString("id") == id } ?: error("Blob 不存在")
        val size = item.getLong("size")
        val offset = options.optLong("offset", 0)
        val length = options.optInt("length", minOf(CHUNK_BYTES.toLong(), size - offset).toInt())
        require(offset in 0..size && length in 0..CHUNK_BYTES) { "Blob 读取范围无效" }
        val file = blobFile(id)
        require(file.isFile && file.length() == size) { "Blob 文件与索引不匹配" }
        val count = minOf(length.toLong(), size - offset).toInt()
        val bytes = ByteArray(count)
        RandomAccessFile(file, "r").use { stream -> stream.seek(offset); stream.readFully(bytes) }
        return JSONObject().put("item", publicItem(item))
            .put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
            .put("offset", offset).put("nextOffset", offset + count).put("eof", offset + count >= size)
    }

    fun getFile(id: String): Pair<JSONObject, File> {
        val item = load().firstOrNull { it.getString("id") == id } ?: error("Blob 不存在")
        val file = blobFile(id)
        require(file.isFile && file.length() == item.getLong("size")) { "Blob 文件与索引不匹配" }
        return publicItem(item) to file
    }

    fun remove(id: String): Boolean {
        val items = load()
        val index = items.indexOfFirst { it.getString("id") == id }
        if (index < 0) return false
        val file = blobFile(id)
        val rollback = File(staging, "$id.removed")
        require(file.renameTo(rollback)) { "无法移除 Blob 文件" }
        try {
            items.removeAt(index)
            save(items)
            rollback.delete()
            return true
        } catch (error: Exception) {
            require(rollback.renameTo(file)) { "恢复 Blob 文件失败" }
            throw error
        }
    }

    fun close() {
        writers.keys.toList().forEach(::abort)
        staging.deleteRecursively()
    }
}
