package io.roomillion.android

import android.content.Intent
import android.content.IntentFilter
import android.content.ContentValues
import android.app.Activity
import android.app.Instrumentation
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Button
import androidx.webkit.WebViewFeature
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import androidx.test.espresso.Espresso.pressBack

@RunWith(AndroidJUnit4::class)
class RoomRuntimeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    private fun find(root: View, predicate: (View) -> Boolean): View? {
        if (predicate(root)) return root
        if (root is ViewGroup) for (index in 0 until root.childCount) {
            find(root.getChildAt(index), predicate)?.let { return it }
        }
        return null
    }

    private fun evaluate(view: WebView, code: String): String {
        val done = CountDownLatch(1)
        var result = ""
        instrumentation.runOnMainSync {
            view.evaluateJavascript(code) { result = it; done.countDown() }
        }
        assertTrue("JavaScript response timed out", done.await(10, TimeUnit.SECONDS))
        return result
    }

    private fun waitFor(view: WebView, code: String, expected: String): String {
        repeat(40) {
            val result = evaluate(view, code)
            if (result.contains(expected)) return result
            Thread.sleep(250)
        }
        error("房间页面未达到预期状态：$expected；实际为 ${evaluate(view, code)}")
    }

    private fun waitForActivityFocus(activity: MainActivity) {
        repeat(40) {
            var focused = false
            instrumentation.runOnMainSync { focused = activity.hasWindowFocus() }
            if (focused) return
            Thread.sleep(100)
        }
        error("工作台窗口未取得焦点")
    }

    private fun clickActiveWindowText(label: String) {
        fun visibleNodes(node: AccessibilityNodeInfo?, depth: Int = 0): List<String> {
            if (node == null || depth > 5) return emptyList()
            return listOfNotNull(node.text?.toString(), node.contentDescription?.toString()) +
                (0 until node.childCount).flatMap { visibleNodes(node.getChild(it), depth + 1) }
        }
        var visible = "无活动窗口"
        repeat(40) {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            visible = root?.let { "${it.packageName}: ${visibleNodes(it).take(30)}" } ?: "无活动窗口"
            val match = root?.findAccessibilityNodeInfosByText(label)?.firstOrNull { it.text?.toString() == label }
            var target = match
            while (target != null && !target.isClickable) target = target.parent
            if (target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) {
                instrumentation.waitForIdleSync()
                return
            }
            Thread.sleep(100)
        }
        error("当前窗口中找不到可点击的“$label”；$visible")
    }

    @Test fun bundledExampleCanBeInstalledFromHome() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val exampleId = "cn.zhibian.example.inventory"
        val alreadyInstalled = store.list().any { it.id == exampleId }
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            waitForActivityFocus(activity)
            clickActiveWindowText("安装内置示例房间")
            clickActiveWindowText(if (alreadyInstalled) "物资台账 · 已安装 ${store.readInstalled(exampleId).version}" else "物资台账")
            clickActiveWindowText("安装")
            repeat(40) {
                if (store.list().any { it.id == exampleId }) return
                Thread.sleep(100)
            }
            error("首页示例未安装")
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            if (!alreadyInstalled) store.uninstall(exampleId)
        }
    }

    @Test fun systemBackReturnsFromRoomToWorkbench() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("inventory.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            waitForActivityFocus(activity)
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("物资台账") } as Button?
                assertNotNull(open)
                open!!.performClick()
                assertNotNull(find(activity.window.decorView) { it is WebView })
            }
            pressBack()
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTrue(find(activity.window.decorView) { it is WebView } == null)
                assertNotNull(find(activity.window.decorView) { it is Button && it.text.toString().contains("物资台账") })
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun publicInventoryLoadsWithRoomBridgeAndPrivateDatabase() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("inventory.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val button = find(activity.window.decorView) { it is Button && it.text.toString().contains("物资台账") } as Button?
                assertNotNull("房间应显示在工作台列表中", button)
                button!!.performClick()
            }
            val webView = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull("房间应在独立 WebView 中运行；消息桥=${WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)}，启动脚本=${WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)}", webView)
            waitFor(webView!!, "typeof window.room", "object")
            assertTrue(evaluate(webView, "document.body.innerText").contains("物资台账"))
            evaluate(webView, "window.__undeclaredModule='pending';fetch('/_modules/utility.qrcode@1/qrcode.min.js').then(r=>window.__undeclaredModule=String(r.status))")
            assertEquals("\"403\"", waitFor(webView, "window.__undeclaredModule", "403"))
            evaluate(webView, "window.__undeclaredSheet='pending';fetch('/_modules/document.spreadsheet@1/xlsx.full.min.js').then(r=>window.__undeclaredSheet=String(r.status))")
            assertEquals("\"403\"", waitFor(webView, "window.__undeclaredSheet", "403"))
            evaluate(webView, "window.__roomTest='pending'; window.room.getInfo().then(x=>window.__roomTest=x.id).catch(e=>window.__roomTest='ERROR:'+e.message)")
            waitFor(webView, "window.__roomTest", "cn.zhibian.example.inventory")
            evaluate(webView, "window.__dbTest='pending'; window.room.db.query('SELECT 7 AS result').then(x=>window.__dbTest=String(x[0].result)).catch(e=>window.__dbTest='ERROR:'+e.message)")
            assertEquals("\"7\"", waitFor(webView, "window.__dbTest", "7"))
            evaluate(webView, "window.__typedQuery='pending'; window.room.db.query('SELECT ? AS missing, ? AS amount, ? AS label',[null,7,'中文']).then(x=>window.__typedQuery=x[0].missing===null&&x[0].amount===7&&x[0].label==='中文'?'ok':JSON.stringify(x)).catch(e=>window.__typedQuery='ERROR:'+e.message)")
            assertEquals("\"ok\"", waitFor(webView, "window.__typedQuery", "ok"))
            evaluate(webView, "window.__blobProbe='pending';(async()=>{await room.db.run('CREATE TABLE IF NOT EXISTS __android_blob_probe(payload BLOB)');await room.db.run('DELETE FROM __android_blob_probe');const bytes=new Uint8Array([0,128,255]);await room.db.run('INSERT INTO __android_blob_probe(payload) VALUES(?)',[bytes]);const rows=await room.db.query('SELECT payload FROM __android_blob_probe WHERE payload=?',[bytes]);window.__blobProbe=rows.length===1&&rows[0].payload instanceof Uint8Array&&Array.from(rows[0].payload).join(',')==='0,128,255'?'ok':'bad'})().catch(e=>window.__blobProbe='ERROR:'+e.message)")
            assertEquals("\"ok\"", waitFor(webView, "window.__blobProbe", "ok"))
            evaluate(webView, "window.__badSqlParam='pending';room.db.query('SELECT ? AS value',[{bad:true}]).then(()=>window.__badSqlParam='unexpected').catch(()=>window.__badSqlParam='rejected')")
            assertEquals("\"rejected\"", waitFor(webView, "window.__badSqlParam", "rejected"))
            evaluate(webView, "window.__storageResult='pending'; window.room.storage.set('__android_contract',{number:7}).then(x=>window.__storageResult=x===true?'ok':'wrong').catch(e=>window.__storageResult='ERROR:'+e.message)")
            assertEquals("\"ok\"", waitFor(webView, "window.__storageResult", "ok"))
            evaluate(webView, "window.__roomBlob='pending';(async()=>{const bytes=new Uint8Array(300000);bytes[0]=128;bytes[299999]=255;const saved=await room.artifacts.put('probe.bin',bytes,{mimeType:'application/octet-stream'});const rows=await room.artifacts.list();const tail=await room.artifacts.read(saved.id,{offset:299999,length:1});const whole=await room.artifacts.read(saved.id,{offset:0,length:4*1024*1024});const removed=await room.artifacts.remove(saved.id);window.__roomBlob=rows.some(x=>x.id===saved.id)&&tail.data instanceof Uint8Array&&tail.data[0]===255&&whole.data.length===300000&&whole.data[0]===128&&whole.data[299999]===255&&whole.eof&&removed===true?'ok':'wrong'})().catch(e=>window.__roomBlob='ERROR:'+e.message)")
            assertEquals("\"ok\"", waitFor(webView, "window.__roomBlob", "ok"))
            evaluate(webView, "window.__streamExport='pending';(async()=>{const h=await room.files.beginExport('probe.bin');const first=await room.files.writeExport(h.token,new Uint8Array([0,128,255]));const second=await room.files.writeExport(h.token,'好');const stopped=await room.files.abortExport(h.token);window.__streamExport=h.path==='probe.bin'&&h.bytes===0&&first.bytes===3&&second.bytes===6&&stopped===true?'ok':'wrong'})().catch(e=>window.__streamExport='ERROR:'+e.message)")
            assertEquals("\"ok\"", waitFor(webView, "window.__streamExport", "ok"))
            val itemName = "安卓物资操作测试-${System.nanoTime()}"
            val itemNameJs = JSONObject.quote(itemName)
            waitFor(webView, "document.querySelector('#items .empty, #items .item') !== null", "true")
            assertEquals("\"submitted\"", evaluate(webView, "(()=>{const f=document.getElementById('itemForm');f.elements.name.value=$itemNameJs;f.elements.quantity.value='3';f.elements.note.value='设备回归';f.requestSubmit();return 'submitted'})()"))
            waitFor(webView, "[...document.querySelectorAll('#items .item strong')].some(x=>x.textContent===$itemNameJs)", "true")
            evaluate(webView, "window.__itemRows='pending';window.room.db.query('SELECT quantity, note FROM inventory WHERE name = ?',[$itemNameJs]).then(x=>window.__itemRows=JSON.stringify(x)).catch(e=>window.__itemRows='ERROR:'+e.message)")
            assertTrue(waitFor(webView, "window.__itemRows", "设备回归").contains("3"))
            evaluate(webView, "[...document.querySelectorAll('#items .item')].find(x=>x.querySelector('strong')?.textContent===$itemNameJs).querySelector('button.delete').click()")
            waitFor(webView, "[...document.querySelectorAll('#items .item strong')].some(x=>x.textContent===$itemNameJs)", "false")
            evaluate(webView, "window.__networkTest='pending'; fetch('https://example.com').then(()=>window.__networkTest='unexpected').catch(()=>window.__networkTest='blocked')")
            assertEquals("\"blocked\"", waitFor(webView, "window.__networkTest", "blocked"))
            val otherId = "cn.zhibian.example.meeting-actions"
            val otherHost = MessageDigest.getInstance("SHA-256").digest(otherId.toByteArray())
                .joinToString("") { "%02x".format(it) }.take(24)
            evaluate(webView, "window.__crossRoom='pending'; fetch('https://r-$otherHost.roomillion.invalid/room/app/index.html').then(()=>window.__crossRoom='unexpected').catch(()=>window.__crossRoom='blocked')")
            assertEquals("\"blocked\"", waitFor(webView, "window.__crossRoom", "blocked"))
            assertEquals("\"undefined\"", evaluate(webView,
                "(()=>{const frame=document.createElement('iframe');frame.srcdoc='<p>隔离测试</p>';document.body.append(frame);return typeof frame.contentWindow.room})()"))
            evaluate(webView, "window.location.href='https://example.com'; 'tried'")
            Thread.sleep(300)
            assertTrue(evaluate(webView, "window.location.hostname").contains("roomillion.invalid"))
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun roomCannotPersistCookiesAcrossReopen() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("inventory.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val cookieName = "roomillion_probe_${System.nanoTime()}"
        val roomHost = MessageDigest.getInstance("SHA-256").digest(installed.id.toByteArray())
            .joinToString("") { "%02x".format(it) }.take(24)
        val origin = "https://r-$roomHost.roomillion.invalid"
        val cookies = CookieManager.getInstance()
        val cookieWritten = CountDownLatch(1)
        instrumentation.runOnMainSync {
            cookies.setAcceptCookie(true)
            cookies.setCookie(origin, "$cookieName=legacy; Path=/; Secure; SameSite=Lax") { cookieWritten.countDown() }
        }
        assertTrue(cookieWritten.await(10, TimeUnit.SECONDS))
        assertTrue("旧版 Cookie 应先存在", cookies.getCookie(origin).orEmpty().contains(cookieName))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            for (attempt in 0 until 40) {
                if (!cookies.getCookie(origin).orEmpty().contains(cookieName)) break
                Thread.sleep(250)
            }
            assertTrue("工作台启动时应清除旧版 Cookie", !cookies.getCookie(origin).orEmpty().contains(cookieName))
            repeat(2) { pass ->
                instrumentation.runOnMainSync {
                    val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("物资台账") } as Button?
                    assertNotNull(open)
                    open!!.performClick()
                }
                val webView = find(activity.window.decorView) { it is WebView } as WebView?
                assertNotNull(webView)
                waitFor(webView!!, "typeof window.room", "object")
                if (pass == 0) evaluate(webView, "document.cookie='$cookieName=secret; SameSite=Lax'; 'written'")
                assertTrue("房间不应读到持久 Cookie", !evaluate(webView, "document.cookie").contains(cookieName))
                instrumentation.runOnMainSync {
                    val back = find(activity.window.decorView) { it is Button && it.text.toString() == "返回房间列表" } as Button?
                    assertNotNull(back)
                    back!!.performClick()
                }
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun roomCannotRegisterPersistentServiceWorker() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("inventory.room").use { store.install(it) }
        File(installed.program, "sw.js").writeText("self.addEventListener('fetch', () => {})")
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("物资台账") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val webView = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(webView)
            waitFor(webView!!, "typeof window.room", "object")
            evaluate(webView, "window.__sw='pending';if(!navigator.serviceWorker)window.__sw='unavailable';else navigator.serviceWorker.register('/room/sw.js').then(r=>{window.__sw='registered';r.unregister()}).catch(()=>window.__sw='blocked')")
            for (attempt in 0 until 40) {
                if (evaluate(webView, "window.__sw") != "\"pending\"") break
                Thread.sleep(250)
            }
            assertTrue("房间不应注册跨重装持久的 Service Worker", evaluate(webView, "window.__sw") in setOf("\"blocked\"", "\"unavailable\""))
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun publicMeetingRoomUsesSeparateOriginAndDatabase() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("meeting-actions.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val button = find(activity.window.decorView) { it is Button && it.text.toString().contains("会议行动项") } as Button?
                assertNotNull(button)
                button!!.performClick()
            }
            val webView = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(webView)
            waitFor(webView!!, "typeof window.room", "object")
            evaluate(webView, "window.__identity='pending'; window.room.getInfo().then(x=>window.__identity=x.id).catch(e=>window.__identity='ERROR:'+e.message)")
            waitFor(webView, "window.__identity", "cn.zhibian.example.meeting-actions")
            evaluate(webView, "window.__tables='pending'; window.room.db.query(\"SELECT name FROM sqlite_master WHERE type='table' AND name='inventory'\").then(x=>window.__tables=String(x.length)).catch(e=>window.__tables='ERROR:'+e.message)")
            assertEquals("\"0\"", waitFor(webView, "window.__tables", "0"))
            assertTrue(evaluate(webView, "window.location.hostname").contains("roomillion.invalid"))
            val actionTitle = "安卓会议操作测试-${System.nanoTime()}"
            val actionTitleJs = JSONObject.quote(actionTitle)
            waitFor(webView, "document.querySelector('#actions .empty, #actions .action') !== null", "true")
            assertEquals("\"submitted\"", evaluate(webView, "(()=>{const f=document.getElementById('actionForm');f.elements.title.value=$actionTitleJs;f.elements.owner.value='测试员';f.elements.dueDate.value='2099-12-31';f.elements.priority.value='高';f.requestSubmit();return 'submitted'})()"))
            waitFor(webView, "[...document.querySelectorAll('#actions .action h3')].some(x=>x.textContent===$actionTitleJs)", "true")
            evaluate(webView, "[...document.querySelectorAll('#actions .action')].find(x=>x.querySelector('h3')?.textContent===$actionTitleJs).querySelector('.rowActions button').click()")
            waitFor(webView, "[...document.querySelectorAll('#actions .action.done h3')].some(x=>x.textContent===$actionTitleJs)", "true")
            evaluate(webView, "window.__actionRows='pending';window.room.db.query('SELECT status FROM meeting_actions WHERE title = ?',[$actionTitleJs]).then(x=>window.__actionRows=JSON.stringify(x)).catch(e=>window.__actionRows='ERROR:'+e.message)")
            assertTrue(waitFor(webView, "window.__actionRows", "done").contains("done"))
            evaluate(webView, "[...document.querySelectorAll('#actions .action')].find(x=>x.querySelector('h3')?.textContent===$actionTitleJs).querySelector('button.delete').click()")
            waitFor(webView, "[...document.querySelectorAll('#actions .action h3')].some(x=>x.textContent===$actionTitleJs)", "false")
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun hundredImportOpenAndCloseCyclesPreserveDataAndLeaveNoRoomViewAttached() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val initial = instrumentation.context.assets.open("inventory.room").use { store.install(it) }
        RoomPermissionStore(target).save(initial, RoomPermissionStore(target).requested(initial))
        initial.data.mkdirs()
        File(initial.data, "cycle-marker.txt").writeText("PERSISTENT")
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            repeat(100) { cycle ->
                val updated = instrumentation.context.assets.open("inventory.room").use { store.install(it) }
                assertEquals("第 ${cycle + 1} 次导入丢失私有数据", "PERSISTENT", File(updated.data, "cycle-marker.txt").readText())
                instrumentation.runOnMainSync {
                    val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("物资台账") } as Button?
                    assertNotNull("第 ${cycle + 1} 次打开缺少房间入口", open)
                    open!!.performClick()
                    assertNotNull("第 ${cycle + 1} 次打开缺少 WebView", find(activity.window.decorView) { it is WebView })
                    val back = find(activity.window.decorView) { it is Button && it.text.toString() == "返回房间列表" } as Button?
                    assertNotNull("第 ${cycle + 1} 次关闭缺少返回入口", back)
                    back!!.performClick()
                    assertTrue("第 ${cycle + 1} 次关闭后仍附着房间 WebView", find(activity.window.decorView) { it is WebView } == null)
                }
            }
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun aiDebateCanSeeTwoConfiguredModels() {
        val target = instrumentation.targetContext
        val models = AiModelStore(target)
        models.clear()
        models.saveProfile(null, "辩手甲", "https://one.example.test/v1/chat/completions", "model-one", "fake-one")
        models.saveProfile(null, "辩手乙", "https://two.example.test/v1/chat/completions", "model-two", "fake-two")
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("ai-debate.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val button = find(activity.window.decorView) { it is Button && it.text.toString().contains("AI 辩论场") } as Button?
                assertNotNull(button)
                button!!.performClick()
            }
            val webView = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(webView)
            waitFor(webView!!, "typeof window.room?.ai?.onModelsChanged", "function")
            evaluate(webView, "window.__imageDenied='pending';window.room.ai.generate('看图',{images:[{data:new Uint8Array([137,80,78,71,13,10,26,10])}]}).then(()=>window.__imageDenied='unexpected').catch(e=>window.__imageDenied=e.message)")
            waitFor(webView, "window.__imageDenied", "图片或音频 AI 权限")
            evaluate(webView, "window.__modelCount='pending'; window.room.ai.listModels().then(x=>window.__modelCount=String(x.length)).catch(e=>window.__modelCount='ERROR:'+e.message)")
            assertEquals("\"2\"", waitFor(webView, "window.__modelCount", "2"))
            evaluate(webView, "window.__keyLeak='pending'; window.room.ai.listModels().then(x=>window.__keyLeak=JSON.stringify(x).includes('fake-one')||JSON.stringify(x).includes('fake-two')?'LEAK':'safe')")
            assertEquals("\"safe\"", waitFor(webView, "window.__keyLeak", "safe"))
            assertEquals("2", waitFor(webView, "document.querySelectorAll('#positiveModel option').length", "2"))
            waitFor(webView, "document.getElementById('connectionLabel').textContent", "已连接 2 个可用模型")
            evaluate(webView, "window.__modelChanges=0;window.__pageMarker='retained';window.room.ai.onModelsChanged(()=>window.__modelChanges++)")
            waitForActivityFocus(activity)
            instrumentation.runOnMainSync {
                val switch = find(activity.window.decorView) { it is Button && it.text.toString() == "切换默认 AI" } as Button?
                assertNotNull(switch)
                switch!!.performClick()
            }
            instrumentation.waitForIdleSync()
            val picker = activity.activeRoomModelPicker
            assertNotNull("点击切换默认 AI 后应弹出模型选择器", picker)
            assertEquals("辩手乙 · model-two", picker!!.listView.adapter.getItem(1).toString())
            instrumentation.runOnMainSync {
                val list = picker.listView
                list.performItemClick(list.getChildAt(1) ?: View(activity), 1, list.adapter.getItemId(1))
            }
            assertEquals("\"1\"", waitFor(webView, "String(window.__modelChanges)", "1"))
            assertEquals("\"retained\"", evaluate(webView, "window.__pageMarker"))
            evaluate(webView, "window.__newDefault='pending';window.room.ai.listModels().then(x=>window.__newDefault=x.find(m=>m.isDefault)?.model||'none')")
            assertEquals("\"model-two\"", waitFor(webView, "window.__newDefault", "model-two"))
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            models.clear()
        }
    }

    @Test fun visionRoomStagesMediaAndRejectsContentMismatchBeforeNetwork() {
        val target = instrumentation.targetContext
        val models = AiModelStore(target)
        models.clear()
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("ai-model-benchmark.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("AI模型能力测试") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "typeof window.room?.ai?.generate", "function")
            evaluate(view, "window.__mediaResult='pending';window.room.ai.generate('看图',{images:[{data:new Uint8Array([137,80,78,71,13,10,26,10]),mimeType:'image/jpeg'}]}).then(()=>window.__mediaResult='unexpected').catch(e=>window.__mediaResult=e.message)")
            waitFor(view, "window.__mediaResult", "声明格式与文件内容不符")
            evaluate(view, "window.__largeMedia='pending';const bytes=new Uint8Array(1200000);bytes.set([137,80,78,71,13,10,26,10]);window.room.ai.generate('看图',{images:[{data:bytes,mimeType:'image/png'}]}).then(()=>window.__largeMedia='unexpected').catch(e=>window.__largeMedia=e.message)")
            waitFor(view, "window.__largeMedia", "请先在安卓工作台配置文本 AI 模型")
            evaluate(view, "window.__blobAi='pending';(async()=>{const page=await room.blobs.put({name:'page.png',mimeType:'image/png'},new Uint8Array([137,80,78,71,13,10,26,10]));try{await room.ai.generate('看图',{images:[{blobId:page.id}]});window.__blobAi='unexpected'}catch(e){window.__blobAi=e.message}finally{await room.blobs.remove(page.id)}})().catch(e=>window.__blobAi='ERROR:'+e.message)")
            waitFor(view, "window.__blobAi", "请先在安卓工作台配置文本 AI 模型")
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            models.clear()
        }
    }

    @Test fun audioRoomListsAudioModelAndStagesAudioWithoutExposingCredential() {
        val target = instrumentation.targetContext
        val models = AiModelStore(target)
        models.clear()
        models.saveProfile(null, "听写模型", "https://audio.example.test/v1/chat/completions", "audio-model", "audio-secret",
            supportsAudio = true)
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("audio-analysis.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("音频分析室") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "document.documentElement.dataset.roomReady", "true")
            assertEquals("\"1\"", waitFor(view, "String(document.querySelectorAll('#modelSelect option').length)", "1"))
            evaluate(view, "window.__audioResult='pending';window.room.ai.generate('听写',{audio:[{data:new Uint8Array([82,73,70,70,48,48,48,48,87,65,86,69]),mimeType:'audio/mpeg'}]}).then(()=>window.__audioResult='unexpected').catch(e=>window.__audioResult=e.message)")
            waitFor(view, "window.__audioResult", "声明格式与文件内容不符")
            assertEquals("false", evaluate(view, "document.documentElement.outerHTML.includes('audio-secret')"))
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            models.clear()
        }
    }

    @Test fun publicAudioRoomPicksFileAndExplainsAndroidMediaLimit() {
        val target = instrumentation.targetContext
        val models = AiModelStore(target)
        models.clear()
        models.saveProfile(null, "听写模型", "https://audio.example.test/v1/chat/completions", "audio-model", "fake-key",
            supportsAudio = true)
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("audio-analysis.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val created = mutableListOf<android.net.Uri>()
        fun audioFile(name: String, size: Int): android.net.Uri {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "audio/wav")
            }
            val uri = target.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("无法建立测试音频")
            target.contentResolver.openOutputStream(uri)?.use { output ->
                val header = byteArrayOf(82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69)
                output.write(header)
                val block = ByteArray(256 * 1024)
                var remaining = size - header.size
                while (remaining > 0) {
                    val count = minOf(block.size, remaining)
                    output.write(block, 0, count)
                    remaining -= count
                }
            } ?: error("无法写入测试音频")
            created.add(uri)
            return uri
        }
        val shortAudio = audioFile("roomillion-short.wav", 44)
        val longAudio = audioFile("roomillion-long.wav", 16 * 1024 * 1024 + 1)
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("音频分析室") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "document.documentElement.dataset.roomReady", "true")
            assertEquals("\"16777216\"", evaluate(view, "String(state.maxAudioBytes)"))
            fun pick(uri: android.net.Uri): Instrumentation.ActivityMonitor =
                instrumentation.addMonitor(IntentFilter(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); addDataType("*/*")
                }, Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(uri)), true)
            val first = pick(shortAudio)
            evaluate(view, "document.getElementById('pickButton').click()")
            waitFor(view, "document.getElementById('fileName').textContent", "roomillion-short.wav")
            assertTrue(first.hits > 0)
            assertEquals("false", evaluate(view, "document.getElementById('runButton').disabled"))
            instrumentation.removeMonitor(first)
            val second = pick(longAudio)
            evaluate(view, "document.getElementById('pickButton').click()")
            var limited = false
            for (attempt in 1..240) {
                if (evaluate(view, "document.getElementById('toast').textContent").contains("超过 16 MiB")) {
                    limited = true
                    break
                }
                Thread.sleep(250)
            }
            assertTrue("安卓音频房间应在大文件选择后显示真实模型上限", limited)
            assertTrue(second.hits > 0)
            assertEquals("\"roomillion-short.wav\"", evaluate(view, "document.getElementById('fileName').textContent"))
            instrumentation.removeMonitor(second)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            models.clear()
            for (uri in created) target.contentResolver.delete(uri, null, null)
        }
    }

    @Test fun realAiDebateUsesTwoConfiguredModelsWhenCredentialIsStaged() {
        val target = instrumentation.targetContext
        val keyFile = File(target.filesDir, ".real-ai-test-key")
        assumeTrue("真实模型测试须手动注入临时凭据", keyFile.isFile)
        val credential = keyFile.readText().trim()
        require(credential.startsWith("tp-") && credential.length in 12..20_000) { "真实测试凭据格式无效" }
        val models = AiModelStore(target)
        var activity: MainActivity? = null
        try {
            models.clear()
            val endpoint = "https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
            val positive = models.saveProfile(null, "MiMo 文本", endpoint, "mimo-v2.5", credential)
            val negative = models.saveProfile(null, "MiMo Pro", endpoint, "mimo-v2.5-pro", credential)
            val store = RoomPackageStore(File(target.filesDir, "rooms"))
            val installed = instrumentation.context.assets.open("ai-debate.room").use { store.install(it) }
            RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
            val current = instrumentation.startActivitySync(
                Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as MainActivity
            activity = current
            instrumentation.runOnMainSync {
                val open = find(current.window.decorView) { it is Button && it.text.toString().contains("AI 辩论场") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(current.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "document.querySelectorAll('#positiveModel option').length", "2")
            evaluate(view, "(()=>{const set=(id,value)=>{const element=document.getElementById(id);element.value=value;element.dispatchEvent(new Event('change'))};set('positiveModel',${JSONObject.quote(positive)});set('negativeModel',${JSONObject.quote(negative)});set('judgeModel',${JSONObject.quote(positive)});set('maxTurns','2');set('speechLength','200');const topic=document.getElementById('topicInput');topic.value='手机本地工具是否方便分享';topic.dispatchEvent(new Event('input'));document.getElementById('startButton').click()})()")
            var finished = false
            for (attempt in 1..240) {
                val status = evaluate(view, "document.getElementById('debateBadge').textContent")
                if (status.contains("已完成")) { finished = true; break }
                if (status.contains("已暂停") || status.contains("出现错误")) {
                    error("真实辩论未完成：$status；${evaluate(view, "document.getElementById('toast').textContent")}")
                }
                Thread.sleep(1000)
            }
            assertTrue("真实辩论应完成正反方和裁判三段调用", finished)
            assertEquals("3", evaluate(view, "document.querySelectorAll('#messages .message.positive,#messages .message.negative,#messages .message.judge').length"))
            evaluate(view, "window.__realProfiles='pending';room.db.query('SELECT role,profile_id FROM debate_messages WHERE debate_id=(SELECT MAX(id) FROM debates) ORDER BY sequence').then(rows=>{const ids=Object.fromEntries(rows.map(row=>[row.role,row.profile_id]));window.__realProfiles=ids.positive===${JSONObject.quote(positive)}&&ids.negative===${JSONObject.quote(negative)}&&ids.judge===${JSONObject.quote(positive)}?'ok':JSON.stringify(ids)}).catch(error=>window.__realProfiles=error.message)")
            assertEquals("\"ok\"", waitFor(view, "window.__realProfiles", "ok"))
            assertEquals("false", evaluate(view, "document.documentElement.outerHTML.includes(${JSONObject.quote(credential)})"))
        } finally {
            activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
            models.clear()
            keyFile.delete()
        }
    }

    @Test fun realAiButtonsWorkInInventoryAndMeetingRoomsWhenCredentialIsStaged() {
        val target = instrumentation.targetContext
        val keyFile = File(target.filesDir, ".real-ai-test-key")
        assumeTrue("真实模型测试须手动注入临时凭据", keyFile.isFile)
        val credential = keyFile.readText().trim()
        require(credential.startsWith("tp-") && credential.length in 12..20_000) { "真实测试凭据格式无效" }
        val models = AiModelStore(target)
        var activity: MainActivity? = null
        try {
            models.clear()
            models.saveProfile(null, "MiMo 文本", "https://token-plan-cn.xiaomimimo.com/v1/chat/completions", "mimo-v2.5", credential)
            val store = RoomPackageStore(File(target.filesDir, "rooms"))
            for (name in listOf("inventory", "meeting-actions")) {
                val installed = instrumentation.context.assets.open("$name.room").use { store.install(it) }
                RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
            }
            val current = instrumentation.startActivitySync(
                Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as MainActivity
            activity = current
            fun openRoom(label: String): WebView {
                instrumentation.runOnMainSync {
                    val button = find(current.window.decorView) { it is Button && it.text.toString().contains(label) } as Button?
                    assertNotNull(button)
                    button!!.performClick()
                }
                val view = find(current.window.decorView) { it is WebView } as WebView?
                assertNotNull(view)
                waitFor(view!!, "typeof window.room?.ai?.generate", "function")
                return view
            }
            fun waitForAi(view: WebView, successText: String): String {
                repeat(120) {
                    val status = evaluate(view, "document.getElementById('status').textContent")
                    if (status.contains(successText)) return status
                    if (status.contains("失败") || status.contains("错误") || status.contains("权限")) {
                        error("真实模型按钮调用失败：$status")
                    }
                    Thread.sleep(1000)
                }
                error("真实模型按钮超时：${evaluate(view, "document.getElementById('status').textContent")}")
            }
            val inventory = openRoom("物资台账")
            waitFor(inventory, "document.querySelector('#items .empty, #items .item') !== null", "true")
            val item = "安卓真实模型零库存-${System.nanoTime()}"
            evaluate(inventory, "(()=>{const f=document.getElementById('itemForm');f.elements.name.value=${JSONObject.quote(item)};f.elements.quantity.value='0';f.elements.note.value='需要补货';f.requestSubmit()})()")
            waitFor(inventory, "[...document.querySelectorAll('#items .item strong')].some(x=>x.textContent===${JSONObject.quote(item)})", "true")
            evaluate(inventory, "document.getElementById('aiButton').click()")
            assertTrue(waitForAi(inventory, "AI 分析完成").contains("mimo-v2.5"))
            assertEquals("true", evaluate(inventory, "!document.getElementById('output').hidden && document.getElementById('output').textContent.trim().length > 20"))
            assertEquals("false", evaluate(inventory, "document.documentElement.outerHTML.includes(${JSONObject.quote(credential)})"))
            instrumentation.runOnMainSync {
                val back = find(current.window.decorView) { it is Button && it.text.toString() == "返回房间列表" } as Button?
                assertNotNull(back)
                back!!.performClick()
            }
            val meeting = openRoom("会议行动项")
            waitFor(meeting, "document.querySelector('#actions .empty, #actions .action') !== null", "true")
            val task = "安卓真实模型逾期事项-${System.nanoTime()}"
            evaluate(meeting, "(()=>{const f=document.getElementById('actionForm');f.elements.title.value=${JSONObject.quote(task)};f.elements.owner.value='测试员';f.elements.dueDate.value='2000-01-01';f.elements.priority.value='高';f.requestSubmit()})()")
            waitFor(meeting, "[...document.querySelectorAll('#actions .action h3')].some(x=>x.textContent===${JSONObject.quote(task)})", "true")
            evaluate(meeting, "document.getElementById('aiButton').click()")
            assertTrue(waitForAi(meeting, "简报已生成").contains("mimo-v2.5"))
            assertEquals("true", evaluate(meeting, "!document.getElementById('brief').hidden && document.getElementById('briefText').textContent.trim().length > 20"))
            assertEquals("false", evaluate(meeting, "document.documentElement.outerHTML.includes(${JSONObject.quote(credential)})"))
        } finally {
            activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
            models.clear()
            keyFile.delete()
        }
    }

    @Test fun publicDocumentWorkbenchLoadsWordModulesAndPdfWorker() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("document-workbench.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("文档浏览与转换") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "typeof window.DocumentCore", "object")
            assertEquals("\"none\"", evaluate(view, "document.documentElement.dataset.roomError || 'none'"))
            val markdown = JSONObject.quote("# 标题\n正文")
            evaluate(view, "window.__wordProbe='pending';(async()=>{const bytes=await DocumentCore.markdownToDocx($markdown,'安卓测试');const html=await mammoth.convertToHtml({arrayBuffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});const preview=document.createElement('div');await docxPreview.renderAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),preview,null,{breakPages:true});window.__wordProbe=bytes.length>100&&html.value.includes('正文')&&preview.innerText.includes('正文')?'ok':JSON.stringify({bytes:bytes.length,html:html.value,preview:preview.innerText})})().catch(e=>window.__wordProbe=e.message)")
            assertEquals("\"ok\"", waitFor(view, "window.__wordProbe", "ok"))
            val pdf = android.util.Base64.encodeToString(
                instrumentation.context.assets.open("document-probe.pdf").use { it.readBytes() }, android.util.Base64.NO_WRAP)
            evaluate(view, "window.__pdfProbe='pending';(async()=>{const lib=await import(location.origin+'/_modules/document.pdf.view@1/pdf.min.mjs');lib.GlobalWorkerOptions.workerSrc=location.origin+'/_modules/document.pdf.view@1/pdf.worker.min.mjs';const bytes=Uint8Array.from(atob('$pdf'),c=>c.charCodeAt(0));const task=lib.getDocument({data:bytes,cMapUrl:location.origin+'/_modules/document.pdf.view@1/cmaps/',cMapPacked:true,standardFontDataUrl:location.origin+'/_modules/document.pdf.view@1/standard_fonts/',wasmUrl:location.origin+'/_modules/document.pdf.view@1/wasm/'});const doc=await task.promise;const page=await doc.getPage(1);const text=await page.getTextContent();window.__pdfProbe=text.items.map(x=>x.str).join(' ').includes('Android PDF sample')?'ok':'text missing';await task.destroy()})().catch(e=>window.__pdfProbe=e.message)")
            assertEquals("\"ok\"", waitFor(view, "window.__pdfProbe", "ok"))
            evaluate(view, "window.__generatedPdf='pending';(async()=>{const saved=await room.documents.markdownToPdf('# 安卓标题\\n中文正文',{title:'安卓标题',name:'安卓测试.pdf'});const head=await room.artifacts.read(saved.id,{offset:0,length:8});const signature=Array.from(head.data).map(x=>String.fromCharCode(x)).join('');const valid=saved.kind==='artifact'&&saved.mimeType==='application/pdf'&&saved.metadata.pages>=1&&signature.startsWith('%PDF-');await room.artifacts.remove(saved.id);window.__generatedPdf=valid?'ok':JSON.stringify({saved,signature})})().catch(e=>window.__generatedPdf='ERROR:'+e.message)")
            assertEquals("\"ok\"", waitFor(view, "window.__generatedPdf", "ok"))
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun publicDocumentWorkbenchOpensPdfAndConvertsMarkdownThroughSystemPickers() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("document-workbench.room").use { store.install(it) }
        RoomPermissionStore(target).save(installed, RoomPermissionStore(target).requested(installed))
        val created = mutableListOf<android.net.Uri>()
        fun mediaFile(name: String, mimeType: String, bytes: ByteArray): android.net.Uri {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
            }
            val uri = target.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("无法建立测试文档")
            target.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("无法写入测试文档")
            created.add(uri)
            return uri
        }
        val pdf = mediaFile("roomillion-android-probe.pdf", "application/pdf",
            instrumentation.context.assets.open("document-probe.pdf").use { it.readBytes() })
        val markdown = mediaFile("roomillion-android-probe.md", "text/markdown", "# 安卓标题\n正文内容".toByteArray())
        val exported = mediaFile("roomillion-android-export.pdf", "application/pdf", byteArrayOf(0))
        val word = mediaFile("roomillion-android-probe.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            instrumentation.context.assets.open("document-probe.docx").use { it.readBytes() })
        val sheet = mediaFile("roomillion-android-probe.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            instrumentation.context.assets.open("document-probe.xlsx").use { it.readBytes() })
        val slides = mediaFile("roomillion-android-probe.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            instrumentation.context.assets.open("document-probe.pptx").use { it.readBytes() })
        val exportedMarkdown = mediaFile("roomillion-android-word.md", "text/plain", byteArrayOf(0))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        fun picker(action: String, uri: android.net.Uri): Instrumentation.ActivityMonitor =
            instrumentation.addMonitor(IntentFilter(action).apply { addCategory(Intent.CATEGORY_OPENABLE); addDataType("*/*") },
                Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(uri)), true)
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("文档浏览与转换") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "typeof window.DocumentCore", "object")
            waitFor(view, "document.documentElement.dataset.roomReady", "true")
            val pdfPicker = picker(Intent.ACTION_OPEN_DOCUMENT, pdf)
            evaluate(view, "document.getElementById('openFile').click()")
            Thread.sleep(500)
            assertTrue("文件选择监视器未触发：${evaluate(view, "document.getElementById('readerStatus').textContent+'; busy='+document.getElementById('openFile').disabled")}", pdfPicker.hits > 0)
            waitFor(view, "document.getElementById('documentCount').textContent+' | '+document.getElementById('readerStatus').textContent", "1 |")
            waitFor(view, "document.querySelector('#preview canvas.pdfCanvas') !== null", "true")
            assertTrue(pdfPicker.hits > 0)
            instrumentation.removeMonitor(pdfPicker)
            val markdownPicker = picker(Intent.ACTION_OPEN_DOCUMENT, markdown)
            evaluate(view, "document.getElementById('openFile').click()")
            waitFor(view, "document.getElementById('documentCount').textContent+' | '+document.getElementById('readerStatus').textContent", "2 |")
            waitFor(view, "document.querySelector('#preview .paper')?.innerText.includes('正文内容')", "true")
            assertTrue(markdownPicker.hits > 0)
            instrumentation.removeMonitor(markdownPicker)
            val savePicker = picker(Intent.ACTION_CREATE_DOCUMENT, exported)
            evaluate(view, "(()=>{const select=document.getElementById('targetFormat');select.value='pdf';select.dispatchEvent(new Event('change'));document.getElementById('convertButton').click()})()")
            waitFor(view, "document.getElementById('readerStatus').textContent", "已保存")
            assertTrue(savePicker.hits > 0)
            val output = target.contentResolver.openInputStream(exported)?.use { it.readUpTo(8) } ?: byteArrayOf()
            assertTrue("转换文件应是 PDF", output.toString(Charsets.US_ASCII).startsWith("%PDF-"))
            instrumentation.removeMonitor(savePicker)
            waitFor(view, "!document.getElementById('openFile').disabled", "true")
            val wordPicker = picker(Intent.ACTION_OPEN_DOCUMENT, word)
            evaluate(view, "document.getElementById('openFile').click()")
            waitFor(view, "document.getElementById('documentCount').textContent", "3")
            waitFor(view, "document.getElementById('preview').innerText.includes('安卓 Word 中文正文')", "true")
            assertTrue(wordPicker.hits > 0)
            instrumentation.removeMonitor(wordPicker)
            val wordSave = picker(Intent.ACTION_CREATE_DOCUMENT, exportedMarkdown)
            evaluate(view, "(()=>{const select=document.getElementById('targetFormat');select.value='md';select.dispatchEvent(new Event('change'));document.getElementById('convertButton').click()})()")
            waitFor(view, "document.getElementById('readerStatus').textContent", "已保存")
            assertTrue(wordSave.hits > 0)
            assertTrue(target.contentResolver.openInputStream(exportedMarkdown)?.use {
                it.readBytes().toString(Charsets.UTF_8).contains("安卓 Word 中文正文")
            } == true)
            instrumentation.removeMonitor(wordSave)
            waitFor(view, "!document.getElementById('openFile').disabled", "true")
            val sheetPicker = picker(Intent.ACTION_OPEN_DOCUMENT, sheet)
            evaluate(view, "document.getElementById('openFile').click()")
            waitFor(view, "document.getElementById('documentCount').textContent", "4")
            waitFor(view, "document.getElementById('preview').innerText.includes('安卓表格')", "true")
            assertTrue(sheetPicker.hits > 0)
            instrumentation.removeMonitor(sheetPicker)
            evaluate(view, "(()=>{const select=document.getElementById('sheetPicker');select.value='1';select.dispatchEvent(new Event('change'))})()")
            waitFor(view, "document.getElementById('preview').innerText.includes('表格切换成功')", "true")
            waitFor(view, "!document.getElementById('openFile').disabled", "true")
            val slidesPicker = picker(Intent.ACTION_OPEN_DOCUMENT, slides)
            evaluate(view, "document.getElementById('openFile').click()")
            waitFor(view, "document.getElementById('documentCount').textContent", "5")
            waitFor(view, "document.getElementById('preview').innerText.includes('安卓幻灯片第一页')", "true")
            assertTrue(slidesPicker.hits > 0)
            instrumentation.removeMonitor(slidesPicker)
            evaluate(view, "document.getElementById('nextPage').click()")
            waitFor(view, "document.getElementById('preview').innerText.includes('安卓幻灯片第二页')", "true")
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            for (uri in created) target.contentResolver.delete(uri, null, null)
        }
    }

    @Test fun declaredOfflineModulesLoadAndUnlistedModulesStayDenied() {
        val target = instrumentation.targetContext
        val id = "cn.zhibian.android.module-probe"
        val home = File(target.filesDir, "rooms/$id")
        val program = File(home, "program")
        val app = File(program, "app")
        app.mkdirs()
        val modules = listOf("data.date@1", "data.decimal@1", "data.csv@1", "data.search@1",
            "ui.chart@1", "security.sanitize@1", "document.markdown@1", "archive.zip@1",
            "utility.qrcode@1", "document.spreadsheet@1")
        val manifest = JSONObject().put("formatVersion", "0.1").put("id", id).put("name", "安卓模块测试")
            .put("version", "1.0.0").put("entry", "app/index.html")
            .put("runtime", JSONObject().put("roomSdk", "1"))
            .put("permissions", JSONObject().put("database", "private"))
            .put("hostModules", JSONArray(modules))
        File(program, "manifest.json").writeText(manifest.toString())
        File(app, "index.html").writeText("""<!doctype html><meta charset="utf-8">
            <script src="/_modules/data.date@1/dayjs.min.js"></script>
            <script src="/_modules/data.decimal@1/decimal.js"></script>
            <script src="/_modules/data.csv@1/papaparse.min.js"></script>
            <script src="/_modules/ui.chart@1/chart.umd.js"></script>
            <script src="/_modules/security.sanitize@1/purify.min.js"></script>
            <script src="/_modules/document.markdown@1/marked.umd.js"></script>
            <script src="/_modules/archive.zip@1/jszip.min.js"></script>
            <script src="/_modules/utility.qrcode@1/qrcode.min.js"></script>
            <script src="/_modules/document.spreadsheet@1/xlsx.full.min.js"></script>
            <script type="module" src="main.mjs"></script>
            <body>模块测试</body>""")
        File(app, "main.mjs").writeText("import Fuse from '/_modules/data.search@1/fuse.min.mjs'; window.__Fuse = Fuse; window.__moduleReady = 'ready';")
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("安卓模块测试") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "window.__moduleReady", "ready")
            assertEquals("\"function:function:object:function:function:object:function:function:object:object\"",
                evaluate(view, "[dayjs,Decimal,Papa,Chart,DOMPurify,marked,JSZip,window.__Fuse,QRCode,XLSX].map(x=>typeof x).join(':')"))
            evaluate(view, "window.__qr='pending';QRCode.toDataURL('千万间').then(data=>window.__qr=data.startsWith('data:image/png;base64,')?'png':'wrong').catch(e=>window.__qr=e.message)")
            assertEquals("\"png\"", waitFor(view, "window.__qr", "png"))
            evaluate(view, "window.__xlsx='pending';try{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['项目','数量'],['安卓',2]]),'数据');const bytes=XLSX.write(book,{type:'array',bookType:'xlsx'});const copy=XLSX.read(bytes,{type:'array'});const rows=XLSX.utils.sheet_to_json(copy.Sheets['数据'],{header:1});window.__xlsx=bytes.byteLength>100&&new Uint8Array(bytes)[0]===80&&rows[1][0]==='安卓'&&rows[1][1]===2?'ok':JSON.stringify({bytesLength:bytes.byteLength,rows})}catch(e){window.__xlsx=e.message}")
            assertEquals("\"ok\"", waitFor(view, "window.__xlsx", "ok"))
            evaluate(view, "window.__missing='pending'; fetch('/_modules/physics.rapier@1/rapier.min.js').then(r=>window.__missing=String(r.status))")
            assertEquals("\"403\"", waitFor(view, "window.__missing", "403"))
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            home.deleteRecursively()
        }
    }

    @Test fun roomWithoutPrivateDatabaseCannotReadOrCreateBlobs() {
        val target = instrumentation.targetContext
        val id = "cn.zhibian.android.blob-denied"
        val home = File(target.filesDir, "rooms/$id")
        val program = File(home, "program")
        val app = File(program, "app")
        app.mkdirs()
        val manifest = JSONObject().put("formatVersion", "0.1").put("id", id).put("name", "附件权限测试")
            .put("version", "1.0.0").put("entry", "app/index.html")
            .put("runtime", JSONObject().put("roomSdk", "1"))
            .put("permissions", JSONObject())
        File(program, "manifest.json").writeText(manifest.toString())
        File(app, "index.html").writeText("<!doctype html><meta charset=\"utf-8\"><body>附件权限测试</body>")
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("附件权限测试") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            waitFor(view!!, "typeof room.blobs.list", "function")
            evaluate(view, "window.__blobDenied='pending';Promise.all([room.blobs.list().then(()=>false,e=>e.message.includes('私有数据权限')),room.artifacts.begin('secret.bin').then(()=>false,e=>e.message.includes('私有数据权限')),room.documents.markdownToPdf('# secret').then(()=>false,e=>e.message.includes('私有数据权限'))]).then(x=>window.__blobDenied=x.every(Boolean)?'denied':'unexpected')")
            assertEquals("\"denied\"", waitFor(view, "window.__blobDenied", "denied"))
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            home.deleteRecursively()
        }
    }

    @Test fun roomWithoutUserGrantCannotUseWorkbenchAi() {
        val target = instrumentation.targetContext
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val installed = instrumentation.context.assets.open("ai-debate.room").use { store.install(it) }
        RoomPermissionStore(target).revoke(installed)
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            waitForActivityFocus(activity)
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("AI 辩论场") } as Button?
                assertNotNull(open)
                open!!.performClick()
                assertTrue(find(activity.window.decorView) { it is WebView } == null)
            }
            instrumentation.waitForIdleSync()
            clickActiveWindowText("暂不授权")
            val view = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(view)
            assertTrue(find(activity.window.decorView) { it is Button && it.text.toString() == "切换默认 AI" } == null)
            waitFor(view!!, "typeof window.room?.ai?.listModels", "function")
            evaluate(view, "window.__grant='pending'; window.room.ai.listModels().then(()=>window.__grant='unexpected').catch(e=>window.__grant=e.message)")
            waitFor(view, "window.__grant", "没有 AI 权限")
            assertTrue(!RoomPermissionStore(target).read(installed)!!.ai)
            instrumentation.runOnMainSync {
                val back = find(activity.window.decorView) { it is Button && it.text.toString() == "返回房间列表" } as Button?
                assertNotNull(back)
                back!!.performClick()
            }
            waitForActivityFocus(activity)
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("AI 辩论场") } as Button?
                assertNotNull(open)
                val permission = find(open!!.parent as View) { it is Button && it.text.toString() == "权限" } as Button?
                assertNotNull(permission)
                permission!!.performClick()
            }
            instrumentation.waitForIdleSync()
            clickActiveWindowText("使用工作台文本 AI")
            clickActiveWindowText("保存")
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("AI 辩论场") } as Button?
                assertNotNull(open)
                open!!.performClick()
            }
            val authorized = find(activity.window.decorView) { it is WebView } as WebView?
            assertNotNull(authorized)
            waitFor(authorized!!, "typeof window.room?.ai?.listModels", "function")
            evaluate(authorized, "window.__authorized='pending'; window.room.ai.listModels().then(x=>window.__authorized=Array.isArray(x)?'yes':'bad').catch(e=>window.__authorized=e.message)")
            assertEquals("\"yes\"", waitFor(authorized, "window.__authorized", "yes"))
            assertTrue(RoomPermissionStore(target).read(installed)!!.ai)
            assertTrue(!RoomPermissionStore(target).read(installed)!!.export)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            RoomPermissionStore(target).revoke(installed)
        }
    }

    @Test fun uninstallFromWorkbenchRemovesRoomDataAndPreviousGrant() {
        val target = instrumentation.targetContext
        val id = "cn.zhibian.android.uninstall-probe"
        val home = File(target.filesDir, "rooms/$id")
        val program = File(home, "program")
        val app = File(program, "app")
        app.mkdirs()
        val manifest = JSONObject().put("formatVersion", "0.1").put("id", id).put("name", "卸载测试房间")
            .put("version", "1.0.0").put("entry", "app/index.html")
            .put("runtime", JSONObject().put("roomSdk", "1"))
            .put("permissions", JSONObject().put("ai", JSONObject().put("roles", JSONArray().put("general"))))
        File(program, "manifest.json").writeText(manifest.toString())
        File(app, "index.html").writeText("<!doctype html><meta charset=\"utf-8\"><body>卸载测试房间</body>")
        File(home, "data/private.txt").apply { parentFile?.mkdirs(); writeText("private") }
        val store = RoomPackageStore(File(target.filesDir, "rooms"))
        val permissions = RoomPermissionStore(target)
        val installed = store.readInstalled(id)
        permissions.save(installed, RoomGrants(ai = true))
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            instrumentation.runOnMainSync {
                val open = find(activity.window.decorView) { it is Button && it.text.toString().contains("卸载测试房间") } as Button?
                assertNotNull(open)
                val uninstall = find(open!!.parent as View) { it is Button && it.text.toString() == "卸载" } as Button?
                assertNotNull(uninstall)
                uninstall!!.performClick()
            }
            instrumentation.waitForIdleSync()
            clickActiveWindowText("卸载并删除数据")
            var removed = false
            repeat(40) {
                if (!home.exists()) { removed = true; return@repeat }
                Thread.sleep(100)
            }
            assertTrue("卸载后房间和私有数据应消失", removed)
            assertTrue(permissions.read(installed) == null)
            app.mkdirs()
            File(program, "manifest.json").writeText(manifest.toString())
            File(app, "index.html").writeText("<!doctype html><meta charset=\"utf-8\"><body>卸载测试房间</body>")
            assertTrue("重新安装不应继承旧授权", permissions.read(store.readInstalled(id)) == null)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            home.deleteRecursively()
        }
    }
}
