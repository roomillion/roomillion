package io.roomillion.android

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.app.AlertDialog
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.Executors

/** Separate, trusted Pi application surface. Its native bridge is absent from room pages. */
class RoomAgentView(private val activity: MainActivity, private val store: RoomPackageStore,
    private val models: AiModelStore, private val permissions: RoomPermissionStore, roomId: String,
    private val modelRequest: ((JSONObject,AiRequestCancellation)->JSONObject)? = null) {
    val webView = WebView(activity)
    private val workspace by lazy { RoomAgentWorkspace(File(activity.filesDir,"room-agent/$roomId"),store,roomId) }
    private val gateway = RoomAgentGateway(models)
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var cancellation: AiRequestCancellation? = null
    @Volatile private var closed = false
    private var permissionPrompt: AlertDialog? = null
    private val origin = "https://agent.roomillion.invalid"
    init {
        configure()
        val loader=WebViewAssetLoader.Builder().setDomain("agent.roomillion.invalid")
            .addPathHandler("/assets/",WebViewAssetLoader.AssetsPathHandler(activity)).build()
        webView.webViewClient=object: WebViewClient(){
            override fun shouldInterceptRequest(view: WebView,request: WebResourceRequest): WebResourceResponse {
                if(request.url.scheme!="https" || request.url.host!="agent.roomillion.invalid" || request.url.port!=-1 ||
                    !request.url.path.orEmpty().startsWith("/assets/agent/"))return denied()
                val response=loader.shouldInterceptRequest(request.url)?:return denied()
                response.responseHeaders=mapOf("Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'","X-Content-Type-Options" to "nosniff")
                return response
            }
            override fun shouldOverrideUrlLoading(view: WebView,request: WebResourceRequest)=true
        }
        WebViewCompat.addWebMessageListener(webView,"AgentNative",setOf(origin)){view,message,source,main,reply->
            if(closed || view!==webView || !main || source.toString()!=origin)return@addWebMessageListener
            val raw=message.data?:return@addWebMessageListener
            if(raw.length>9_000_000)return@addWebMessageListener
            try {
                val request=JSONObject(raw);val id=request.getString("id");require(id.matches(Regex("[0-9]{1,12}")))
                val method=request.getString("method");val args=request.optJSONObject("args")?:JSONObject()
                fun finish(result: Result<JSONObject>){activity.runOnUiThread { if(!closed)reply.postMessage(result.fold(
                    {JSONObject().put("id",id).put("ok",true).put("result",it)},
                    {JSONObject().put("id",id).put("ok",false).put("error",it.message?:"操作失败")}).toString()) }}
                if(method=="cancel"){cancellation?.cancel();activity.cancelAgentValidation();finish(Result.success(JSONObject().put("stopped",true)))}
                else if(method=="copy"){
                    val text=args.getString("text");require(text.length<=2_000_000)
                    (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("AI 修改房间",text));finish(Result.success(JSONObject()))
                }else if(method=="export"){
                    worker.execute {val result=runCatching {workspace.load()};if(result.isFailure){finish(Result.failure(result.exceptionOrNull()!!));return@execute};val session=result.getOrThrow();activity.runOnUiThread {if(closed)return@runOnUiThread;activity.exportText("房间AI修改记录.json",session.toString(2),
                        { finish(Result.success(JSONObject().put("exported",it?:JSONObject.NULL))) },{finish(Result.failure(it))}) }}
                }else if(method=="apply")manualApply(::finish)
                else if(method=="restart"){
                    permissionPrompt=AlertDialog.Builder(activity).setTitle("重新建立修改会话？")
                        .setMessage("将以当前已安装的房间重建草稿并清空当前对话。旧草稿保留在应用私有空间；如需查看旧对话，请先导出。不会改变房间业务数据。")
                        .setNegativeButton("取消"){_,_->finish(Result.failure(IllegalStateException("已取消重建")))}
                        .setOnCancelListener {finish(Result.failure(IllegalStateException("已取消重建")))}
                        .setPositiveButton("重新建立"){_,_->if(!closed)worker.execute {finish(runCatching {check(!closed);workspace.restart()})}}.show()
                }
                else {
                    // Create the token before queuing the request: an immediate Stop must
                    // also cancel a request which has not entered the worker yet.
                    val token=if(method=="model")AiRequestCancellation().also {cancellation=it}else null
                    worker.execute {finish(runCatching {check(!closed){"开发页面已关闭"};token?.check();dispatch(method,args,token) })}
                }
            }catch(_:Exception){/* malformed/untrusted messages obtain no native capability */}
        }
        webView.loadUrl("$origin/assets/agent/index.html")
    }
    @SuppressLint("SetJavaScriptEnabled") private fun configure(){webView.settings.apply { javaScriptEnabled=true;domStorageEnabled=false;allowFileAccess=false;allowContentAccess=false;javaScriptCanOpenWindowsAutomatically=false;setSupportMultipleWindows(false) }}
    private fun denied()=WebResourceResponse("text/plain","UTF-8",403,"Forbidden",emptyMap(),ByteArrayInputStream(byteArrayOf()))
    private fun dispatch(method: String,args: JSONObject,token: AiRequestCancellation? = null): JSONObject = when(method){
        "load"->{workspace.publishPermissions(permissions);workspace.load().put("sessionId",workspace.load().getString("id")).put("models",models.listPublic()).put("tools",RoomAgentTools.declarations())}
        "save"->{workspace.saveConversation(args);JSONObject().put("saved",true)}
        "model"->{val active=requireNotNull(token);try{modelRequest?.invoke(args,active)?:gateway.complete(args,active)}finally{if(cancellation===active)cancellation=null}}
        "tool"->workspace.tool(args.getString("id"),args.getString("name"),args.getJSONObject("args"),::perform)
        "test"->{val previous=workspace.lastTest()?.optJSONObject("scenario")?:error("请先让 AI 编写并运行与修改相关的测试场景");perform("test_room",previous)}
        "rollback"->perform("rollback_room",JSONObject())
        else->error("不支持的开发操作")
    }
    private fun perform(name: String,args: JSONObject): JSONObject=when(name){
        "inspect_capabilities"->RoomAgentTools.capabilities().put("sdkBridgeSource",activity.assets.open("room-bridge.js").bufferedReader().use {it.readText()})
            .put("moduleDefinitions",JSONArray(activity.assets.open("agent/module-api.json").bufferedReader().use {it.readText()}))
        "test_room"->{val report=activity.validateAgentDraft(workspace,args){!closed};workspace.recordTest(report.put("scenario",args));report}
        "apply_room"->{workspace.checkpointPermissions(permissions);val result=workspace.install();workspace.publishPermissions(permissions);result}
        "rollback_room"->{val result=workspace.rollback();permissions.revoke(store.readInstalled(workspace.roomId));result.put("permissions","恢复后请按房间原声明重新授权")}
        else->error("不支持的工具")
    }
    private fun manualApply(finish: (Result<JSONObject>)->Unit){
        worker.execute {
            val preflight=runCatching {check(!closed);val old=store.readInstalled(workspace.roomId);old.manifest.optJSONObject("permissions")?.toString()!=workspace.manifest().optJSONObject("permissions")?.toString()}
            if(preflight.isFailure){finish(Result.failure(preflight.exceptionOrNull()!!));return@execute}
            val changed=preflight.getOrThrow()
            if(!changed){finish(runCatching {perform("apply_room",JSONObject())});return@execute}
            activity.runOnUiThread {if(closed)return@runOnUiThread;permissionPrompt=AlertDialog.Builder(activity).setTitle("房间能力有变化")
                .setMessage("更新后的房间声明了不同权限。确认后应用程序，下次打开时重新选择授权。\n\n${workspace.manifest().optJSONObject("permissions")}")
                .setNegativeButton("取消"){_,_->finish(Result.failure(IllegalStateException("已取消应用")))}
                .setOnCancelListener {finish(Result.failure(IllegalStateException("已取消应用")))}
                .setPositiveButton("应用更新"){_,_->if(!closed)worker.execute {finish(runCatching {check(!closed);workspace.checkpointPermissions(permissions,true);val result=workspace.install(true);workspace.publishPermissions(permissions);result})}}
                .show()}
        }
    }
    fun close(){if(closed)return;closed=true;permissionPrompt?.dismiss();cancellation?.cancel();activity.cancelAgentValidation();webView.stopLoading();(webView.parent as? android.view.ViewGroup)?.removeView(webView);webView.destroy();worker.shutdownNow()}
}
