package io.roomillion.android

import android.content.Intent
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class RoomAgentTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private class Fixture(val root: File){
        val id="io.roomillion.test.agent";val source=File(root,"source");val store=RoomPackageStore(File(root,"rooms"))
        init {
            File(source,"app").mkdirs()
            File(source,"manifest.json").writeText(JSONObject().put("formatVersion","0.1").put("id",id).put("name","修改测试").put("version","1.0.0").put("entry","app/index.html").put("runtime",JSONObject().put("roomSdk","1")).put("permissions",JSONObject().put("database","private")).toString())
            File(source,"app/index.html").writeText("<!doctype html><html><body><button id='go'>计算</button><p id='out'></p><script src='main.js'></script></body></html>")
            File(source,"app/main.js").writeText("document.querySelector('#go').onclick=()=>document.querySelector('#out').textContent='原版';")
            val archive=File(root,"initial.room");RoomAgentWorkspace.pack(source,archive);archive.inputStream().use{store.install(it)}
            store.readInstalled(id).data.mkdirs();File(store.readInstalled(id).data,"keep.txt").writeText("用户数据")
        }
        fun workspace(dir: File=File(root,"draft-session"))=RoomAgentWorkspace(dir,store,id)
    }
    private fun fixture()=Fixture(File(context.cacheDir,"agent-test-${System.nanoTime()}").apply {mkdirs()})
    private fun edit(ws: RoomAgentWorkspace,id: String="edit",revision: Int=ws.inspect().getInt("revision"),text: String="修改后")=ws.tool(id,"write_file",JSONObject().put("path","app/main.js").put("revision",revision).put("text","document.querySelector('#go').onclick=()=>document.querySelector('#out').textContent='$text';")){_,_->error("非源码工具")}
    @Test fun repeatedEditsAreRevisionedDeduplicatedTestedAndPreserveData(){val f=fixture();try{
        val ws=f.workspace();val first=edit(ws);assertEquals(1,first.getInt("revision"));assertEquals(first.toString(),edit(ws,revision=0).toString())
        assertTrue(runCatching {edit(ws,"stale",0)}.isFailure)
        assertTrue(runCatching {ws.install()}.isFailure)
        ws.recordTest(JSONObject().put("passed",true));ws.install();assertEquals("1.0.1",f.store.readInstalled(f.id).version)
        edit(ws,"next",text="第二版");ws.recordTest(JSONObject().put("passed",true));ws.install();assertEquals("1.0.2",f.store.readInstalled(f.id).version)
        ws.rollback();assertEquals("1.0.1",f.store.readInstalled(f.id).version)
        assertEquals("用户数据",File(f.store.readInstalled(f.id).data,"keep.txt").readText())
        assertEquals(0,ws.program.walkTopDown().filter{it.name=="keep.txt"}.count())
    }finally{f.root.deleteRecursively()}}
    @Test fun testResultIsInvalidatedByLaterEditAndExternalUpdate(){val f=fixture();try{
        val ws=f.workspace();edit(ws);ws.recordTest(JSONObject().put("passed",true));edit(ws,"next",text="第二版");assertTrue(runCatching {ws.install()}.isFailure)
        ws.recordTest(JSONObject().put("passed",true));File(f.store.readInstalled(f.id).program,"app/main.js").appendText("//外部更新")
        assertTrue(runCatching {ws.install()}.isFailure)
    }finally{f.root.deleteRecursively()}}
    @Test fun sourceToolsRejectSystemPathsLinksAndPermissionEscalation(){val f=fixture();try{
        val ws=f.workspace()
        for(path in listOf("../keep.txt","data/keep.txt","/etc/passwd","app/../manifest.json","app/native.so"))assertTrue(path,runCatching{ws.tool("bad_${path.hashCode().toUInt()}","write_file",JSONObject().put("path",path).put("text","bad").put("revision",0)){_,_->JSONObject()}}.isFailure)
        java.nio.file.Files.createSymbolicLink(File(ws.program,"app/link.js").toPath(),File(f.root,"outside.txt").toPath());assertTrue(runCatching{ws.read(JSONObject().put("path","app/link.js"))}.isFailure);File(ws.program,"app/link.js").delete()
        val m=ws.manifest().put("permissions",JSONObject().put("database","private").put("ai",JSONObject().put("roles",JSONArray().put("text"))))
        ws.tool("permission","write_file",JSONObject().put("path","manifest.json").put("revision",0).put("text",m.toString())){_,_->JSONObject()}
        ws.recordTest(JSONObject().put("passed",true));assertTrue(runCatching{ws.install()}.isFailure);ws.install(true)
    }finally{f.root.deleteRecursively()}}
    @Test fun sessionAndToolJournalSurviveReopen(){val f=fixture();try{
        val ws=f.workspace();edit(ws);ws.saveConversation(JSONObject().put("messages",JSONArray().put(JSONObject().put("role","user").put("content","增加搜索"))).put("running",true))
        val reopened=f.workspace();assertTrue(reopened.load().getBoolean("interrupted"));assertEquals("增加搜索",reopened.load().getJSONArray("messages").getJSONObject(0).getString("content"));assertEquals(1,edit(reopened,revision=0).getInt("revision"))
    }finally{f.root.deleteRecursively()}}
    @Test fun restartingPreservesOldDraftAndCopiesExternallyUpdatedProgram(){val f=fixture();try{
        val ws=f.workspace();edit(ws);File(f.store.readInstalled(f.id).program,"app/main.js").appendText("//外部更新")
        ws.restart();assertFalse(ws.inspect().getBoolean("dirty"));assertTrue(File(ws.program,"app/main.js").readText().contains("外部更新"));assertEquals(1,File(f.root,"draft-session/history").listFiles()!!.size);assertEquals("用户数据",File(f.store.readInstalled(f.id).data,"keep.txt").readText())
        assertEquals(3,edit(ws,revision=2).getInt("revision"))
    }finally{f.root.deleteRecursively()}}
    @Test fun permissionsRecoverWhenProcessStopsBetweenProgramAndGrantReplacement(){val f=fixture();val permissions=RoomPermissionStore(context);try{
        val original=File(f.store.readInstalled(f.id).program,"manifest.json");original.writeText(JSONObject(original.readText()).put("permissions",JSONObject().put("database","private").put("ai",JSONObject().put("roles",JSONArray().put("text")))).toString())
        permissions.save(f.store.readInstalled(f.id),RoomGrants(ai=true))
        val ws=f.workspace();edit(ws);ws.recordTest(JSONObject().put("passed",true));ws.checkpointPermissions(permissions);ws.install()
        assertNull(permissions.read(f.store.readInstalled(f.id)))
        val reopened=f.workspace();reopened.publishPermissions(permissions);assertTrue(permissions.read(f.store.readInstalled(f.id))!!.ai)
        assertTrue(reopened.install().getBoolean("applied"))
    }finally{permissions.revoke(f.store.readInstalled(f.id));f.root.deleteRecursively()}}
    @Test fun gatewayPreservesToolHistoryAndNeverExposesKeys(){
        val models=AiModelStore(context);val profile=models.saveProfile(null,"Agent测试","https://example.invalid/v1/chat/completions","tools-test","secret-for-test")
        val output=java.io.ByteArrayOutputStream()
        val connection=object:HttpURLConnection(URL("https://example.invalid")){
            override fun connect(){};override fun disconnect(){};override fun usingProxy()=false
            override fun getOutputStream()=output;override fun getResponseCode()=200
            override fun getInputStream()=java.io.ByteArrayInputStream("""{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_a","function":{"name":"inspect_room","arguments":"{}"}}]}}]}""".toByteArray())
        }
        try{
            val messages=JSONArray().put(JSONObject().put("role","user").put("content","修改"))
                .put(JSONObject().put("role","assistant").put("tool_calls",JSONArray().put(JSONObject().put("id","old").put("type","function").put("function",JSONObject().put("name","inspect_room").put("arguments","{}")))))
                .put(JSONObject().put("role","tool").put("tool_call_id","old").put("content","修订1"))
            val result=RoomAgentGateway(models,{connection}).complete(JSONObject().put("profileId",profile).put("messages",messages).put("tools",JSONArray()),AiRequestCancellation())
            assertEquals("inspect_room",result.getJSONArray("toolCalls").getJSONObject(0).getString("name"));assertFalse(result.toString().contains("secret-for-test"));assertEquals(messages.toString(),JSONObject(output.toString("UTF-8")).getJSONArray("messages").toString())
            assertTrue(runCatching{RoomAgentGateway.normalize(JSONObject("""{"choices":[{"message":{"tool_calls":[{"function":{"name":"write_file","arguments":"{"}}]}}]}"""))}.isFailure)
            val token=AiRequestCancellation();token.cancel();assertTrue(runCatching{RoomAgentGateway(models,{connection}).complete(JSONObject(),token)}.isFailure)
        }finally{models.remove(profile)}
    }
    @Test fun gatewayDeadlineDisconnectsSlowResponseAndSanitizesProviderErrors(){
        val models=AiModelStore(context);val profile=models.saveProfile(null,"超时测试","https://example.invalid/v1/chat/completions","tools-test","secret-for-test")
        val released=CountDownLatch(1)
        val connection=object:HttpURLConnection(URL("https://example.invalid")){
            override fun connect(){};override fun disconnect(){released.countDown()};override fun usingProxy()=false
            override fun getOutputStream()=java.io.ByteArrayOutputStream()
            override fun getResponseCode():Int{released.await(3,TimeUnit.SECONDS);throw java.io.IOException("secret-for-test")}
        }
        try{
            val args=JSONObject().put("profileId",profile).put("messages",JSONArray().put(JSONObject().put("role","user").put("content","修改"))).put("tools",JSONArray())
            val error=runCatching{RoomAgentGateway(models,{connection},100).complete(args,AiRequestCancellation())}.exceptionOrNull()
            assertNotNull(error);assertTrue(error!!.message!!.contains("超时"));assertFalse(error.message!!.contains("secret-for-test"));assertEquals(0L,released.count)
        }finally{models.remove(profile)}
    }
    @Test fun incompleteWriteJournalRestoresCheckpointBeforeResuming(){val f=fixture();try{
        val directory=File(f.root,"draft-session");val ws=f.workspace();val undo=JSONObject().put("path","app/main.js").put("exists",true).put("text",File(ws.program,"app/main.js").readText()).put("manifest",ws.manifest().toString()).put("revision",0).put("dirty",false).put("test",JSONObject.NULL)
        edit(ws);val call=File(directory,"calls/edit.json");val record=JSONObject(call.readText()).put("status","running").put("undo",undo);record.remove("result");RoomAgentWorkspace.atomic(call,record.toString())
        val recovered=f.workspace();assertEquals(0,recovered.inspect().getInt("revision"));assertTrue(File(recovered.program,"app/main.js").readText().contains("原版"));assertEquals(1,edit(recovered,revision=0).getInt("revision"))
    }finally{f.root.deleteRecursively()}}
    private fun evaluate(view:WebView,code:String):String{val latch=CountDownLatch(1);var value="";instrumentation.runOnMainSync{view.evaluateJavascript(code){value=it;latch.countDown()}};assertTrue(latch.await(10,TimeUnit.SECONDS));return value}
    private fun waitFor(view:WebView,code:String,expected:String){repeat(240){if(evaluate(view,code).contains(expected))return;Thread.sleep(250)};error("期望$expected；实际 ${evaluate(view,"document.body.innerText")}")}
    @Test fun actualPiEditorHandlesMultipleAdjustmentsRetryResumeValidationAndRollback(){
        val f=fixture();val models=AiModelStore(context);val profile=models.saveProfile(null,"Agent界面测试","https://example.invalid/v1/chat/completions","tools-test","")
        val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        var view:RoomAgentView?=null;var count=0;var failOnce=true;var interrupt=false;val entered=CountDownLatch(1)
        val sessionDir=File(context.filesDir,"room-agent/${f.id}")
        fun response(args:JSONObject,cancel:AiRequestCancellation):JSONObject{
            val history=args.getJSONArray("messages");val last=history.getJSONObject(history.length()-1)
            if(failOnce){failOnce=false;error("测试网络暂时失败")}
            if(interrupt && last.optString("role")=="tool" && last.optString("content").contains("\"changed\":true")){entered.countDown();while(!cancel.isCancelled)Thread.sleep(25);cancel.check()}
            val tool=when{
                last.optString("role")=="user"->"inspect_room"
                last.optString("role")=="tool" && last.getString("content").contains("\"files\"")->"write_file"
                last.optString("role")=="tool" && last.getString("content").contains("\"changed\":true")->"test_room"
                last.optString("role")=="tool" && last.getString("content").contains("\"passed\":true")->"apply_room"
                else->""
            }
            val generation=(0 until history.length()).count{history.getJSONObject(it).optString("role")=="user"}
            val parameters=when(tool){
                "write_file"->JSONObject().put("path","app/main.js").put("revision",JSONObject(last.getString("content")).getInt("revision")).put("text","document.querySelector('#go').onclick=()=>document.querySelector('#out').textContent='第${generation}版';")
                "test_room"->JSONObject().put("actions",JSONArray().put(JSONObject().put("type","click").put("selector","#go")).put(JSONObject().put("type","assert_text").put("selector","#out").put("text","第${generation}版")))
                else->JSONObject()
            }
            return JSONObject().put("text",if(tool.isEmpty())"已经完成第${generation}轮"else"").put("toolCalls",JSONArray().apply{if(tool.isNotEmpty())put(JSONObject().put("id","web_${++count}").put("name",tool).put("arguments",parameters.toString()))}).put("usage",JSONObject())
        }
        fun open(){instrumentation.runOnMainSync{view=RoomAgentView(activity,f.store,models,RoomPermissionStore(context),f.id,::response);activity.setContentView(view!!.webView)};waitFor(view!!.webView,"document.querySelector('#status').textContent","说明你想修改");evaluate(view!!.webView,"document.querySelector('#model').value=${JSONObject.quote(profile)}")}
        fun send(text:String){evaluate(view!!.webView,"document.querySelector('#prompt').value=${JSONObject.quote(text)};document.querySelector('#send').click()")}
        try{
            open();assertEquals("\"undefined\"",evaluate(view!!.webView,"typeof RoomillionNative"))
            send("按钮改成第一版");waitFor(view!!.webView,"document.querySelector('#messages').textContent","已经完成第1轮");waitFor(view!!.webView,"document.querySelector('#send').disabled","false");assertEquals("1.0.1",f.store.readInstalled(f.id).version)
            send("再改成第二版");waitFor(view!!.webView,"document.querySelector('#messages').textContent","已经完成第2轮");waitFor(view!!.webView,"document.querySelector('#send').disabled","false");assertEquals("1.0.2",f.store.readInstalled(f.id).version)
            interrupt=true;send("再改成第三版");assertTrue("第三次写入应完成后中断",entered.await(30,TimeUnit.SECONDS));instrumentation.runOnMainSync{view!!.close()};interrupt=false
            instrumentation.runOnMainSync{view=RoomAgentView(activity,f.store,models,RoomPermissionStore(context),f.id,::response);activity.setContentView(view!!.webView)}
            waitFor(view!!.webView,"document.querySelector('#status').textContent","已恢复对话");evaluate(view!!.webView,"document.querySelector('#continue').click()")
            waitFor(view!!.webView,"document.querySelector('#messages').textContent","已经完成第3轮");waitFor(view!!.webView,"document.querySelector('#send').disabled","false");assertEquals("1.0.3",f.store.readInstalled(f.id).version)
            evaluate(view!!.webView,"document.querySelector('#rollback').click()");waitFor(view!!.webView,"document.querySelector('#status').textContent","restored");assertEquals("1.0.2",f.store.readInstalled(f.id).version)
            waitFor(view!!.webView,"document.querySelector('#send').disabled","false")
            evaluate(view!!.webView,"document.querySelector('#restart').click()")
            Thread.sleep(350);assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
            waitFor(view!!.webView,"document.querySelector('#status').textContent","已取消重建");waitFor(view!!.webView,"document.querySelector('#send').disabled","false")
            assertEquals("用户数据",File(f.store.readInstalled(f.id).data,"keep.txt").readText())
        }finally{instrumentation.runOnMainSync{view?.close();activity.finish()};models.remove(profile);sessionDir.deleteRecursively();f.root.deleteRecursively()}
    }
    @Test fun validatorDetectsBrokenButtonsAndUsesIndependentProcess(){val f=fixture();val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity;val pendingImport=File(context.cacheDir,"room-import-agent-sentinel.room").apply{writeText("其他正在导入的文件")};try{
        val ws=f.workspace();val scenario=JSONObject().put("actions",JSONArray().put(JSONObject().put("type","click").put("selector","#go")).put(JSONObject().put("type","assert_text").put("selector","#out").put("text","原版")))
        val valid=activity.validateAgentDraft(ws,scenario);assertTrue(valid.toString(),valid.getBoolean("passed"))
        assertTrue("测试进程不得清理宿主正在导入的文件",pendingImport.isFile)
        edit(ws,text="错误结果");assertFalse(activity.validateAgentDraft(ws,scenario).getBoolean("passed"))
        ws.tool("crash","write_file",JSONObject().put("path","app/main.js").put("revision",ws.inspect().getInt("revision")).put("text","document.querySelector('#go').onclick=()=>{throw Error('按钮异常')};")){_,_->JSONObject()}
        assertFalse(activity.validateAgentDraft(ws,scenario).getBoolean("passed"));assertTrue(runCatching{ws.install()}.isFailure)
        ws.tool("loop","write_file",JSONObject().put("path","app/main.js").put("revision",ws.inspect().getInt("revision")).put("text","document.querySelector('#go').onclick=()=>{while(true){}};")){_,_->JSONObject()}
        assertFalse(activity.validateAgentDraft(ws,scenario).getBoolean("passed"));assertFalse(activity.isDestroyed)
    }finally{pendingImport.delete();instrumentation.runOnMainSync{activity.finish()};f.root.deleteRecursively()}}
    @Test fun realAiModifiesAndRevisesRoomWhenCredentialIsStaged(){
        val keyFile=File(context.filesDir,".real-ai-test-key")
        org.junit.Assume.assumeTrue("仅在专用模拟器明确暂存真实测试凭据时运行",keyFile.isFile)
        val credential=keyFile.readText().trim();require(credential.startsWith("tp-"))
        val f=fixture();val models=AiModelStore(context);val profile=models.saveProfile(null,"真实修改烟测","https://token-plan-cn.xiaomimimo.com/v1/chat/completions","mimo-v2.5",credential)
        val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        var view:RoomAgentView?=null
        fun send(text:String){evaluate(view!!.webView,"document.querySelector('#prompt').value=${JSONObject.quote(text)};document.querySelector('#send').click()")}
        fun awaitVersion(version:String){repeat(2400){if(f.store.readInstalled(f.id).version==version)return;if(it>10 && evaluate(view!!.webView,"document.querySelector('#send').disabled")=="false")error("AI 未完成更新：${evaluate(view!!.webView,"document.body.innerText")}");Thread.sleep(250)};error("真实模型修改超时")}
        try{
            instrumentation.runOnMainSync{view=RoomAgentView(activity,f.store,models,RoomPermissionStore(context),f.id);activity.setContentView(view!!.webView)}
            waitFor(view!!.webView,"document.querySelector('#status')?.textContent","说明你想修改");evaluate(view!!.webView,"document.querySelector('#model').value=${JSONObject.quote(profile)}")
            send("请修改这个已安装房间：保留计算按钮及 #out，点击 #go 后 #out 显示‘你好安卓’。读取源码后直接改，不要提问。用 test_room 实际点击按钮并断言文本，测试通过后调用 apply_room 应用更新。")
            awaitVersion("1.0.1");waitFor(view!!.webView,"document.querySelector('#send').disabled","false")
            send("继续修改刚才的房间：点计算按钮后改为显示‘第二轮成功’。保留按钮及 #out，不改变权限。再次读取实际代码、修改、点击测试并断言，然后应用更新。")
            awaitVersion("1.0.2");assertEquals("用户数据",File(f.store.readInstalled(f.id).data,"keep.txt").readText())
            assertEquals("false",evaluate(view!!.webView,"document.documentElement.outerHTML.includes(${JSONObject.quote(credential)})"))
        }finally{instrumentation.runOnMainSync{view?.close();activity.finish()};models.remove(profile);File(context.filesDir,"room-agent/${f.id}").deleteRecursively();f.root.deleteRecursively()}
    }
    @Test fun validatorMocksAiButDoesNotGrantUndeclaredPermissions(){
        val f=fixture();val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try{
            val ws=f.workspace()
            ws.tool("mock_button","write_file",JSONObject().put("path","app/main.js").put("revision",0).put("text","document.querySelector('#go').onclick=()=>room.ai.generate('测试').then(x=>document.querySelector('#out').textContent=x.text).catch(e=>document.querySelector('#out').textContent=e.message);")){_,_->JSONObject()}
            fun scenario(text:String)=JSONObject().put("aiResponses",JSONArray().put("模拟成功")).put("actions",JSONArray().put(JSONObject().put("type","click").put("selector","#go")).put(JSONObject().put("type","assert_text").put("selector","#out").put("text",text)))
            val denied=activity.validateAgentDraft(ws,scenario("没有 AI 权限"));assertTrue(denied.toString(),denied.getBoolean("passed"))
            val m=ws.manifest().put("permissions",JSONObject().put("database","private").put("ai",JSONObject().put("roles",JSONArray().put("text"))))
            ws.tool("mock_permissions","write_file",JSONObject().put("path","manifest.json").put("revision",1).put("text",m.toString())){_,_->JSONObject()}
            val allowed=activity.validateAgentDraft(ws,scenario("模拟成功"));assertTrue(allowed.toString(),allowed.getBoolean("passed"))
            assertEquals("用户数据",File(f.store.readInstalled(f.id).data,"keep.txt").readText())
        }finally{instrumentation.runOnMainSync{activity.finish()};f.root.deleteRecursively()}
    }
}
