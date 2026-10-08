package io.roomillion.android

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLSocket

@RunWith(AndroidJUnit4::class)
class RoomLanSessionTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val id = "cn.roomillion.lan-test"
    private fun session() = RoomLanSession(context, id, "1.0.0")
    private fun activity(): MainActivity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
    private fun loopback(status: JSONObject): String {
        val original = status.getJSONArray("invitations").getJSONObject(0).getString("invitation")
        val value = RoomLanSession.parseInvitation(original, id, "1.0.0").put("host", "127.0.0.1")
        return RoomLanSession.encodeInvitation(value)
    }
    private fun event(session: RoomLanSession, type: String): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val events = session.read(JSONObject().put("timeoutMs", 1000)).getJSONArray("events")
            for (index in 0 until events.length()) if (events.getJSONObject(index).optString("type") == type) return events.getJSONObject(index)
        }
        error("等待事件失败：$type")
    }
    private fun drain(session: RoomLanSession) = session.read(JSONObject().put("timeoutMs", 0))

    @Test fun nativeHostExchangesPrivateAndPublicMessagesWithTwoClients() {
        val activity = activity(); val host = session(); val a = session(); val b = session()
        try {
            val status = host.create(JSONObject().put("name", "测试游戏").put("maxPlayers", 3))
            assertEquals("host", status.getString("role"))
            val invite = loopback(status)
            val aId = a.join(JSONObject().put("invitation", invite).put("name", "甲")).getString("peerId")
            val bId = b.join(JSONObject().put("invitation", invite).put("name", "乙")).getString("peerId")
            drain(host); drain(a); drain(b)
            host.send(JSONObject().put("role", "seer"), JSONObject().put("to", aId))
            assertEquals("seer", event(a, "message").getJSONObject("data").getString("role"))
            assertEquals(0, b.read(JSONObject().put("timeoutMs", 100)).getJSONArray("events").length())
            host.send(JSONObject().put("phase", "day"), JSONObject())
            assertEquals("day", event(a, "message").getJSONObject("data").getString("phase"))
            assertEquals("day", event(b, "message").getJSONObject("data").getString("phase"))
            a.send(JSONObject().put("vote", bId), JSONObject())
            val vote = event(host, "message")
            assertEquals(aId, vote.getString("from")); assertEquals(bId, vote.getJSONObject("data").getString("vote"))
            assertTrue(runCatching { a.send(JSONObject(), JSONObject().put("to", bId)) }.isFailure)
            assertTrue(runCatching { a.send("x".repeat(65537), JSONObject()) }.isFailure)
            assertTrue(runCatching { a.read(JSONObject().put("timeoutMs", -1)) }.isFailure)
        } finally { a.close(); b.close(); host.close(); instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun hostRejectsWrongCertificateCredentialsVersionAndFullGame() {
        val activity = activity(); val host = session(); val a = session()
        try {
            val invite = loopback(host.create(JSONObject().put("maxPlayers", 2)))
            val raw = RoomLanSession.parseInvitation(invite, id, "1.0.0")
            for (field in listOf("fingerprint", "token")) {
                val rejected = session()
                try { assertTrue(runCatching { rejected.join(JSONObject().put("invitation", RoomLanSession.encodeInvitation(JSONObject(raw.toString()).put(field, "0".repeat(64))))) }.isFailure) }
                finally { rejected.close() }
            }
            assertTrue(runCatching { RoomLanSession.parseInvitation(invite, id, "2.0.0") }.isFailure)
            assertTrue(runCatching { RoomLanSession.parseInvitation(RoomLanSession.encodeInvitation(JSONObject(raw.toString()).put("host", "8.8.8.8")), id, "1.0.0") }.isFailure)
            a.join(JSONObject().put("invitation", invite)); val b = session()
            try { assertTrue(runCatching { b.join(JSONObject().put("invitation", invite)) }.isFailure) } finally { b.close() }
        } finally { a.close(); host.close(); instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun reconnectKeepsSeatAndDeliversPendingPrivateMessage() {
        val activity = activity(); val host = session(); val client = session()
        try {
            val invite = loopback(host.create(JSONObject()))
            val peer = client.join(JSONObject().put("invitation", invite)).getString("peerId")
            drain(client); drain(host)
            val connections = RoomLanSession::class.java.getDeclaredField("connections").apply { isAccessible = true }.get(client) as Set<*>
            val connection = connections.first()!!
            (connection.javaClass.getDeclaredField("socket").apply { isAccessible = true }.get(connection) as SSLSocket).close()
            event(host, "disconnected")
            host.send(JSONObject().put("role", "wolf"), JSONObject().put("to", peer))
            assertEquals(peer, event(host, "reconnected").getString("peerId"))
            assertEquals("wolf", event(client, "message").getJSONObject("data").getString("role"))
            assertEquals(peer, client.status().getString("peerId"))
            client.close()
            event(host, "left")
            assertEquals(0, host.status().getJSONArray("peers").length())
        } finally { client.close(); host.close(); instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun leaveImmediatelyAfterPrivateMessageReleasesSeat() {
        val activity = activity(); val host = session()
        try {
            val invitation = loopback(host.create(JSONObject().put("maxPlayers", 2)))
            repeat(12) {
                val client = session()
                try {
                    val peer = client.join(JSONObject().put("invitation", invitation)).getString("peerId")
                    event(host, "joined"); drain(client)
                    host.send(JSONObject().put("round", it), JSONObject().put("to", peer))
                    assertEquals(it, event(client, "message").getJSONObject("data").getInt("round"))
                    client.close()
                    assertEquals(peer, event(host, "left").getString("peerId"))
                    assertEquals(0, host.status().getJSONArray("peers").length())
                } finally { client.close() }
            }
        } finally { host.close(); instrumentation.runOnMainSync { activity.finish() } }
    }

    /** Invoked only by the explicit desktop/Android transport acceptance script. */
    @Test fun joinDesktopHostWhenRequested() {
        if (!InstrumentationRegistry.getArguments().getString("desktopHostInterop").equals("true")) return
        val client = session()
        val inviteFile = File(context.filesDir, "desktop-lan-test-invitation.json")
        try {
            val invitation = JSONObject(inviteFile.readText()).getString("invitation")
            val joined = client.join(JSONObject().put("invitation", invitation).put("name", "安卓验收玩家"))
            assertTrue(joined.getBoolean("connected"))
            client.send(JSONObject().put("action", "android-probe"), JSONObject())
            var publicReceived = false; var privateReceived = false
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12)
            while ((!publicReceived || !privateReceived) && System.nanoTime() < deadline) {
                val events = client.read(JSONObject().put("timeoutMs", 1000)).getJSONArray("events")
                for (index in 0 until events.length()) {
                    val value = events.getJSONObject(index)
                    if (value.optString("type") != "message") continue
                    assertEquals("host", value.getString("from"))
                    val data = value.getJSONObject("data")
                    if (data.optString("phase") == "day") publicReceived = true
                    if (data.optString("private") == "android-only") privateReceived = true
                }
            }
            assertTrue("安卓未收到广播", publicReceived); assertTrue("安卓未收到私密消息", privateReceived)
            client.send(JSONObject().put("action", "android-received"), JSONObject())
            // Give the host time to acknowledge before orderly leave clears pending sends.
            Thread.sleep(200)
        } finally { client.close(); inviteFile.delete() }
    }

    /** Invoked only by the explicit desktop/Android transport acceptance script. */
    @Test fun desktopInteropWhenRequested() {
        if (!InstrumentationRegistry.getArguments().getString("lanInterop").equals("true")) return
        val activity = activity(); val host = session()
        val inviteFile = File(context.filesDir, "lan-test-invitation.json")
        try {
            val status = host.create(JSONObject().put("name", "桌面互通测试"))
            val invitation = loopback(status)
            inviteFile.writeText(JSONObject().put("invitation", invitation).toString())
            val join = event(host, "joined")
            val message = event(host, "message")
            assertEquals("desktop-probe", message.getJSONObject("data").getString("action"))
            host.send(JSONObject().put("private", "only-this-player"), JSONObject().put("to", join.getString("peerId")))
            val ack = event(host, "message")
            assertEquals("desktop-received", ack.getJSONObject("data").getString("action"))
        } finally { inviteFile.delete(); host.close(); instrumentation.runOnMainSync { activity.finish() } }
    }
}
