package io.roomillion.android

import android.util.Base64
import org.json.JSONObject

/** Converts a room-scoped staged file into a bounded chat-completions media part. */
object AiMediaCodec {
    const val MAX_REQUEST_BYTES = 16 * 1024 * 1024
    const val MAX_ITEMS = 8

    fun resolve(kind: String, staged: BinaryExport, declaredMime: String?): JSONObject {
        require(staged.size in 1..MAX_REQUEST_BYTES.toLong() && staged.file.isFile && staged.file.length() == staged.size) {
            "AI 媒体文件无效或超过 16 MiB"
        }
        val bytes = staged.file.readBytes()
        val detected = when (kind) {
            "image" -> imageMime(bytes)
            "audio" -> audioMime(bytes)
            else -> null
        } ?: throw IllegalArgumentException("AI 图片或音频格式无效")
        require(declaredMime.isNullOrBlank() || declaredMime == detected ||
            (detected == "audio/mp4" && declaredMime == "audio/x-m4a")) { "AI 媒体声明格式与文件内容不符" }
        return JSONObject().put("mimeType", detected)
            .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    private fun imageMime(bytes: ByteArray): String? = when {
        bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) -> "image/png"
        bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte() -> "image/jpeg"
        bytes.size >= 12 && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WEBP" -> "image/webp"
        bytes.size >= 6 && ascii(bytes, 0, 6) in setOf("GIF87a", "GIF89a") -> "image/gif"
        else -> null
    }

    private fun audioMime(bytes: ByteArray): String? = when {
        bytes.size < 12 -> null
        ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WAVE" -> "audio/wav"
        ascii(bytes, 0, 4) == "OggS" -> "audio/ogg"
        ascii(bytes, 0, 4) == "fLaC" -> "audio/flac"
        ascii(bytes, 4, 4) == "ftyp" -> "audio/mp4"
        bytes[0] == 0x1a.toByte() && bytes[1] == 0x45.toByte() && bytes[2] == 0xdf.toByte() && bytes[3] == 0xa3.toByte() -> "audio/webm"
        ascii(bytes, 0, 3) == "ID3" -> "audio/mpeg"
        bytes[0] == 0xff.toByte() && (bytes[1].toInt() and 0xe0) == 0xe0 &&
            ((bytes[1].toInt() shr 3) and 0x03) != 0x01 -> "audio/mpeg"
        else -> null
    }

    private fun ascii(bytes: ByteArray, start: Int, count: Int): String =
        String(bytes, start, count, Charsets.US_ASCII)
}
