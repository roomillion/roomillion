package io.roomillion.android

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

data class RoomGrants(val pick: Boolean = false, val export: Boolean = false, val ai: Boolean = false,
    val host: Boolean = false, val join: Boolean = false)

/** User grants are bound to the installed program's exact manifest bytes. */
class RoomPermissionStore(context: Context) {
    private val preferences = context.getSharedPreferences("room-permissions", Context.MODE_PRIVATE)

    fun requested(room: InstalledRoom): RoomGrants {
        val permissions = room.manifest.optJSONObject("permissions") ?: return RoomGrants()
        val files = permissions.optJSONArray("files")
        val names = files?.let { array -> (0 until array.length()).map(array::optString).toSet() }.orEmpty()
        val multiplayer = permissions.optJSONArray("multiplayer")?.let { (0 until it.length()).map(it::optString).toSet() }.orEmpty()
        return RoomGrants("pick" in names, "export" in names, permissions.optJSONObject("ai") != null, "host" in multiplayer, "join" in multiplayer)
    }

    fun read(room: InstalledRoom): RoomGrants? {
        val raw = preferences.getString(room.id, null) ?: return null
        return runCatching {
            val value = JSONObject(raw)
            if (value.getString("manifestSha256") != manifestHash(room)) return null
            val available = requested(room)
            RoomGrants(value.optBoolean("pick") && available.pick,
                value.optBoolean("export") && available.export,
                value.optBoolean("ai") && available.ai,
                value.optBoolean("host") && available.host, value.optBoolean("join") && available.join)
        }.getOrNull()
    }

    fun save(room: InstalledRoom, grants: RoomGrants) {
        val available = requested(room)
        require((!grants.pick || available.pick) && (!grants.export || available.export) && (!grants.ai || available.ai) &&
            (!grants.host || available.host) && (!grants.join || available.join)) {
            "房间不能申请未声明的能力"
        }
        val record = JSONObject().put("manifestSha256", manifestHash(room))
            .put("pick", grants.pick).put("export", grants.export).put("ai", grants.ai).put("host", grants.host).put("join", grants.join)
        check(preferences.edit().putString(room.id, record.toString()).commit()) { "房间授权保存失败" }
    }

    fun revoke(room: InstalledRoom) {
        check(preferences.edit().remove(room.id).commit()) { "房间授权清除失败" }
    }

    private fun manifestHash(room: InstalledRoom): String {
        val file = File(room.program, "manifest.json")
        require(file.isFile && file.length() <= 1_000_000) { "房间清单不可用" }
        val hash = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
        return hash.joinToString("") { "%02x".format(it) }
    }
}
