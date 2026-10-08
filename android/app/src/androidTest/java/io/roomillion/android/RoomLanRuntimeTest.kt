package io.roomillion.android

import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class RoomLanRuntimeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun find(view: View, predicate: (View) -> Boolean): View? {
        if (predicate(view)) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), predicate)?.let { return it }
        return null
    }
    private fun evaluate(view: WebView, code: String): String {
        val latch = CountDownLatch(1); var value = ""
        instrumentation.runOnMainSync { view.evaluateJavascript(code) { value = it; latch.countDown() } }
        assertTrue(latch.await(10, TimeUnit.SECONDS)); return value
    }
    private fun waitFor(view: WebView, code: String, expected: String): String {
        repeat(50) { val value = evaluate(view, code); if (value.contains(expected)) return value; Thread.sleep(100) }
        error("页面未达到预期：$expected，实际 ${evaluate(view, code)}")
    }
    @Test fun roomBridgeGatesHostThenOpensGameAndClosesConnectionsWithRoom() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val room = instrumentation.context.assets.open("lan-probe.room").use { store.install(it) }
        val permissions = RoomPermissionStore(target)
        assertTrue(permissions.requested(room).host && permissions.requested(room).join)
        permissions.save(room, RoomGrants(join = true))
        val activity = instrumentation.startActivitySync(Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
        var runtime: RoomRuntime? = null
        val client = RoomLanSession(target, room.id, room.version)
        try {
            instrumentation.runOnMainSync {
                (find(activity.window.decorView) { it is Button && it.text.toString().contains(room.name) } as Button).performClick()
            }
            var view = find(activity.window.decorView) { it is WebView } as WebView
            waitFor(view, "document.getElementById('status').textContent", "尚未")
            evaluate(view, "window.__denied='pending';room.multiplayer.create({}).then(()=>window.__denied='unexpected').catch(e=>window.__denied=e.message)")
            waitFor(view, "window.__denied", "权限")
            assertFalse(permissions.read(room)!!.host)
            assertTrue(runCatching { permissions.save(room, RoomGrants(pick = true)) }.isFailure)
            permissions.save(room, RoomGrants(host = true, join = true))
            instrumentation.runOnMainSync {
                (find(activity.window.decorView) { it is Button && it.text.toString() == "返回房间列表" } as Button).performClick()
                (find(activity.window.decorView) { it is Button && it.text.toString().contains(room.name) } as Button).performClick()
            }
            view = find(activity.window.decorView) { it is WebView } as WebView
            waitFor(view, "document.getElementById('status').textContent", "尚未")
            evaluate(view, "document.getElementById('create').click()")
            waitFor(view, "document.getElementById('status').textContent", "主机已开启")
            evaluate(view, "window.__second='pending';room.multiplayer.create({}).then(()=>window.__second='unexpected').catch(e=>window.__second=e.message)")
            waitFor(view, "window.__second", "请先离开")
            evaluate(view, "room.multiplayer.getStatus().then(s=>window.__state=s)")
            val state = JSONObject(waitFor(view, "window.__state", "invitations"))
            assertTrue(state.getBoolean("connected"))
            val invite = RoomLanSession.parseInvitation(state.getJSONArray("invitations").getJSONObject(0).getString("invitation"), room.id, room.version)
            val joined = client.join(JSONObject().put("invitation", RoomLanSession.encodeInvitation(invite.put("host", "127.0.0.1"))).put("name", "桥接玩家"))
            client.read(JSONObject().put("timeoutMs", 0))
            waitFor(view, "document.getElementById('log').textContent", "桥接玩家")
            client.send(JSONObject().put("note", "原生客户端到房间页面"), JSONObject())
            waitFor(view, "document.getElementById('log').textContent", "原生客户端到房间页面")
            evaluate(view, "document.getElementById('target').value=" + JSONObject.quote(joined.getString("peerId")) + ";document.getElementById('message').value='房间页面到原生客户端';document.getElementById('send').click()")
            val events = client.read(JSONObject()).getJSONArray("events")
            assertTrue((0 until events.length()).any { events.getJSONObject(it).optJSONObject("data")?.optString("note") == "房间页面到原生客户端" })
            val active = MainActivity::class.java.getDeclaredField("runtime").apply { isAccessible = true }.get(activity) as RoomRuntime
            runtime = active
            instrumentation.runOnMainSync { (find(activity.window.decorView) { it is Button && it.text.toString() == "返回房间列表" } as Button).performClick() }
            assertFalse(active.multiplayerStatus().optBoolean("connected"))
        } finally {
            client.close()
            instrumentation.runOnMainSync { runtime?.close(); activity.finish() }
            permissions.revoke(room); store.uninstall(room.id)
        }
    }
}
