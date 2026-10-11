package io.roomillion.android

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.widget.LinearLayout
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** An untrusted draft runs in :room_validation, never in the Pi/host process. */
class RoomValidationActivity: MainActivity() {
    private var testRuntime: RoomRuntime? = null
    private lateinit var temporary: File
    @Volatile private var finished = false
    private val errors=java.util.Collections.synchronizedList(mutableListOf<String>())
    override fun onCreate(savedInstanceState: Bundle?){
        // Android forbids two processes sharing Chromium's data directory.
        // This must run before the validation process constructs any WebView.
        if(!webViewDirectoryConfigured){WebView.setDataDirectorySuffix("room_validation");webViewDirectoryConfigured=true}
        super.onCreate(savedInstanceState)
        temporary=File(cacheDir,"agent-validator-${UUID.randomUUID()}").apply {mkdirs()}
        val layout=LinearLayout(this).apply {orientation=LinearLayout.VERTICAL}
        val style=WorkbenchStyle(this)
        layout.addView(style.text("正在隔离测试草稿 · 不访问真实数据和服务",true))
        layout.addView(android.widget.Button(this).apply {text="停止测试";style.button(this);setOnClickListener {complete(JSONObject().put("passed",false).put("error","用户停止测试"))}})
        setContentView(layout)
        Thread({
            val result=runCatching {
                val packageFile=File(intent.getStringExtra("package")?:error("缺少测试包"))
                require(packageFile.canonicalPath.startsWith(File(filesDir,"agent-validation").canonicalPath+File.separator)) {"测试包路径无效"}
                val store=RoomPackageStore(File(temporary,"rooms"));val room=packageFile.inputStream().use {store.install(it)}
                val scenario=JSONObject(intent.getStringExtra("scenario")?:"{}"); val actions=scenario.getJSONArray("actions")
                require(actions.length() in 1..60 && (0 until actions.length()).any {actions.getJSONObject(it).optString("type").startsWith("assert_")}) {"测试须包含业务动作和结果断言"}
                val mocks=scenario.optJSONArray("aiResponses")?:JSONArray()
                val opened=CountDownLatch(1)
                runOnUiThread {
                    try{testRuntime=RoomRuntime(this,room,RoomGrants(pick=true,export=true,ai=true,host=true,join=true),
                        RoomRuntimeTestOptions((0 until mocks.length()).map(mocks::getString),scenario.optJSONObject("pickText"),errors){opened.countDown()})
                        layout.addView(testRuntime!!.webView,LinearLayout.LayoutParams(-1,0,1f))
                    }catch(error:Exception){errors.add(error.message?:"启动失败");opened.countDown()}
                }
                require(opened.await(12,TimeUnit.SECONDS) && testRuntime!=null){"房间启动超时"}
                waitFor("document.readyState==='complete'")
                for(i in 0 until actions.length())step(actions.getJSONObject(i))
                // Reload the same isolated database to check that the room can reopen.
                evaluate("location.reload();true");Thread.sleep(700);waitFor("document.readyState==='complete'")
                Thread.sleep(300);require(errors.isEmpty()){errors.take(6).joinToString("；")}
                JSONObject().put("passed",true).put("checks",JSONArray(listOf("独立进程启动","声明业务动作与断言","重开")))
                    .put("actions",actions.length()).put("limitations","不读取真实数据、不调用真实 AI、不联机；不能保证服务效果、视觉或桌面兼容性")
            }.getOrElse {JSONObject().put("passed",false).put("error",it.message?:"测试失败")}
            runOnUiThread {complete(result)}
        },"room-agent-validation").start()
    }
    private fun evaluate(code: String): String {
        if(finished)error("测试已结束")
        val latch=CountDownLatch(1);var response=""
        runOnUiThread {if(!finished)testRuntime?.webView?.evaluateJavascript(code){response=it;latch.countDown()}}
        require(latch.await(4,TimeUnit.SECONDS)){"测试页面无响应，可能存在死循环"};return response
    }
    private fun waitFor(code: String){repeat(16){if(evaluate(code)=="true")return;Thread.sleep(150)};error("页面状态未达到预期")}
    private fun step(value: JSONObject){
        val selector=value.getString("selector");require(selector.length in 1..500);val q=JSONObject.quote(selector)
        when(value.getString("type")){
            "click"->require(evaluate("(()=>{const e=document.querySelector($q);if(!e||e.disabled)return false;e.click();return true;})()")=="true"){"无法点击：$selector"}
            "input"->{val text=JSONObject.quote(value.getString("text"));require(evaluate("(()=>{const e=document.querySelector($q);if(!e)return false;e.value=$text;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()")=="true"){"输入控件不存在：$selector"}}
            "assert_text"->{val expected=JSONObject.quote(value.getString("text"));waitFor("(document.querySelector($q)?.textContent||'').includes($expected)")}
            "assert_count"->{val count=value.getInt("count");require(count>=0);waitFor("document.querySelectorAll($q).length===$count")}
            "wait"->waitFor("!!document.querySelector($q)")
            else->error("不支持的测试动作")
        }
        Thread.sleep(100)
    }
    private fun complete(result: JSONObject){if(finished)return;finished=true;testRuntime?.close();testRuntime=null;setResult(Activity.RESULT_OK,Intent().putExtra("report",result.toString()));finish()}
    override fun onDestroy(){finished=true;testRuntime?.close();if(::temporary.isInitialized)temporary.deleteRecursively();super.onDestroy()}
    companion object {@Volatile private var webViewDirectoryConfigured=false}
}
