package io.roomillion.android

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale
import java.util.UUID
import java.util.zip.ZipInputStream

data class InstalledRoom(
    val id: String,
    val name: String,
    val version: String,
    val entry: String,
    val manifest: JSONObject,
    val program: File,
    val data: File
)

data class RoomCompatibilityReport(
    val id: String,
    val name: String,
    val version: String,
    val blockers: List<String>,
    val warnings: List<String>
) {
    val canInstall: Boolean get() = blockers.isEmpty()

    fun describe(): String = buildString {
        append("$name · $version\n文件完整性：SHA-256 已核对\n")
        if (blockers.isNotEmpty()) append("\n无法安装：\n${blockers.joinToString("\n") { "• $it" }}\n")
        if (warnings.isNotEmpty()) append("\n兼容性提示：\n${warnings.joinToString("\n") { "• $it" }}\n")
        append("\n静态检查无法证明所有交互都可用；尚需在安卓设备上逐项测试。")
    }
}

/** Installs the existing app-only .room ZIP format without trusting archive paths or declarations. */
class RoomPackageStore(private val root: File) {
    companion object {
        private const val MAX_ARCHIVE_BYTES = 50L * 1024 * 1024
        private const val MAX_UNPACKED_BYTES = 200L * 1024 * 1024
        private const val MAX_ENTRIES = 20_000
        private val ID = Regex("[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?")
        private val NATIVE_FILE = Regex("(?i).*(?:\\.(?:exe|dll|node|dylib|msi|com|scr|dex|jar|apk)|\\.so(?:\\.[0-9]+)*)$")
    }

    init {
        require(root.mkdirs() || root.isDirectory)
        root.listFiles().orEmpty().filter { it.isDirectory && it.name.startsWith(".transfer-backup-") }.forEach { backup ->
            val id = backup.name.removePrefix(".transfer-backup-")
            if (ID.matches(id)) {
                val home = File(root, id)
                if (!home.exists()) require(backup.renameTo(home)) { "无法恢复中断的房间迁移：$id" }
                else backup.deleteRecursively()
            }
        }
    }

    fun list(): List<InstalledRoom> = root.listFiles().orEmpty().filter { it.isDirectory && ID.matches(it.name) }
        .mapNotNull { runCatching { readInstalled(it.name) }.getOrNull() }
        .sortedBy { it.name }

    fun readInstalled(id: String): InstalledRoom {
        require(ID.matches(id)) { "房间 ID 无效" }
        val home = File(root, id)
        val program = File(home, "program")
        val previous = File(home, "program.previous")
        if (!program.exists() && previous.isDirectory) previous.renameTo(program)
        val manifestFile = File(program, "manifest.json")
        require(manifestFile.isFile && manifestFile.length() <= 1_000_000) { "房间清单缺失或过大" }
        val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
        validateManifest(manifest)
        require(manifest.getString("id") == id) { "房间身份不匹配" }
        return InstalledRoom(id, manifest.getString("name"), manifest.getString("version"),
            manifest.getString("entry"), manifest, program, File(home, "data"))
    }

