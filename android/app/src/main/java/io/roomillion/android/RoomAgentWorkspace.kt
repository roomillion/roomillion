package io.roomillion.android

import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** One persistent private draft per installed room. No room business data is copied here. */
class RoomAgentWorkspace(private val directory: File, private val store: RoomPackageStore, val roomId: String) {
    val program = File(directory, "draft")
    private val stateFile = File(directory, "session.json")
    private val backup = File(directory, "previous.room")
    private val journal = File(directory, "calls")
    private var state: JSONObject
    init {
        require(roomId.matches(Regex("[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?"))) { "房间 ID 无效" }
        directory.mkdirs(); journal.mkdirs()
        state = if (stateFile.isFile || File(stateFile.path+".bak").isFile) JSONObject(readAtomic(stateFile)) else {
            val room = store.readInstalled(roomId); copyTree(room.program, program)
            JSONObject().put("id", UUID.randomUUID().toString()).put("roomId", roomId).put("baseHash", hash(room.program))
                .put("revision", 0).put("dirty", false).put("messages", JSONArray()).put("retries", 2)
        }
        require(state.getString("roomId") == roomId) { "开发会话房间不匹配" }
        if(state.optBoolean("resetting"))finishRestart()
        // Restore only incomplete source edits. Applied-program transactions reconcile by hash.
        journal.listFiles().orEmpty().filter { it.extension == "json" }.forEach { file ->
            val call = JSONObject(readAtomic(file))
            if (call.optString("status") == "running" && call.has("undo")) restoreUndo(call)
        }
        if(state.optBoolean("rollingBack"))rollback()
        save()
    }
    private fun save() = atomic(stateFile, state.toString())
    @Synchronized fun load(): JSONObject = JSONObject(state.toString()).put("name", store.readInstalled(roomId).name)
        .put("interrupted", state.optBoolean("running")).put("canRollback", backup.isFile)
    @Synchronized fun saveConversation(value: JSONObject) {
        val messages = value.getJSONArray("messages")
        require(messages.length() <= 2000 && messages.toString().length <= 8_000_000) { "对话过长，无法保存" }
        state.put("messages", messages).put("profileId", value.optString("profileId"))
            .put("retries", value.optInt("retries", 2).coerceIn(0, 4)).put("running", value.optBoolean("running"))
        save()
    }
    fun manifest(): JSONObject = JSONObject(File(program,"manifest.json").readText())
    fun draftRoom(data: File): InstalledRoom { val m=manifest(); return InstalledRoom(roomId,m.getString("name"),m.getString("version"),m.getString("entry"),m,program,data) }
    @Synchronized fun inspect(): JSONObject = JSONObject().put("revision",state.getInt("revision"))
        .put("dirty",state.optBoolean("dirty")).put("manifest",manifest()).put("files",JSONArray(files(program).map {
            JSONObject().put("path",it.relativeTo(program).invariantSeparatorsPath).put("bytes",it.length()) }))
    private fun source(path: String, writable: Boolean = false): File {
        require(path.isNotBlank() && path.length <= 240 && !path.contains('\\') && !path.startsWith('/') &&
            path.split('/').all { it.isNotEmpty() && it !in setOf(".","..") && !it.contains(Regex("[<>:\"|?*\\u0000-\\u001f]")) }) { "源码路径无效" }
        require(path.startsWith("app/") || path.startsWith("assets/") || path in setOf("manifest.json","room-tests.json")) { "只能访问当前房间程序源码" }
        if(writable) require(!Regex(".*\\.(exe|dll|so|dex|apk|jar|node)$",RegexOption.IGNORE_CASE).matches(path)) { "不能写入原生文件" }
        val file=File(program,path); require(file.canonicalPath.startsWith(program.canonicalPath+File.separator)) { "源码路径越界" }
        var parent: File?=file;while(parent!=null && parent!=program){require(!Files.isSymbolicLink(parent.toPath())) { "源码不能包含链接" };parent=parent.parentFile}
        return file
    }
    @Synchronized fun read(args: JSONObject): JSONObject {
        val file=source(args.getString("path"));require(file.isFile && file.length()<=2_000_000) { "源码文件缺失或超过文本读取范围" }
        val text=file.readText(Charsets.UTF_8); val offset=args.optInt("offset",0); val length=args.optInt("length",20000)
        require(offset in 0..text.length && length in 1..100000) { "源码分页参数无效" }
        val end=minOf(text.length,offset+length)
        return JSONObject().put("text",text.substring(offset,end)).put("nextOffset",end).put("total",text.length).put("sha256",digest(file.readBytes())).put("revision",state.getInt("revision"))
    }
    private fun validateManifest(text: String) {
        val next=JSONObject(text); val old=manifest()
        require(next.getString("id")==roomId && next.getString("formatVersion")==old.getString("formatVersion") &&
            next.getJSONObject("runtime").toString()==old.getJSONObject("runtime").toString()) { "不能改变房间身份或运行时" }
        require((next.optJSONArray("hostModules")?:JSONArray()).let { list -> (0 until list.length()).all { list.getString(it) in AndroidModuleCatalog.supported } }) { "只能使用安卓已提供的模块" }
        require(!next.has("embeddedDependencies") || next.getJSONArray("embeddedDependencies").length()==0) { "不能下载或新增依赖" }
    }
    private fun edit(name: String,args: JSONObject): JSONObject {
        val file=source(args.getString("path"),true)
        require(args.getInt("revision")==state.getInt("revision")) { "草稿修订已变化，请重新读取" }
        require(!file.exists() || file.isFile && file.length()<=2_000_000){"源码文件过大或不是文件"}
        val old=if(file.exists())readAtomic(file) else ""
        val next=if(name=="patch_file") {
            val search=args.getString("search");require(search.isNotEmpty() && old.indexOf(search)>=0 && old.indexOf(search)==old.lastIndexOf(search)) { "替换原文须唯一匹配，请重新读取" }
            old.replace(search,args.getString("replacement"))
        } else args.getString("text")
        require(next.toByteArray().size<=2_000_000) { "源码文件过大" }
        if(file.name=="manifest.json")validateManifest(next)
        if(old==next && file.exists())return JSONObject().put("revision",state.getInt("revision")).put("changed",false)
        if(!state.optBoolean("dirty")) {
            val m=manifest();val parts=m.getString("version").substringBefore('-').split('.').map(String::toInt)
            m.put("version","${parts[0]}.${parts[1]}.${parts[2]+1}");atomic(File(program,"manifest.json"),m.toString())
        }
        // Keep the host-assigned version when the model edits other manifest fields.
        val value=if(file.name=="manifest.json")JSONObject(next).put("version",manifest().getString("version")).toString() else next
        file.parentFile!!.mkdirs();atomic(file,value)
        state.put("revision",state.getInt("revision")+1).put("dirty",true).remove("test")
        save();return JSONObject().put("revision",state.getInt("revision")).put("changed",true)
    }
    private fun undo(args: JSONObject): JSONObject {
        val file=source(args.getString("path"),true)
        require(!file.exists() || file.isFile && file.length()<=2_000_000){"源码文件过大或不是文件"}
        return JSONObject().put("path",args.getString("path")).put("exists",file.exists())
            .put("text",if(file.exists())readAtomic(file) else "").put("manifest",readAtomic(File(program,"manifest.json")))
            .put("revision",state.getInt("revision")).put("dirty",state.optBoolean("dirty")).put("test",state.opt("test")?:JSONObject.NULL)
    }
    private fun restoreUndo(call: JSONObject) {
        val old=call.getJSONObject("undo"); val file=source(old.getString("path"),true)
        if(old.getBoolean("exists")){file.parentFile!!.mkdirs();atomic(file,old.getString("text"))}else file.delete()
        atomic(File(program,"manifest.json"),old.getString("manifest"))
        state.put("revision",old.getInt("revision")).put("dirty",old.getBoolean("dirty"))
        if(old.isNull("test"))state.remove("test") else state.put("test",old.getJSONObject("test"))
        call.remove("undo");call.put("status","pending")
        atomic(File(journal,"${call.getString("id")}.json"),call.toString());save()
    }
    @Synchronized fun tool(id: String,name: String,args: JSONObject, other: (String,JSONObject)->JSONObject): JSONObject {
        require(id.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "工具调用 ID 无效" }
        val file=File(journal,"$id.json"); val fingerprint=digest((name+args.toString()).toByteArray())
        val call=if(file.isFile)JSONObject(readAtomic(file)) else JSONObject().put("id",id).put("fingerprint",fingerprint)
        require(call.getString("fingerprint")==fingerprint) { "工具调用 ID 重复且参数不同" }
        if(call.optString("status")=="done")return call.getJSONObject("result")
        if(call.optString("status")=="error")throw IllegalStateException(call.getString("error"))
        if(call.has("undo"))restoreUndo(call)
        call.put("status","running")
        if(name in setOf("write_file","patch_file"))call.put("undo",undo(args))
        atomic(file,call.toString())
        try {
            val result=when(name){"inspect_room"->inspect();"read_file"->read(args);"write_file","patch_file"->edit(name,args);else->other(name,args)}
            call.put("status","done").put("result",result);call.remove("undo");atomic(file,call.toString());return result
        }catch(error: Exception){if(call.has("undo"))restoreUndo(call);call.put("status","error").put("error",error.message?:"工具失败");atomic(file,call.toString());throw error}
    }
    @Synchronized fun recordTest(report: JSONObject) { state.put("test",JSONObject(report.toString()).put("hash",hash(program)));save() }
    @Synchronized fun lastTest(): JSONObject? = state.optJSONObject("test")
    @Synchronized fun checkpointPermissions(permissions: RoomPermissionStore,revoke: Boolean = false){
        val installed=store.readInstalled(roomId);val target=hash(program)
        if(state.has("permissionCheckpoint") && hash(installed.program)==target)return
        val grants=permissions.read(installed)?:RoomGrants()
        state.put("permissionCheckpoint",JSONObject().put("target",target).put("revoke",revoke)
            .put("pick",grants.pick).put("export",grants.export).put("ai",grants.ai).put("host",grants.host).put("join",grants.join));save()
    }
    @Synchronized fun publishPermissions(permissions: RoomPermissionStore){
        val checkpoint=state.optJSONObject("permissionCheckpoint")?:return
        val installed=store.readInstalled(roomId)
        if(hash(installed.program)!=checkpoint.getString("target"))return
        // Preserve an authorization the user has already given to this exact manifest.
        if(permissions.read(installed)==null){
            if(checkpoint.optBoolean("revoke"))permissions.revoke(installed)
            else permissions.save(installed,RoomGrants(checkpoint.optBoolean("pick"),checkpoint.optBoolean("export"),checkpoint.optBoolean("ai"),checkpoint.optBoolean("host"),checkpoint.optBoolean("join")))
        }
        state.remove("permissionCheckpoint");save()
    }
    @Synchronized fun restart(): JSONObject {
        val archive=File(directory,"history/${UUID.randomUUID()}").apply {mkdirs()}
        atomic(File(archive,"session.json"),state.toString());pack(program,File(archive,"draft.room"))
        if(backup.isFile)backup.copyTo(File(archive,"previous.room"))
        val installed=store.readInstalled(roomId)
        state=JSONObject().put("id",UUID.randomUUID().toString()).put("roomId",roomId).put("baseHash",hash(installed.program))
            .put("revision",state.getInt("revision")+1).put("dirty",false).put("messages",JSONArray())
            .put("profileId",state.optString("profileId")).put("retries",state.optInt("retries",2)).put("resetting",true)
        save();finishRestart();return JSONObject().put("restarted",true).put("archived",true)
    }
    private fun finishRestart(){
        copyTree(store.readInstalled(roomId).program,program)
        journal.listFiles().orEmpty().filter {it.isFile}.forEach {it.delete()};backup.delete()
        state.put("resetting",false);save()
    }
    @Synchronized fun install(allowPermissionChange: Boolean = false): JSONObject {
        check(!Thread.currentThread().isInterrupted){"修改已停止，草稿保留"}
        if(!state.optBoolean("dirty") && state.optString("lastAppliedHash")==hash(program) && hash(store.readInstalled(roomId).program)==state.optString("lastAppliedHash"))
            return JSONObject().put("applied",true).put("version",store.readInstalled(roomId).version).put("dataPreserved",true)
        require(state.optBoolean("dirty")) { "没有待应用的修改" }
        val report=state.optJSONObject("test") ?: error("请先测试草稿")
        require(report.optBoolean("passed") && report.getString("hash")==hash(program)) { "草稿尚未通过测试或测试后又有改动" }
        val installed=store.readInstalled(roomId)
        val target=hash(program); val current=hash(installed.program)
        // A process death after replacement but before session persistence is reconciled here.
        if(current!=target){
            require(current==state.getString("baseHash")) { "房间被其他操作更新，请先返回列表，保留此草稿后重新建立副本" }
            require(allowPermissionChange || installed.manifest.optJSONObject("permissions")?.toString()==manifest().optJSONObject("permissions")?.toString()) { "新增或变更房间权限，需要你点击“应用更新”确认" }
            if(!state.optBoolean("installing")){pack(installed.program,backup);state.put("backupHash",current).put("installing",true);save()}
            val candidate=File(directory,"candidate.room");pack(program,candidate)
            check(!Thread.currentThread().isInterrupted){"修改已停止，草稿保留"}
            candidate.inputStream().use { store.install(it) };candidate.delete()
        }
        state.put("baseHash",target).put("lastAppliedHash",target).put("dirty",false).put("installing",false);save()
        return JSONObject().put("applied",true).put("version",store.readInstalled(roomId).version).put("dataPreserved",true)
    }
    @Synchronized fun rollback(): JSONObject {
        require(backup.isFile) { "没有可恢复的上一版" }
        val current=store.readInstalled(roomId)
        val currentHash=hash(current.program)
        require(currentHash==state.getString("baseHash") || state.optBoolean("rollingBack") && currentHash==state.optString("backupHash")) { "房间已由其他操作更新，不能覆盖" }
        state.put("rollingBack",true);save()
        if(currentHash!=state.optString("backupHash"))backup.inputStream().use { store.install(it) }
        copyTree(store.readInstalled(roomId).program,program)
        state.put("baseHash",hash(program)).put("dirty",false).put("rollingBack",false).put("revision",state.getInt("revision")+1).remove("test")
        save();return JSONObject().put("restored",true).put("version",store.readInstalled(roomId).version).put("dataPreserved",true)
    }
    companion object {
        fun readAtomic(file: File)=AtomicFile(file).openRead().bufferedReader(Charsets.UTF_8).use {it.readText()}
        fun atomic(file: File,text: String){file.parentFile!!.mkdirs();val atomic=AtomicFile(file);val stream=atomic.startWrite();try{stream.write(text.toByteArray(Charsets.UTF_8));atomic.finishWrite(stream)}catch(e: Exception){atomic.failWrite(stream);throw e}}
        private fun digest(bytes: ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
        fun files(root: File): List<File>{require(root.isDirectory);val result=mutableListOf<File>();Files.walk(root.toPath()).use { paths->paths.forEach { p->require(!Files.isSymbolicLink(p)){"程序包含链接"};if(Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS))result.add(p.toFile()) } };require(result.size<=20000 && result.sumOf { it.length() }<=100L*1024*1024){"程序过大"};return result}
        fun hash(root: File)=digest(files(root).filter { it.relativeTo(root).invariantSeparatorsPath !in setOf("integrity.json","signature.json") }.sortedBy { it.relativeTo(root).invariantSeparatorsPath }.joinToString("\n"){it.relativeTo(root).invariantSeparatorsPath+":"+digest(it.readBytes())}.toByteArray())
        fun copyTree(source: File,target: File){if(target.exists())target.deleteRecursively();target.mkdirs();for(file in files(source)){val next=File(target,file.relativeTo(source).invariantSeparatorsPath);next.parentFile!!.mkdirs();file.copyTo(next)}}
        fun pack(root: File,output: File){
            val input=files(root).filter { it.relativeTo(root).invariantSeparatorsPath !in setOf("integrity.json","signature.json") }
            val records=JSONArray(input.sortedBy { it.relativeTo(root).invariantSeparatorsPath }.map { JSONObject().put("path",it.relativeTo(root).invariantSeparatorsPath).put("size",it.length()).put("sha256",digest(it.readBytes())) })
            ZipOutputStream(output.outputStream().buffered()).use { zip->for(file in input){zip.putNextEntry(ZipEntry(file.relativeTo(root).invariantSeparatorsPath));file.inputStream().use { it.copyTo(zip) };zip.closeEntry()};zip.putNextEntry(ZipEntry("integrity.json"));zip.write(JSONObject().put("algorithm","sha256").put("files",records).toString().toByteArray());zip.closeEntry()}
        }
    }
}
