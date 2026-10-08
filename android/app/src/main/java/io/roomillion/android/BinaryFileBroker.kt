package io.roomillion.android

import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.util.UUID

data class BinaryHandle(val token: String, val name: String, val size: Long, val type: String) {
    fun publicInfo(): org.json.JSONObject = org.json.JSONObject().put("token", token).put("name", name)
        .put("size", size).put("type", type).put("maxChunkBytes", BinaryFileBroker.CHUNK_BYTES)
}

data class BinaryExport(val token: String, val name: String, val file: File, var size: Long = 0)

/** Session-scoped copy of a user-selected document. Only opaque tokens cross into a room. */
class BinaryFileBroker(private val root: File) {
    companion object {
        const val MAX_FILE_BYTES = 64L * 1024 * 1024
        const val PICK_BYTES = 32L * 1024 * 1024
        const val CHUNK_BYTES = 256 * 1024

        fun limitLabel(bytes: Long): String = if (bytes % (1024 * 1024) == 0L) "${bytes / 1024 / 1024} MiB" else "$bytes 字节"
    }

    private val handles = mutableMapOf<String, BinaryHandle>()
    private val exports = mutableMapOf<String, BinaryExport>()

    init { require(root.mkdirs() || root.isDirectory) }

    @Synchronized
    fun import(input: InputStream, name: String, type: String, maxBytes: Long = MAX_FILE_BYTES): BinaryHandle {
        require(maxBytes in 1..MAX_FILE_BYTES) { "文件大小上限无效" }
        val safeName = name.take(200).ifBlank { "已选文件" }
        val token = UUID.randomUUID().toString()
        val destination = File(root, token)
        var size = 0L
        try {
            destination.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    size += count
                    require(size <= maxBytes) { "选择的文件超过 ${limitLabel(maxBytes)}；请使用较小文件" }
                    output.write(buffer, 0, count)
                }
            }
            val handle = BinaryHandle(token, safeName, size, type.take(100).ifBlank { "application/octet-stream" })
            handles[token] = handle
            return handle
        } catch (error: Exception) {
            destination.delete()
            throw error
        }
    }

    @Synchronized
    fun read(token: String, offset: Long, length: Int): Pair<ByteArray, Boolean> {
        val handle = handles[token] ?: error("文件令牌无效或已过期")
        require(offset in 0..handle.size && length in 1..CHUNK_BYTES) { "读取范围无效" }
        val file = File(root, token)
        require(file.isFile && file.length() == handle.size) { "已选文件内容发生变化" }
        val count = minOf(length.toLong(), handle.size - offset).toInt()
        val data = ByteArray(count)
        RandomAccessFile(file, "r").use { stream ->
            stream.seek(offset)
            stream.readFully(data)
        }
        return data to (offset + count == handle.size)
    }

    @Synchronized
    fun close(token: String): Boolean {
        handles.remove(token) ?: return false
        File(root, token).delete()
        return true
    }

    @Synchronized
    fun beginExport(name: String): BinaryExport {
        require(name.isNotBlank() && name.length <= 200 && !name.contains('/') && !name.contains('\\')) { "导出文件名无效" }
        val token = UUID.randomUUID().toString()
        val file = File(root, "$token.export")
        require(file.createNewFile()) { "无法建立导出暂存文件" }
        return BinaryExport(token, name, file).also { exports[token] = it }
    }

    @Synchronized
    fun writeExport(token: String, bytes: ByteArray): Long {
        val item = exports[token] ?: error("导出令牌无效或已过期")
        require(bytes.size in 1..CHUNK_BYTES) { "导出分块大小无效" }
        require(item.size + bytes.size <= MAX_FILE_BYTES) { "导出文件超过 64 MiB" }
        item.file.appendBytes(bytes)
        item.size += bytes.size
        return item.size
    }

    @Synchronized
    fun export(token: String): BinaryExport = exports[token] ?: error("导出令牌无效或已过期")

    @Synchronized
    fun abortExport(token: String): Boolean {
        val item = exports.remove(token) ?: return false
        item.file.delete()
        return true
    }

    @Synchronized
    fun clear() {
        handles.clear()
        exports.clear()
        root.deleteRecursively()
    }
}
