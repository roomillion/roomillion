package io.roomillion.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import javax.net.ssl.X509KeyManager
import java.security.PrivateKey
import java.net.Socket
import javax.security.auth.x500.X500Principal
import java.security.cert.X509Certificate

/** Reliable native transport, shared by hotspot LAN and a future nearby IP link.
 * Room code sees JSON events only; it never obtains a listening socket or OS address access.
 * The invitation pins the ephemeral TLS certificate before any join credential is sent. */
class RoomLanSession(private val context: Context, private val roomId: String, private val roomVersion: String) {
    companion object {
        const val PROTOCOL = "roomillion-lan-1"
        const val MAX_MESSAGE = 64 * 1024
        private const val MAX_FRAME = 96 * 1024
        private const val MAX_QUEUE = 1024 * 1024
        private val random = SecureRandom()
        fun token(bytes: Int): String = ByteArray(bytes).also(random::nextBytes).joinToString("") { "%02x".format(it) }
        fun localAddress(value: String): Boolean {
            if (!value.matches(Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}"))) return false
            val parts = value.split('.').map(String::toInt)
            if (parts.any { it !in 0..255 }) return false
            val (a, b) = parts
            return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        fun encodeInvitation(value: JSONObject): String = "roomillion-lan:" + java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(value.toString().toByteArray(Charsets.UTF_8))
        fun parseInvitation(raw: String, roomId: String, roomVersion: String): JSONObject {
            require(raw.length <= 4096 && raw.matches(Regex("roomillion-lan:[A-Za-z0-9_-]+"))) { "请粘贴主机分享的完整加入信息" }
            val value = JSONObject(String(java.util.Base64.getUrlDecoder().decode(raw.substring(15)), Charsets.UTF_8))
            require(value.optString("protocol") == PROTOCOL && localAddress(value.optString("host")) &&
                value.opt("port") is Number && value.getDouble("port") == value.getInt("port").toDouble() && value.getInt("port") in 1024..65535 &&
                value.optString("fingerprint").matches(Regex("[a-f0-9]{64}")) && value.optString("token").matches(Regex("[a-f0-9]{64}")) &&
                value.optString("sessionId").matches(Regex("[a-f0-9]{32}"))) { "加入信息的地址或凭证无效" }
            require(value.optString("roomId") == roomId && value.optString("roomVersion") == roomVersion) { "主机与本机需要安装相同 ID 和版本的房间" }
            return value
        }
        private fun fingerprint(cert: X509Certificate) = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
            .joinToString("") { "%02x".format(it) }
        private fun name(options: JSONObject, fallback: String): String {
            if (!options.has("name")) return fallback
            val name = options.get("name")
            require(name is String && name.trim().isNotEmpty() && name.length <= 40 && name.none { it.code < 32 }) { "玩家或游戏名称无效" }
            return name.trim()
        }
    }

    private class Connection(val socket: SSLSocket) {
        val input by lazy { BufferedInputStream(socket.inputStream) }
        @Synchronized fun write(value: JSONObject) {
            val bytes = (value.toString() + "\n").toByteArray(Charsets.UTF_8)
            require(bytes.size <= MAX_FRAME) { "联机消息过大" }
            socket.outputStream.write(bytes); socket.outputStream.flush()
        }
        fun read(): JSONObject {
            val bytes = ByteArrayOutputStream()
            while (true) {
                val next = input.read()
                check(next >= 0) { "连接已关闭" }
                if (next == 10) break
                require(bytes.size() < MAX_FRAME) { "联机消息过大" }
                bytes.write(next)
            }
            return JSONObject(bytes.toString("UTF-8"))
        }
        fun close() { runCatching { socket.close() } }
    }
    private class Peer(val id: String, val resumeToken: String, var name: String) {
        var connection: Connection? = null
        val pending = linkedMapOf<String, JSONObject>()
        val seen = linkedSetOf<String>()
    }
    private val lock = Object()
    private val worker = Executors.newCachedThreadPool()
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private val handshakes = Semaphore(40)
    private val connections = mutableSetOf<Connection>()
    private val peers = linkedMapOf<String, Peer>()
    private val events = mutableListOf<JSONObject>()
    private var eventBytes = 0
    private var reading = false
    @Volatile private var closed = false
    @Volatile private var connected = false
    private var role: String? = null
    private var server: SSLServerSocket? = null
    private var keyAlias: String? = null
    private var sessionId: String? = null
    private var joinToken: String? = null
    private var invitation: JSONObject? = null
    private var clientPeer: Peer? = null
    private var invitations = JSONArray()
    private var maxPlayers = 16
    fun isClosed(): Boolean = closed

    fun status(): JSONObject = synchronized(lock) {
        JSONObject().put("supported", true).put("canHost", true).put("transport", "lan")
            .put("role", role ?: JSONObject.NULL).put("connected", connected && !closed)
            .put("peerId", if (role == "host") "host" else clientPeer?.id ?: JSONObject.NULL)
            .put("sessionId", sessionId ?: JSONObject.NULL).put("invitations", JSONArray(invitations.toString()))
            .put("peers", JSONArray(peers.values.map { peer -> JSONObject().put("peerId", peer.id).put("name", peer.name)
                .put("connected", peer.connection != null) }))
    }
    fun create(options: JSONObject): JSONObject {
        synchronized(lock) { check(role == null && !closed) { "请先离开当前游戏" }; role = "starting" }
        var createdListener: SSLServerSocket? = null
        try {
            require(!options.has("transport") || options.getString("transport") == "lan") { "当前版本支持热点或同一局域网联机" }
            val title = name(options, "联机游戏")
            if (options.has("maxPlayers")) {
                val value = options.get("maxPlayers")
                require(value is Number && value.toDouble() == value.toInt().toDouble() && value.toInt() in 2..32) { "总人数必须在 2 至 32 之间" }
                maxPlayers = value.toInt()
            }
            val alias = "roomillion-lan-${token(8)}"
            keyAlias = alias
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                // Conscrypt supplies a pre-hashed TLS transcript to NONEwithECDSA.
                .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256).setCertificateSubject(X500Principal("CN=Roomillion LAN"))
                .setCertificateNotBefore(Date(System.currentTimeMillis() - 60000))
                .setCertificateNotAfter(Date(System.currentTimeMillis() + TimeUnit.DAYS.toMillis(7))).build())
            generator.generateKeyPair()
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            // AndroidKeyStore also contains unrelated workbench keys. Never let TLS
            // choose another key or a stale certificate from an interrupted session.
            val manager = object : X509KeyManager {
                override fun getClientAliases(keyType: String?, issuers: Array<java.security.Principal>?): Array<String> = emptyArray()
                override fun chooseClientAlias(keyType: Array<String>?, issuers: Array<java.security.Principal>?, socket: Socket?): String? = null
                override fun getServerAliases(keyType: String?, issuers: Array<java.security.Principal>?): Array<String> = if (keyType == "EC") arrayOf(alias) else emptyArray()
                override fun chooseServerAlias(keyType: String?, issuers: Array<java.security.Principal>?, socket: Socket?): String? = if (keyType == "EC") alias else null
                override fun getCertificateChain(selected: String?): Array<X509Certificate> = if (selected == alias) arrayOf(store.getCertificate(alias) as X509Certificate) else emptyArray()
                override fun getPrivateKey(selected: String?): PrivateKey? = if (selected == alias) store.getKey(alias, null) as PrivateKey else null
            }
            val ssl = SSLContext.getInstance("TLS").apply { init(arrayOf(manager), null, random) }
            val listener = ssl.serverSocketFactory.createServerSocket(0, 32, InetAddress.getByName("0.0.0.0")) as SSLServerSocket
            createdListener = listener
            listener.enabledProtocols = listener.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
            synchronized(lock) { check(!closed) { "游戏已离开" }; server = listener; role = "host"; connected = true; sessionId = token(16); joinToken = token(32) }
            val certHash = fingerprint(store.getCertificate(alias) as X509Certificate)
            val addresses = NetworkInterface.getNetworkInterfaces().toList().filter { network -> network.isUp &&
                !network.name.startsWith("rmnet") && !network.name.startsWith("tun") && !network.name.startsWith("ccmni") }
                .flatMap { it.inetAddresses.toList() }.mapNotNull { it.hostAddress }.filter { localAddress(it) && !it.startsWith("127.") }
            require(addresses.isNotEmpty()) { "请先开启手机热点或连接局域网，再创建游戏" }
            for (address in addresses.distinct()) {
                val value = JSONObject().put("protocol", PROTOCOL).put("host", address).put("port", listener.localPort)
                    .put("roomId", roomId).put("roomVersion", roomVersion).put("sessionId", sessionId).put("token", joinToken).put("fingerprint", certHash)
                invitations.put(JSONObject().put("host", address).put("invitation", encodeInvitation(value)))
            }
            synchronized(lock) { check(!closed) { "游戏已离开" }; LanForegroundService.begin(context, title) }
            worker.execute {
                while (!closed) {
                    val socket = try { listener.accept() as SSLSocket } catch (_: Exception) { break }
                    if (!handshakes.tryAcquire()) { socket.close(); continue }
                    val connection = Connection(socket)
                    synchronized(lock) { connections.add(connection) }
                    worker.execute { try { serve(connection) } finally { handshakes.release(); synchronized(lock) { connections.remove(connection) }; connection.close() } }
                }
            }
            timer.scheduleAtFixedRate({
                val current = synchronized(lock) { peers.values.mapNotNull { it.connection } }
                current.forEach { connection -> runCatching { connection.write(JSONObject().put("op", "ping")) }.onFailure { connection.close() } }
            }, 10, 10, TimeUnit.SECONDS)
            push(JSONObject().put("type", "created").put("peerId", "host"))
            return status()
        } catch (error: Exception) {
            runCatching { createdListener?.close() }
            // close() may already have run while key generation was in progress.
            keyAlias?.let { alias -> runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) } }
            close(); throw error
        }
    }
    private fun serve(connection: Connection) {
        var peer: Peer? = null
        try {
            connection.socket.soTimeout = 8000
            connection.socket.startHandshake()
            val hello = connection.read()
            require(hello.optString("op") == "hello" && hello.optString("protocol") == PROTOCOL &&
                hello.optString("sessionId") == sessionId && hello.optString("token") == joinToken) { "加入凭证无效" }
            require(hello.optString("roomId") == roomId && hello.optString("roomVersion") == roomVersion) { "房间版本不一致" }
            val playerName = name(hello, "玩家")
            val reconnect: Boolean
            synchronized(lock) {
                check(!closed) { "游戏已关闭" }
                val old = peers[hello.optString("peerId")]
                if (old != null) {
                    require(hello.optString("resumeToken") == old.resumeToken) { "重连凭证无效" }
                    old.connection?.close(); peer = old; reconnect = true
                } else {
                    require(!hello.has("peerId") || hello.isNull("peerId")) { "原游戏已结束，请重新加入" }
                    require(peers.size < maxPlayers - 1) { "游戏人数已满" }
                    peer = Peer(token(16), token(32), playerName); peers[peer!!.id] = peer!!; reconnect = false
                }
                peer!!.connection = connection
            }
            connection.write(JSONObject().put("op", "welcome").put("peerId", peer!!.id).put("resumeToken", peer!!.resumeToken))
            connection.socket.soTimeout = 45000
            val pending = synchronized(lock) { peer!!.pending.values.toList() }
            pending.forEach(connection::write)
            push(JSONObject().put("type", if (reconnect) "reconnected" else "joined").put("peerId", peer!!.id).put("name", playerName))
            while (!closed) {
                val message = connection.read()
                when (message.optString("op")) {
                    "pong" -> Unit
                    "ack" -> synchronized(lock) { peer!!.pending.remove(message.optString("id")); Unit }
                    "message" -> {
                        val id = message.getString("id")
                        require(id.matches(Regex("[a-f0-9]{32}")) && message.has("data")) { "玩家消息无效" }
                        validateData(message.get("data"))
                        synchronized(lock) {
                            if (id !in peer!!.seen) {
                                push(JSONObject().put("type", "message").put("id", id).put("from", peer!!.id).put("data", message.get("data")))
                                remember(peer!!.seen, id)
                            }
                        }
                        connection.write(JSONObject().put("op", "ack").put("id", id))
                    }
                    "leave" -> { synchronized(lock) { peers.remove(peer!!.id) }; break }
                    else -> error("未知联机消息")
                }
            }
        } catch (error: Exception) {
            if (BuildConfig.DEBUG && peer == null) android.util.Log.w("RoomillionLan", "联机握手未完成", error)
            runCatching { connection.write(JSONObject().put("op", "error").put("error", error.message?.take(300))) }
        }
        finally {
            synchronized(lock) {
                if (peer?.connection === connection) {
                    peer!!.connection = null
                    if (!closed) runCatching { push(JSONObject().put("type", if (peers.containsKey(peer!!.id)) "disconnected" else "left").put("peerId", peer!!.id)) }
                }
            }
        }
    }
    fun join(options: JSONObject): JSONObject {
        val value = parseInvitation(options.getString("invitation"), roomId, roomVersion)
        val playerName = name(options, "手机玩家")
        synchronized(lock) { check(role == null && !closed) { "请先离开当前游戏" }; role = "client"; invitation = value; sessionId = value.getString("sessionId") }
        try { connect(playerName); return status() } catch (error: Exception) { close(); throw error }
    }
    private fun connect(playerName: String) {
        check(!closed) { "游戏已离开" }
        val value = invitation!!
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { error("不支持客户端证书") }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                require(chain.isNotEmpty() && fingerprint(chain[0]) == value.getString("fingerprint")) { "主机证书与加入信息不一致" }
            }
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), random) }
        val socket = ssl.socketFactory.createSocket() as SSLSocket
        socket.enabledProtocols = socket.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
        val connection = Connection(socket)
        synchronized(lock) { if (closed) { connection.close(); error("游戏已离开") }; connections.add(connection) }
        try {
            socket.soTimeout = 8000
            socket.connect(InetSocketAddress(value.getString("host"), value.getInt("port")), 8000)
            socket.startHandshake()
            connection.write(JSONObject().put("op", "hello").put("protocol", PROTOCOL).put("sessionId", sessionId)
                .put("token", value.getString("token")).put("roomId", roomId).put("roomVersion", roomVersion)
                .put("name", playerName).put("peerId", clientPeer?.id ?: JSONObject.NULL).put("resumeToken", clientPeer?.resumeToken ?: JSONObject.NULL))
            val welcome = connection.read()
            require(welcome.optString("op") == "welcome") { welcome.optString("error", "主机握手无效") }
            require(welcome.optString("peerId").matches(Regex("[a-f0-9]{32}")) && welcome.optString("resumeToken").matches(Regex("[a-f0-9]{64}"))) { "主机握手无效" }
            synchronized(lock) {
                check(!closed) { "游戏已离开" }
                if (clientPeer == null) clientPeer = Peer(welcome.getString("peerId"), welcome.getString("resumeToken"), playerName)
                clientPeer!!.connection = connection; connected = true
            }
            socket.soTimeout = 45000
            push(JSONObject().put("type", "connected").put("peerId", clientPeer!!.id))
            synchronized(lock) { clientPeer!!.pending.values.toList() }.forEach(connection::write)
            worker.execute {
                try {
                    while (!closed) {
                        val message = connection.read()
                        when (message.optString("op")) {
                            "ping" -> connection.write(JSONObject().put("op", "pong"))
                            "ack" -> synchronized(lock) { clientPeer!!.pending.remove(message.optString("id")); Unit }
                            "error" -> error(message.optString("error", "主机断开连接"))
                            "message" -> {
                                val id = message.getString("id")
                                require(id.matches(Regex("[a-f0-9]{32}")) && message.optString("from") == "host" && message.has("data")) { "主机消息无效" }
                                validateData(message.get("data"))
                                synchronized(lock) {
                                    if (id !in clientPeer!!.seen) {
                                        push(JSONObject().put("type", "message").put("id", id).put("from", "host").put("data", message.get("data")))
                                        remember(clientPeer!!.seen, id)
                                    }
                                }
                                connection.write(JSONObject().put("op", "ack").put("id", id))
                            }
                            else -> error("未知联机消息")
                        }
                    }
                } catch (_: Exception) { /* a transient disconnect triggers the same-identity reconnect below */ }
                finally {
                    val reconnect = synchronized(lock) {
                        if (closed) false // close() owns this socket until its leave frame is sent.
                        else {
                            connections.remove(connection)
                            if (clientPeer?.connection === connection) { clientPeer!!.connection = null; connected = false }
                            true
                        }
                    }
                    if (reconnect) {
                        connection.close()
                        runCatching { push(JSONObject().put("type", "disconnected")) }
                        scheduleReconnect(playerName)
                    }
                }
            }
        } catch (error: Exception) { connection.close(); synchronized(lock) { connections.remove(connection) }; throw error }
    }
    private fun scheduleReconnect(playerName: String) {
        if (!closed) runCatching { timer.schedule({ if (!closed) runCatching { connect(playerName) }.onFailure { scheduleReconnect(playerName) } }, 2, TimeUnit.SECONDS) }
    }
    private fun validateData(data: Any) {
        val serialized = JSONArray().put(data).toString().let { it.substring(1, it.length - 1) }
        require(serialized.toByteArray(Charsets.UTF_8).size <= MAX_MESSAGE) { "联机消息不能超过 64 KiB" }
    }
    private fun remember(seen: MutableSet<String>, id: String) { seen.add(id); if (seen.size > 512) seen.remove(seen.first()) }
    fun send(data: Any, options: JSONObject): JSONObject {
        validateData(data)
        val id = token(16)
        val message = JSONObject().put("op", "message").put("id", id).put("data", data)
        val destinations = synchronized(lock) {
            check(!closed && connected) { "连接已断开，请等待重新连接" }
            val to = options.optString("to", if (role == "host") "all" else "host")
            if (role == "host") {
                message.put("from", "host")
                val selected = if (to == "all") peers.values.toList() else listOf(peers[to] ?: error("玩家不存在"))
                require(selected.all { it.pending.size < 128 && it.pending.values.sumOf { pending -> pending.toString().toByteArray(Charsets.UTF_8).size } + message.toString().toByteArray(Charsets.UTF_8).size <= MAX_QUEUE }) { "等待玩家接收的消息过多" }
                selected.forEach { it.pending[id] = message }
                selected.mapNotNull { it.connection }
            } else {
                require(to == "host") { "玩家只能向主机提交消息" }
                val peer = clientPeer ?: error("尚未加入游戏")
                require(peer.pending.size < 128 && peer.pending.values.sumOf { it.toString().toByteArray(Charsets.UTF_8).size } + message.toString().toByteArray(Charsets.UTF_8).size <= MAX_QUEUE) { "等待主机接收的消息过多" }
                peer.pending[id] = message
                listOfNotNull(peer.connection)
            }
        }
        destinations.forEach { connection -> runCatching { connection.write(message) }.onFailure { connection.close() } }
        return JSONObject().put("id", id)
    }
    private fun push(event: JSONObject) = synchronized(lock) {
        check(!closed) { "游戏已离开" }
        val size = event.toString().toByteArray(Charsets.UTF_8).size
        require(eventBytes + size <= MAX_QUEUE) { "房间没有及时读取联机消息，请重新加入" }
        events.add(event); eventBytes += size; lock.notifyAll()
    }
    fun read(options: JSONObject): JSONObject = synchronized(lock) {
        check(!closed || events.isNotEmpty()) { "游戏连接已关闭，请重新加入" }
        val timeout = if (options.has("timeoutMs")) options.get("timeoutMs") else 15000
        require(timeout is Number && timeout.toDouble() == timeout.toInt().toDouble() && timeout.toInt() in 0..15000) { "等待读取时间必须在 0 至 15000 毫秒之间" }
        check(!reading) { "同一个游戏只允许一个消息读取循环" }
        reading = true
        try {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout.toLong())
            while (events.isEmpty() && !closed && deadline > System.nanoTime()) {
                lock.wait(maxOf(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())))
            }
            val result = status().put("events", JSONArray(events.toList()))
            events.clear(); eventBytes = 0; result
        } finally { reading = false }
    }
    fun close() {
        val departure = synchronized(lock) {
            if (closed) return
            closed = true; connected = false; lock.notifyAll(); Pair(connections.toList(), clientPeer?.connection)
        }
        val sockets = departure.first
        runCatching { server?.close() }
        if (role == "host") LanForegroundService.end(context)
        // Never wait for a socket writer on the UI thread when closing a room.
        // A brief grace period delivers leave; force-close also breaks a stalled write.
        timer.shutdownNow()
        val closer = Executors.newSingleThreadScheduledExecutor()
        closer.schedule({ sockets.forEach(Connection::close) }, 200, TimeUnit.MILLISECONDS)
        worker.execute {
            try { runCatching { departure.second?.write(JSONObject().put("op", "leave")) } }
            finally {
                sockets.forEach(Connection::close)
                keyAlias?.let { alias -> runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) } }
                closer.shutdown()
            }
        }
        worker.shutdown()
    }
}
