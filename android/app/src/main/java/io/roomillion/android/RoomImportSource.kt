package io.roomillion.android

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File

/** Freeze the user-granted document so preview and install always use identical bytes. */
internal object RoomImportSource {
    private const val MAX_BYTES = 256L * 1024 * 1024

    fun snapshot(context: Context, uri: Uri, requireRoomName: Boolean): File {
        require(uri.scheme == "content" && !uri.authority.isNullOrBlank()) { "请通过文件管理器打开 .room 文件" }
        if (requireRoomName) {
            val displayName = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor -> if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null }
            val name = displayName ?: uri.lastPathSegment
            val customType = context.contentResolver.getType(uri) in setOf("application/vnd.roomillion.room", "application/x-roomillion-room")
            require(name?.endsWith(".room", ignoreCase = true) == true || (displayName == null && customType)) { "请选择 .room 房间包" }
        }
        val file = File.createTempFile("room-import-", ".room", context.cacheDir)
        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var count = 0L
                    while (true) {
                        val length = input.read(buffer)
                        if (length < 0) break
                        if (Thread.currentThread().isInterrupted) throw InterruptedException()
                        count += length
                        require(count <= MAX_BYTES) { "房间包超过安卓导入上限（256 MiB）" }
                        output.write(buffer, 0, length)
                    }
                }
            } ?: error("无法读取选择的房间包")
            return file
        } catch (error: Exception) {
            file.delete()
            throw error
        }
    }
}
