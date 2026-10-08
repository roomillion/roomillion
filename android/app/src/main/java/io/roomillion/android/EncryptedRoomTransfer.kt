package io.roomillion.android

import org.bouncycastle.crypto.generators.SCrypt
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.Base64
import java.security.SecureRandom
import java.util.zip.ZipFile
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class TransferPasswordRequired : IllegalArgumentException("此房间包有密码，请输入导出时设置的密码")

/** Interoperates with the desktop scrypt + AES-256-GCM transfer envelope. */
internal object EncryptedRoomTransfer {
    private const val MAX_ENCRYPTED_FILE = 64L * 1024 * 1024

    fun unlock(file: File, password: String?, output: File): JSONObject {
        require(file.length() in 1..MAX_ENCRYPTED_FILE) { "加密房间包超过安卓解锁上限（64 MiB）" }
        val envelope = JSONObject(file.readText(Charsets.UTF_8))
        require(envelope.getString("kind") == "zhibian-room-transfer-encrypted") { "加密房间包格式无效" }
        require(envelope.getString("formatVersion") in setOf("0.2", "0.3")) { "加密房间包版本不受支持" }
        require(envelope.getString("contents") in setOf("app-only", "app-and-data")) { "加密房间包内容无效" }
        require(Instant.parse(envelope.getString("createdAt")) != null) { "加密房间包创建时间无效" }
        val room = envelope.getJSONObject("room")
        require(Regex("[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?").matches(room.getString("id"))) { "房间 ID 无效" }
        require(room.getString("name").length in 1..80 && room.getString("version").length in 1..80) { "房间信息无效" }
        val encryption = envelope.getJSONObject("encryption")
        require(encryption.getString("kdf") == "scrypt" && encryption.getString("cipher") == "aes-256-gcm" &&
            encryption.getInt("N") == 16384 && encryption.getInt("r") == 8 && encryption.getInt("p") == 1) { "加密房间包参数不受支持" }
        val decoder = Base64.getDecoder()
        val salt = decoder.decode(encryption.getString("salt"))
        val iv = decoder.decode(encryption.getString("iv"))
        val tag = decoder.decode(encryption.getString("tag"))
        require(salt.size == 16 && iv.size == 12 && tag.size == 16) { "加密房间包参数长度无效" }
        if (password.isNullOrEmpty()) throw TransferPasswordRequired()
        require(password.length in 8..128) { "密码长度应为 8 至 128 个字符" }
        val payload = decoder.decode(envelope.getString("payload"))
        require(payload.isNotEmpty() && payload.size <= MAX_ENCRYPTED_FILE) { "加密房间包载荷无效" }

        val aad = aad(envelope)
        val key = SCrypt.generate(password.toByteArray(Charsets.UTF_8), salt, 16384, 8, 1, 32)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            val cleartext = try { cipher.doFinal(payload + tag) }
                catch (_: javax.crypto.AEADBadTagException) { error("房间包密码错误或文件已损坏") }
            require(cleartext.size >= 4 && cleartext[0] == 0x50.toByte() && cleartext[1] == 0x4b.toByte()) { "加密房间包内部不是 ZIP 容器" }
            output.outputStream().use { it.write(cleartext) }
        } finally { key.fill(0) }
        return envelope
    }

    fun protect(archive: File, password: String, output: File) {
        require(password.length in 8..128) { "密码长度应为 8 至 128 个字符" }
        require(archive.length() in 1..45L * 1024 * 1024) { "密码保护导出限 45 MiB" }
        val manifest = ZipFile(archive).use { zip ->
            val entry = zip.getEntry("bundle.json") ?: error("受保护房间包缺少传输清单")
            require(entry.size in 1..1_000_000) { "传输清单无效" }
            zip.getInputStream(entry).use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
        }
        val salt = ByteArray(16).also(SecureRandom()::nextBytes)
        val iv = ByteArray(12).also(SecureRandom()::nextBytes)
        val encoder = Base64.getEncoder()
        val envelope = JSONObject().put("kind", "zhibian-room-transfer-encrypted")
            .put("formatVersion", manifest.getString("formatVersion"))
            .put("contents", manifest.getString("contents"))
            .put("room", manifest.getJSONObject("room"))
            .put("createdAt", manifest.getString("createdAt"))
            .put("encryption", JSONObject().put("kdf", "scrypt").put("cipher", "aes-256-gcm")
                .put("N", 16384).put("r", 8).put("p", 1)
                .put("salt", encoder.encodeToString(salt)).put("iv", encoder.encodeToString(iv)))
        val key = SCrypt.generate(password.toByteArray(Charsets.UTF_8), salt, 16384, 8, 1, 32)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD(aad(envelope))
            val sealed = cipher.doFinal(archive.readBytes())
            val tag = sealed.copyOfRange(sealed.size - 16, sealed.size)
            envelope.getJSONObject("encryption").put("tag", encoder.encodeToString(tag))
            envelope.put("payload", encoder.encodeToString(sealed.copyOfRange(0, sealed.size - 16)))
            output.writeText(envelope.toString(), Charsets.UTF_8)
            require(output.length() <= MAX_ENCRYPTED_FILE) { "加密房间包超过安卓导出上限" }
        } finally { key.fill(0) }
    }

    private fun aad(envelope: JSONObject): ByteArray {
        val room = envelope.getJSONObject("room")
        val encryption = envelope.getJSONObject("encryption")
        return buildString {
            append("{\"kind\":").append(jsonQuote(envelope.getString("kind")))
            append(",\"formatVersion\":").append(jsonQuote(envelope.getString("formatVersion")))
            append(",\"contents\":").append(jsonQuote(envelope.getString("contents")))
            append(",\"room\":{\"id\":").append(jsonQuote(room.getString("id")))
            append(",\"name\":").append(jsonQuote(room.getString("name")))
            append(",\"version\":").append(jsonQuote(room.getString("version"))).append('}')
            append(",\"createdAt\":").append(jsonQuote(envelope.getString("createdAt")))
            append(",\"encryption\":{\"kdf\":\"scrypt\",\"cipher\":\"aes-256-gcm\",\"N\":16384,\"r\":8,\"p\":1,\"salt\":")
            append(jsonQuote(encryption.getString("salt")))
            append(",\"iv\":").append(jsonQuote(encryption.getString("iv"))).append("}}")
        }.toByteArray(Charsets.UTF_8)
    }

    fun matches(envelope: JSONObject, bundle: JSONObject): Boolean {
        val outer = envelope.getJSONObject("room")
        val inner = bundle.getJSONObject("room")
        return envelope.getString("formatVersion") == bundle.getString("formatVersion") &&
            envelope.getString("contents") == bundle.getString("contents") &&
            envelope.getString("createdAt") == bundle.getString("createdAt") &&
            listOf("id", "name", "version").all { outer.getString(it) == inner.getString(it) }
    }

    /** JSON.stringify-compatible string encoding for authenticated desktop metadata. */
    private fun jsonQuote(value: String): String = buildString {
        append('"')
        var i = 0
        while (i < value.length) {
            val char = value[i]
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> {
                    if (char.code < 0x20 || Character.isLowSurrogate(char) ||
                        Character.isHighSurrogate(char) && (i + 1 >= value.length || !Character.isLowSurrogate(value[i + 1]))) {
                        append("\\u").append(char.code.toString(16).padStart(4, '0'))
                    } else if (Character.isHighSurrogate(char)) {
                        append(char).append(value[++i])
                    } else append(char)
                }
            }
            i++
        }
        append('"')
    }
}
