package io.roomillion.android

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/** A local-only AP supplies the LAN link. It does not expose hotspot credentials to room scripts. */
class RoomHotspot(context: Context) {
    private val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var starting = false
    private var generation = 0
    @Suppress("DEPRECATION")
    fun status(): JSONObject {
        val config = reservation?.softApConfiguration
        return JSONObject().put("active", config != null).put("starting", starting)
            .put("ssid", config?.ssid ?: JSONObject.NULL).put("password", config?.passphrase ?: JSONObject.NULL)
    }
    @Suppress("MissingPermission")
    fun start(success: (JSONObject) -> Unit, fail: (String) -> Unit) {
        if (reservation != null) { success(status()); return }
        if (starting) { fail("正在创建热点，请稍候"); return }
        starting = true
        val request = ++generation
        try {
            wifi.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(value: WifiManager.LocalOnlyHotspotReservation) {
                    if (request != generation) { value.close(); return }
                    reservation = value; starting = false; success(status())
                }
                override fun onStopped() { if (request == generation) { reservation = null; starting = false } }
                override fun onFailed(reason: Int) {
                    if (request != generation) return
                    starting = false
                    fail("无法自动开启热点（$reason）。可以在系统设置手动开启热点后继续开房")
                }
            }, Handler(Looper.getMainLooper()))
        } catch (error: Exception) { starting = false; fail(error.message ?: "无法创建热点") }
    }
    fun close() { generation++; starting = false; reservation?.close(); reservation = null }
}