    fun uninstall(id: String): Boolean {
        require(ID.matches(id)) { "房间 ID 无效" }
        val home = File(root, id).toPath()
        if (!Files.exists(home, LinkOption.NOFOLLOW_LINKS)) return false
        require(Files.isDirectory(home, LinkOption.NOFOLLOW_LINKS)) { "房间目录无效" }
        Files.walkFileTree(home, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attributes: BasicFileAttributes): FileVisitResult {
                Files.delete(file)
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(directory: Path, error: java.io.IOException?): FileVisitResult {
                if (error != null) throw error
                Files.delete(directory)
                return FileVisitResult.CONTINUE
            }
        })
        return true
    }

    fun install(input: InputStream): InstalledRoom {
        val stage = File(root, ".stage-${UUID.randomUUID()}")
        require(stage.mkdir()) { "无法建立房间临时目录" }
        try {
            val manifest = prepare(input, stage)
            val report = assess(manifest, stage)
            require(report.canInstall) { report.blockers.joinToString("；") }
            val id = manifest.getString("id")
            val home = File(root, id)
            require(home.mkdirs() || home.isDirectory) { "无法建立房间目录" }
            val program = File(home, "program")
            val previous = File(home, "program.previous")
            if (previous.exists()) previous.deleteRecursively()
            if (program.exists() && !program.renameTo(previous)) error("无法暂存旧房间")
            try {
                if (!stage.renameTo(program)) error("无法安装房间")
                previous.deleteRecursively()
            } catch (error: Exception) {
                if (!program.exists() && previous.exists()) previous.renameTo(program)
                throw error
            }
            return readInstalled(id)
        } finally {
            if (stage.exists()) stage.deleteRecursively()
        }
    }

    fun inspect(input: InputStream): RoomCompatibilityReport {
        val stage = File(root, ".inspect-${UUID.randomUUID()}")
        require(stage.mkdir()) { "无法建立房间预检目录" }
        return try { assess(prepare(input, stage), stage) }
        finally { stage.deleteRecursively() }
    }

    private fun prepare(input: InputStream, stage: File): JSONObject {
        val buffered = BufferedInputStream(input)
        buffered.mark(8)
        val magic = buffered.readUpTo(4)
        buffered.reset()
        if (magic.isEmpty() || magic[0] != 0x50.toByte() || magic.getOrNull(1) != 0x4b.toByte()) {
            error("此文件不是 .room 程序 ZIP 包；加密传输包暂不支持")
        }
        val extracted = extract(buffered, stage)
        val manifestFile = File(stage, "manifest.json")
        if (!manifestFile.isFile) {
            if (File(stage, "room.zroom").exists() || File(stage, "transfer.json").exists()) {
                error("此文件是完整房间传输包；当前安卓原型只支持不含数据的程序包")
            }
            error("房间包缺少 manifest.json")
        }
        require(manifestFile.length() <= 1_000_000) { "房间清单过大" }
        val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
        validateManifest(manifest)
        verifyIntegrity(stage, extracted)
        return manifest
    }

    private fun assess(manifest: JSONObject, stage: File): RoomCompatibilityReport {
        val blockers = mutableListOf<String>()
        val warnings = mutableListOf<String>()
        fun namedItems(field: String): List<String> = manifest.optJSONArray(field)?.let { array ->
            (0 until array.length()).map { array.optString(it).take(100) }
        } ?: emptyList()
        val modules = namedItems("hostModules")
        val unsupported = modules.filterNot(AndroidModuleCatalog.supported::contains)
        if (unsupported.isNotEmpty()) blockers.add("宿主模块尚未移植：${unsupported.joinToString("、")}")
        blockers.addAll(AndroidModuleCatalog.missingDependencies(modules.toSet()))
        val embedded = namedItems("embeddedDependencies")
        if (embedded.isNotEmpty()) blockers.add("内嵌依赖尚未验证：${embedded.joinToString("、")}")
        val permissions = manifest.optJSONObject("permissions")
        if ((permissions?.optJSONArray("browser")?.length() ?: 0) > 0) warnings.add("房间依赖桌面浏览器能力，安卓宿主尚未实现")
        val filePermissions = permissions?.optJSONArray("files")
        val extraFiles = filePermissions?.let { (0 until it.length()).map(it::optString).filter { value -> value !in setOf("pick", "export") } }.orEmpty()
        if (extraFiles.isNotEmpty()) warnings.add("请求的文件能力尚不完整：${extraFiles.joinToString("、")}")
        if ((permissions?.optJSONArray("network")?.length() ?: 0) > 0) warnings.add("房间声明了联网能力；安卓房间目前只能通过工作台调用已配置的 AI")
        val aiCapabilities = permissions?.optJSONObject("ai")?.optJSONArray("capabilities")
        val unsupportedAi = aiCapabilities?.let { (0 until it.length()).map(it::optString).filter { value -> value !in setOf("text", "image", "audio") } }.orEmpty()
        if (unsupportedAi.isNotEmpty()) warnings.add("AI 输入能力尚未移植：${unsupportedAi.joinToString("、")}")
        val aiRoles = permissions?.optJSONObject("ai")?.optJSONArray("roles")
        val unsupportedRoles = aiRoles?.let { (0 until it.length()).map(it::optString).filter { value -> value !in setOf("general", "text", "vision", "audio") } }.orEmpty()
        if (unsupportedRoles.isNotEmpty()) warnings.add("AI 模型角色尚未移植：${unsupportedRoles.joinToString("、")}")
        if ((aiCapabilities?.let { (0 until it.length()).any { index -> it.optString(index) in setOf("image", "audio") } } == true) ||
            (aiRoles?.let { (0 until it.length()).any { index -> it.optString(index) in setOf("vision", "audio") } } == true)) {
            warnings.add("图片/音频 AI 输入总量限 16 MiB；需在安卓工作台为模型勾选相应输入能力")
        }
        val supportedCalls = setOf("getInfo", "db.query", "db.run", "storage.get", "storage.set",
            "files.pickText", "files.exportText", "files.openBinary", "files.readBinary", "files.closeBinary",
            "files.pickBinary", "files.exportBinary", "files.beginExport", "files.writeExport",
            "files.finishExport", "files.abortExport", "ai.listModels", "ai.generate", "ai.onModelsChanged",
            "blobs.list", "blobs.put", "blobs.begin", "blobs.write", "blobs.finish", "blobs.abort", "blobs.read", "blobs.remove",
            "artifacts.list", "artifacts.put", "artifacts.begin", "artifacts.write", "artifacts.finish", "artifacts.abort",
            "artifacts.read", "artifacts.remove", "documents.markdownToPdf")
        val callPattern = Regex("\\b(?:window\\.)?room\\.([A-Za-z][A-Za-z0-9]*)(?:\\.([A-Za-z][A-Za-z0-9]*))?")
        val missingCalls = sortedSetOf<String>()
        var scannedBytes = 0L
        File(stage, "app").walkTopDown().filter { it.isFile && it.extension.lowercase() in setOf("js", "mjs", "html") }.forEach { file ->
            if (file.length() > 2_000_000 || scannedBytes + file.length() > 10_000_000) return@forEach
            scannedBytes += file.length()
            for (match in callPattern.findAll(file.readText(Charsets.UTF_8))) {
                val call = listOfNotNull(match.groupValues[1], match.groupValues[2].takeIf(String::isNotEmpty)).joinToString(".")
                if (call !in supportedCalls) missingCalls.add(call)
            }
        }
        if (missingCalls.isNotEmpty()) warnings.add("源码中发现尚未接入的 Room SDK 调用：${missingCalls.take(15).joinToString("、")}")
        return RoomCompatibilityReport(manifest.getString("id"), manifest.getString("name"), manifest.getString("version"), blockers, warnings)
    }

    private fun extract(input: InputStream, stage: File): Set<String> {
        val names = mutableSetOf<String>()
        val files = mutableSetOf<String>()
        var count = 0
        var archiveBytes = 0L
        var unpackedBytes = 0L
        val counted = object : java.io.FilterInputStream(input) {
            override fun read(): Int {
                val value = super.read()
                if (value >= 0) archiveBytes++
                require(archiveBytes <= MAX_ARCHIVE_BYTES) { "房间包超过安卓试验上限" }
                return value
            }
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                val read = super.read(bytes, offset, length)
                if (read > 0) archiveBytes += read
                require(archiveBytes <= MAX_ARCHIVE_BYTES) { "房间包超过安卓试验上限" }
                return read
            }
        }
        ZipInputStream(counted).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                count++
                require(count <= MAX_ENTRIES) { "房间文件数量超过安卓试验上限" }
                val name = entry.name.trimEnd('/')
                if (name.isEmpty()) { zip.closeEntry(); continue }
                validatePath(name)
                val key = Normalizer.normalize(name, Normalizer.Form.NFC).lowercase(Locale.ROOT)
                require(names.add(key)) { "房间包存在重复路径：$name" }
                val dest = File(stage, name)
                require(dest.canonicalPath.startsWith(stage.canonicalPath + File.separator)) { "房间路径越界" }
                if (entry.isDirectory) {
                    require(dest.mkdirs() || dest.isDirectory)
                } else {
                    val parent = dest.parentFile ?: error("房间路径无效")
                    require(parent.mkdirs() || parent.isDirectory)
                    dest.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = zip.read(buffer)
                            if (read < 0) break
                            unpackedBytes += read
                            require(unpackedBytes <= MAX_UNPACKED_BYTES) { "房间解包后超过安卓试验上限" }
                            output.write(buffer, 0, read)
                        }
                    }
                    require(!isNativePayload(dest)) { "房间不得包含原生程序：$name" }
                    files.add(key)
                }
                zip.closeEntry()
            }
        }
        return files
    }

    private fun validateManifest(manifest: JSONObject) {
        require(manifest.optString("formatVersion") == "0.1") { "不支持的房间格式" }
        require(manifest.getJSONObject("runtime").optString("roomSdk") == "1") { "不支持的 Room SDK" }
        val id = manifest.getString("id")
        require(ID.matches(id)) { "房间 ID 无效" }
        require(manifest.getString("name").length in 1..80) { "房间名称无效" }
        require(manifest.getString("version").matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?"))) { "房间版本无效" }
        val entry = manifest.getString("entry")
        RoomActionSchema.definitions(manifest)
        val permissions = manifest.optJSONObject("permissions")
        if (permissions?.has("multiplayer") == true) {
            val values = permissions.getJSONArray("multiplayer")
            val names = (0 until values.length()).map { values.get(it) }
            require(names.all { it is String && it in setOf("host", "join") } && names.toSet().size == names.size) { "联机权限只能声明 host、join，且不能重复" }
        }
        validatePath(entry)
        require(entry.startsWith("app/") && entry.endsWith(".html")) { "房间入口无效" }
    }

    private fun verifyIntegrity(stage: File, extracted: Set<String>) {
        val integrityFile = File(stage, "integrity.json")
        require(integrityFile.isFile && integrityFile.length() <= 8_000_000) { "房间包缺少完整性清单或清单过大" }
        val integrity = JSONObject(integrityFile.readText(Charsets.UTF_8))
        require(integrity.optString("algorithm") == "sha256") { "房间完整性算法无效" }
        val expected = mutableSetOf<String>()
        val files = integrity.getJSONArray("files")
        for (i in 0 until files.length()) {
            val record = files.getJSONObject(i)
            val path = record.getString("path")
            validatePath(path)
            val key = Normalizer.normalize(path, Normalizer.Form.NFC).lowercase(Locale.ROOT)
            require(expected.add(key)) { "完整性清单路径重复" }
            val file = File(stage, path)
            require(file.isFile && file.length() == record.getLong("size")) { "房间文件缺失或大小不符：$path" }
            val actual = file.inputStream().use { digest(it) }
            require(actual.equals(record.getString("sha256"), ignoreCase = true)) { "房间文件哈希不符：$path" }
        }
        require(expected == extracted - setOf("integrity.json", "signature.json")) { "房间包有未登记或缺失的文件" }
        val manifestFile = File(stage, "manifest.json")
        require(manifestFile.isFile && manifestFile.length() <= 1_000_000) { "房间清单缺失或过大" }
        val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
        require(File(stage, manifest.getString("entry")).isFile) { "房间入口文件缺失" }
    }

    private fun validatePath(path: String) {
        require(path.isNotEmpty() && !path.startsWith('/') && !path.contains('\\') && !path.contains('\u0000')) { "房间路径无效" }
        for (part in path.split('/')) {
            require(part.isNotEmpty() && part != "." && part != ".." && !part.endsWith('.') && !part.endsWith(' ')) { "房间路径无效" }
            require(!part.contains(Regex("[<>:\"|?*\\u0000-\\u001f]"))) { "房间路径无效" }
        }
        require(!NATIVE_FILE.matches(path)) { "房间不得携带原生文件" }
    }

    private fun isNativePayload(file: File): Boolean {
        val bytes = file.inputStream().use { it.readUpTo(4) }
        return bytes.size >= 2 && bytes[0] == 0x4d.toByte() && bytes[1] == 0x5a.toByte() ||
            bytes.size >= 4 && bytes[0] == 0x7f.toByte() && bytes[1] == 0x45.toByte() && bytes[2] == 0x4c.toByte() && bytes[3] == 0x46.toByte()
    }

    private fun digest(stream: InputStream): String {
        val hash = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            hash.update(buffer, 0, read)
        }
        return hash.digest().joinToString("") { "%02x".format(it) }
    }
}
