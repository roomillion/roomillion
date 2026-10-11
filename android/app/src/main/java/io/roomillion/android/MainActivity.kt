package io.roomillion.android

import android.app.Activity
import android.app.AlertDialog
import android.annotation.SuppressLint
import android.content.Intent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.Manifest
import android.provider.Settings
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.graphics.Typeface
import android.view.View
import android.view.WindowInsets
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.view.Gravity
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.ArrayAdapter
import android.widget.ListView
import android.text.Editable
import android.text.TextWatcher
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** Minimal trusted workbench surface. Room content is always displayed in a separate WebView. */
open class MainActivity : Activity() {
    private val store by lazy { RoomPackageStore(File(filesDir, "rooms")) }
    private val transfers by lazy { RoomTransferStore(File(filesDir, "rooms")) }
    private val permissions by lazy { RoomPermissionStore(this) }
    private val aiStore by lazy { AiModelStore(this) }
    private val aiProviders by lazy { AiProviderCatalog(this) }
    private val diagnostics by lazy { AndroidDiagnosticStore(this) }
    private val style by lazy { WorkbenchStyle(this) }
    private val hotspot by lazy { RoomHotspot(this) }
    private var hotspotDialog: AlertDialog? = null
    private var pendingHotspotPermission = false
    private val worker = Executors.newSingleThreadExecutor()
    private val aiWorker = Executors.newFixedThreadPool(3)
    private var runtime: RoomRuntime? = null
    private var agentView: RoomAgentView? = null
    private var agentValidation: ((Intent?) -> Unit)? = null
    @Volatile private var agentValidationGeneration = 0
    internal var activeRoomModelPicker: AlertDialog? = null
        private set
    private var roomPermissionDialog: AlertDialog? = null
    private var roomBackCallback: OnBackInvokedCallback? = null
    private var pendingFile: ((Intent?) -> Unit)? = null
    private data class RoomImport(val generation: Int, val file: File, val openAfterInstall: Boolean)
    private var importGeneration = 0
    private var pendingImport: RoomImport? = null
    private var importDialog: AlertDialog? = null
    private var installingRoom = false
    private lateinit var root: LinearLayout
    private lateinit var title: TextView
    private lateinit var content: LinearLayout

    companion object {
        private const val FILE_REQUEST = 7001
        private const val MAX_TEXT_BYTES = 8L * 1024 * 1024
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The isolated test host must not bootstrap or enumerate the user's workbench.
        if (this is RoomValidationActivity) return
        CookieManager.getInstance().apply {
            setAcceptCookie(false)
            removeAllCookies { flush() }
        }
        WebStorage.getInstance().deleteAllData()
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        @Suppress("DEPRECATION")
        window.statusBarColor = style.background
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(style.background)
            setPadding(style.dp(20), style.dp(16), style.dp(20), style.dp(12))
        }
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            view.setPadding(style.dp(20) + bars.left, style.dp(16) + bars.top,
                style.dp(20) + bars.right, style.dp(12) + bars.bottom)
            insets
        }
        title = TextView(this).apply {
            textSize = 23f
            text = "千万间 · 安卓房间"
            setTextColor(style.ink)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            val icon = getDrawable(R.drawable.roomillion_icon)!!.apply { setBounds(0, 0, style.dp(32), style.dp(32)) }
            setCompoundDrawablesRelative(icon, null, null, null)
            compoundDrawablePadding = style.dp(10)
            layoutParams = columnParams().apply { bottomMargin = style.dp(16); gravity = Gravity.CENTER_HORIZONTAL }
        }
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(title)
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        showHome()
        handleRoomOpenIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleRoomOpenIntent(intent)
    }

    private fun handleRoomOpenIntent(incoming: Intent) {
        if (incoming.action != Intent.ACTION_VIEW) return
        // Consume the request: activity recreation must not repeat a completed installation.
        setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN))
        val uri = incoming.data
        if (uri == null) {
            cancelRoomImport()
            showImportError("没有收到房间文件，请从文件管理器重新打开。")
            return
        }
        startRoomImport(uri, openAfterInstall = true)
    }

    private fun button(label: String, tone: WorkbenchStyle.Tone = WorkbenchStyle.Tone.SECONDARY,
                       action: () -> Unit): Button = Button(this).apply {
        text = label
        style.button(this, tone)
        setOnClickListener { action() }
    }

    private fun columnWidthPx(): Int = minOf(
        (720 * resources.displayMetrics.density).toInt(),
        (resources.displayMetrics.widthPixels - style.dp(40)).coerceAtLeast(1)
    )

    private fun columnParams(height: Int = -2): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(columnWidthPx(), height).apply { bottomMargin = style.dp(8) }

    private fun showSearchableChoice(title: String, hint: String, options: List<Pair<String, String>>,
                                     selected: (String) -> Unit) {
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(style.dp(20), style.dp(12), style.dp(20), 0) }
        val search = EditText(this).apply { this.hint = hint; setSingleLine(true); style.input(this) }
        val list = ListView(this).apply { divider = android.graphics.drawable.ColorDrawable(style.border); dividerHeight = style.dp(1) }
        var matches = options
        val adapter = object : ArrayAdapter<String>(this, android.R.layout.simple_list_item_1,
            matches.map { it.second }.toMutableList()) {
            override fun getView(position: Int, convertView: View?, parent: android.view.ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply {
                    textSize = 15f
                    setTextColor(style.ink)
                    setPadding(style.dp(12), style.dp(12), style.dp(12), style.dp(12))
                    minHeight = style.dp(56)
                }
        }
        list.adapter = adapter
        layout.addView(search)
        layout.addView(list, LinearLayout.LayoutParams(-1,
            minOf((360 * resources.displayMetrics.density).toInt(), resources.displayMetrics.heightPixels / 2)))
        val dialog = AlertDialog.Builder(this).setTitle(title).setView(layout).setNegativeButton("取消", null).create()
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) {
                val query = value?.toString().orEmpty().trim()
                matches = options.filter { it.first.contains(query, true) || it.second.contains(query, true) }
                adapter.clear()
                adapter.addAll(matches.map { it.second })
                adapter.notifyDataSetChanged()
            }
            override fun afterTextChanged(value: Editable?) {}
        })
        list.setOnItemClickListener { _, _, index, _ ->
            val id = matches[index].first
            dialog.dismiss()
            selected(id)
        }
        dialog.show()
    }

    private fun showHome() {
        agentView?.close()
        agentView = null
        roomPermissionDialog?.dismiss()
        activeRoomModelPicker?.dismiss()
        setRoomBackEnabled(false)
        runtime?.close()
        runtime = null
        title.text = "千万间 · 安卓房间"
        content.removeAllViews()
        content.gravity = Gravity.CENTER_HORIZONTAL
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val welcome = style.card()
        welcome.addView(style.text("把实用工具，装进你的工作台", true))
        welcome.addView(style.text("每个房间都是一个小应用。导入分享的房间，或从内置示例开始。"))
        welcome.addView(button("导入 .room 房间包", WorkbenchStyle.Tone.PRIMARY) { chooseImport() })
        welcome.addView(button("安装内置示例房间") { showBundledExamples() })
        list.addView(welcome)
        val ai = style.card()
        ai.addView(style.text("工作台 AI", true))
        val models = aiStore.listPublic()
        val defaultModel = (0 until models.length()).map { models.getJSONObject(it) }.firstOrNull { it.optBoolean("isDefault") }
        ai.addView(style.text(defaultModel?.let { "默认模型：${it.getString("label")}\n已配置 ${models.length()} 个模型，授权后的房间可直接使用。" }
            ?: "配置一次，授权后的房间就能直接使用你的 AI 模型。"))
        ai.addView(button("设置 AI 模型") { showAiSettings() })
        list.addView(ai)
        val rooms = store.list()
        list.addView(style.text("我的房间 · ${rooms.size}", true))
        for (room in rooms) {
            val row = style.card()
            row.addView(button("${room.name}  ${room.version}", WorkbenchStyle.Tone.QUIET) { openRoom(room.id) }.apply {
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                textSize = 17f
                setPadding(0, style.dp(8), 0, style.dp(8))
            })
            val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            fun actionParams() = LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = style.dp(6) }
            actions.addView(button("导出") { chooseExport(room.id) }, actionParams())
            val requested = permissions.requested(room)
            if (requested.pick || requested.export || requested.ai) {
                actions.addView(button("权限") { editRoomPermissions(room, false) }, actionParams())
            }
            actions.addView(button("卸载", WorkbenchStyle.Tone.DANGER) { confirmUninstall(room) }, LinearLayout.LayoutParams(0, -2, 1f))
            row.addView(actions)
            row.addView(button("AI 修改房间") { openRoomAgent(room.id) })
            list.addView(row)
        }
        if (rooms.isEmpty()) list.addView(style.card().apply {
            addView(style.text("还没有安装房间。可选择内置示例，或导入桌面工作台导出的 .room 文件。"))
        })
        list.addView(style.text("关于与支持", true))
        list.addView(button("导出诊断报告", WorkbenchStyle.Tone.QUIET) { showDiagnostics() })
        list.addView(button("隐私与数据", WorkbenchStyle.Tone.QUIET) { showPrivacy() })
        content.addView(ScrollView(this).apply { isFillViewport = true; addView(list) }, columnParams(0).apply { weight = 1f })
    }

    private fun showBundledExamples() {
        val installed = store.list().associateBy { it.name }
        val labels = BundledExamples.all.map { example ->
            example.name + (installed[example.name]?.let { " · 已安装 ${it.version}" } ?: "")
        }.toTypedArray()
        AlertDialog.Builder(this).setTitle("内置示例房间")
            .setItems(labels) { _, index -> inspectBundledExample(BundledExamples.all[index]) }
            .setNegativeButton("取消", null).show()
    }

    private fun inspectBundledExample(example: BundledExample) {
        worker.execute {
            val result = runCatching {
                assets.open("examples/${example.fileName}").use { store.inspect(it) }
            }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                result.onSuccess { report ->
                    val existing = store.list().any { it.id == report.id }
                    val message = report.describe() +
                        (if (existing) "\n\n再次安装会替换房间程序，保留现有房间数据。" else "")
                    val dialog = AlertDialog.Builder(this).setTitle("安装内置示例")
                        .setMessage(message).setNegativeButton("取消", null)
                    if (report.canInstall) dialog.setPositiveButton("安装") { _, _ -> installBundledExample(example) }
                    dialog.show()
                }.onFailure { alert("示例预检失败：${it.message ?: "无法读取房间包"}") }
            }
        }
    }

    private fun installBundledExample(example: BundledExample) {
        worker.execute {
            val result = runCatching {
                assets.open("examples/${example.fileName}").use { store.install(it) }
            }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                showHome()
                result.onSuccess { recordDiagnostic("room.install", "success"); alert("已安装：${it.name}") }
                    .onFailure { recordDiagnostic("room.install", "failure"); alert("示例安装失败：${it.message ?: "房间包无效"}") }
            }
        }
    }

    private fun confirmUninstall(room: InstalledRoom) {
        AlertDialog.Builder(this).setTitle("卸载 ${room.name}？")
            .setMessage("将删除这个房间的程序和本机数据，包括数据库与附件。此操作无法撤销；如需保留，请先导出“应用＋数据”包。")
            .setNegativeButton("取消", null)
            .setPositiveButton("卸载并删除数据") { _, _ ->
                val progress = AlertDialog.Builder(this).setMessage("正在卸载房间…")
                    .setCancelable(false).show()
                worker.execute {
                    val outcome = runCatching {
                        permissions.revoke(room)
                        require(store.uninstall(room.id)) { "房间已不存在" }
                        val draft=File(filesDir,"room-agent/${room.id}")
                        require(draft.canonicalPath.startsWith(File(filesDir,"room-agent").canonicalPath+File.separator))
                        draft.deleteRecursively()
                    }
                    runOnUiThread {
                        if (isDestroyed) return@runOnUiThread
                        progress.dismiss()
                        outcome.onSuccess { showHome(); alert("房间已卸载") }
                            .onFailure { alert(it.message ?: "房间卸载失败") }
                    }
                }
            }.show()
    }

    private fun showPrivacy() {
        AlertDialog.Builder(this).setTitle("隐私与数据")
            .setMessage("房间程序、数据库和附件保存在本机；应用没有账号同步或自动云备份。\n\n" +
                "授权房间使用 AI 后，请求中的提示词及房间提交的图片、音频等内容会发送到你配置的模型服务。模型密钥由 Android Keystore 加密，不交给房间。\n\n" +
                "AI 修改房间时，修改要求和读取的程序源码会发送给选中的编程模型；对话与草稿保存在本机。\n\n" +
                "诊断记录留在本机，只有你主动选择导出时才生成报告。导出“应用＋数据”包会包含数据库和附件，可选择密码保护。\n\n" +
                "在房间列表卸载房间会删除本机该房间的数据和授权；已导出的文件需自行保管或删除。")
            .setPositiveButton("知道了", null).show()
    }

    private fun showAiSettings(editId: String? = null) {
        activeRoomModelPicker?.dismiss()
        setRoomBackEnabled(false)
        runtime?.close()
        runtime = null
        title.text = "AI 模型"
        content.removeAllViews()
        content.gravity = Gravity.CENTER_HORIZONTAL
        content.addView(button("返回房间列表") { showHome() }, columnParams())
        val sections = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(ScrollView(this).apply { addView(sections) }, columnParams(0).apply { weight = 1f })
        sections.addView(style.text("可配置多个模型并指定默认模型；只勾选模型实际支持的输入能力。密钥由 Android 系统密钥保护，不会交给房间。"))
        val profiles = aiStore.listPublic()
        if (profiles.length() > 0) sections.addView(style.text("已配置模型", true))
        for (index in 0 until profiles.length()) {
            val profile = profiles.getJSONObject(index)
            val id = profile.getString("id")
            val label = profile.getString("label")
            val suffix = if (profile.optBoolean("isDefault")) " · 默认" else ""
            val profileCard = style.card()
            profileCard.addView(style.text("${profile.optString("providerName", "自定义接口")} · ${profile.optString("model")}"))
            profileCard.addView(button("编辑 $label$suffix") { showAiSettings(id) })
            if (!profile.optBoolean("isDefault")) profileCard.addView(button("设为默认：$label", WorkbenchStyle.Tone.QUIET) {
                aiStore.setDefault(id)
                showAiSettings(editId)
            })
            sections.addView(profileCard)
        }
        if (editId != null) sections.addView(button("新增模型") { showAiSettings(null) })
        val fields = style.card()
        sections.addView(fields)
        val fieldLabels = mutableMapOf<EditText, TextView>()
        fun field(label: String, value: String): EditText = EditText(this).also {
            val caption = style.text(label).apply {
                textSize = 13f
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = style.dp(8) }
            }
            fields.addView(caption)
            fieldLabels[it] = caption
            it.hint = label
            it.setSingleLine(true)
            it.setText(value)
            style.input(it)
            fields.addView(it)
        }
        val existing = editId?.let { aiStore.read(it) }
        fields.addView(style.text(if (existing == null) "添加模型" else "编辑：${existing.label}", true))
        var selectedProvider = if (existing == null) aiProviders.providers.firstOrNull() else aiProviders.find(existing.providerId)
        var selectProviderForEditor: ((String) -> Unit)? = null
        lateinit var providerButton: Button
        lateinit var modelPicker: Button
        val providerDescription = style.text("")
        providerButton = button("选择提供商") {
            val choices = aiProviders.providers.map { it.id to "${it.name} · ${it.category}" } +
                (AiProviderCatalog.CUSTOM_ID to "自定义接口")
            showSearchableChoice("选择 AI 提供商", "搜索提供商", choices) { id ->
                selectProviderForEditor?.invoke(id)
            }
        }
        fields.addView(providerButton)
        fields.addView(providerDescription)
        val label = field("显示名称", existing?.label ?: "")
        val endpoint = field("HTTPS 聊天补全接口完整地址", existing?.endpoint ?: selectedProvider?.endpoint ?: "")
        val model = field("模型名称（也可手动输入）", existing?.model ?: selectedProvider?.defaultModel ?: "")
        val secret = field(if (existing == null) "API 密钥" else "API 密钥（留空保留原密钥）", "")
        secret.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        fieldLabels[secret]?.text = "API 密钥"
        val images = CheckBox(this).apply { text = "支持图片输入"; isChecked = existing?.supportsImages == true; minHeight = style.dp(48); setTextColor(style.ink) }
        val audio = CheckBox(this).apply { text = "支持音频输入"; isChecked = existing?.supportsAudio == true; minHeight = style.dp(48); setTextColor(style.ink) }
        fields.addView(images)
        fields.addView(audio)
        var autoLabel = existing?.let { "${selectedProvider?.name} · ${it.model}".take(80) } ?: ""
        var showEndpoint = selectedProvider == null
        lateinit var endpointToggle: Button
        fun currentProviderId(): String = selectedProvider
            ?.takeIf { aiProviders.acceptsEndpoint(it.id, endpoint.text.toString().trim()) }?.id
            ?: AiProviderCatalog.CUSTOM_ID
        fun refreshSecretHint() {
            val sameConnection = existing != null && existing.endpoint == endpoint.text.toString().trim() && existing.providerId == currentProviderId()
            secret.hint = when {
                existing == null -> "API 密钥"
                sameConnection -> "API 密钥（留空保留原密钥）"
                else -> "API 密钥（接口已更换，请重新填写）"
            }
        }
        fun refreshProviderEditor() {
            providerButton.text = "提供商：${selectedProvider?.name ?: "自定义接口"}"
            providerDescription.text = selectedProvider?.let { "${it.description}\n选择模型会自动填写接口地址，仍可手动输入模型名称。" }
                ?: "填写兼容聊天补全接口的 HTTPS 完整地址与模型名称。"
            endpoint.visibility = if (showEndpoint || selectedProvider == null) View.VISIBLE else View.GONE
            fieldLabels[endpoint]?.visibility = endpoint.visibility
            endpointToggle.visibility = if (selectedProvider == null) View.GONE else View.VISIBLE
            endpointToggle.text = if (showEndpoint) "收起接口地址" else "查看或修改接口地址"
            modelPicker.visibility = if (selectedProvider == null) View.GONE else View.VISIBLE
            refreshSecretHint()
        }
        fun applyCatalogModel(entry: AiCatalogModel) {
            model.setText(entry.id)
            endpoint.setText(entry.endpoint)
            images.isChecked = entry.supportsImages
            audio.isChecked = entry.supportsAudio
            if (label.text.isBlank() || label.text.toString() == autoLabel) {
                autoLabel = "${selectedProvider?.name} · ${entry.id}".take(80)
                label.setText(autoLabel)
            }
        }
        modelPicker = button("从目录选择模型") {
            val provider = selectedProvider ?: return@button
            showSearchableChoice("选择 ${provider.name} 的模型", "搜索模型",
                provider.models.map { it.id to "${it.name} · ${it.id}" }) { id ->
                provider.models.firstOrNull { it.id == id }?.let(::applyCatalogModel)
            }
        }
        fields.addView(modelPicker)
        endpointToggle = button("查看或修改接口地址") { showEndpoint = !showEndpoint; refreshProviderEditor() }
        fields.addView(endpointToggle)
        fields.addView(style.text("目录与桌面版同步，显示安卓当前支持的接口。图片、音频能力可按服务商实际支持调整。切换提供商或修改接口地址后，请重新填写密钥。"))
        selectProviderForEditor = { id ->
            selectedProvider = aiProviders.find(id)
            secret.setText("")
            showEndpoint = selectedProvider == null
            selectedProvider?.let { provider ->
                (provider.models.firstOrNull { it.id == provider.defaultModel } ?: provider.models.first()).let(::applyCatalogModel)
            }
            refreshProviderEditor()
        }
        endpoint.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) { refreshSecretHint() }
            override fun afterTextChanged(value: Editable?) {}
        })
        if (existing == null) selectedProvider?.let { provider ->
            (provider.models.firstOrNull { it.id == provider.defaultModel } ?: provider.models.first()).let(::applyCatalogModel)
        }
        refreshProviderEditor()
        fields.addView(button(if (existing == null) "添加模型" else "保存修改", WorkbenchStyle.Tone.PRIMARY) {
            try {
                val chosenProvider = currentProviderId()
                val sameConnection = existing != null && existing.endpoint == endpoint.text.toString().trim() && existing.providerId == chosenProvider
                aiStore.saveProfile(editId, label.text.toString(), endpoint.text.toString(), model.text.toString(),
                    secret.text.toString().ifEmpty { if (sameConnection) existing?.apiKey ?: "" else "" },
                    images.isChecked, audio.isChecked, chosenProvider)
                alert("模型已保存")
                showAiSettings()
            } catch (error: Exception) { alert(error.message ?: "保存失败") }
        })
        if (existing != null) {
            lateinit var testButton: Button
            testButton = button("测试连接（发送一次简短请求）") {
                testButton.isEnabled = false
                testButton.text = "正在测试连接…"
                aiWorker.execute {
                    val result = runCatching { aiStore.testConnection(existing.id) }
                    runOnUiThread {
                        if (isDestroyed || !testButton.isAttachedToWindow) return@runOnUiThread
                        testButton.isEnabled = true
                        testButton.text = "测试连接（发送一次简短请求）"
                        result.onSuccess { modelName -> alert("连接成功：$modelName") }
                            .onFailure { error -> alert("连接失败：${error.message ?: "请求失败"}") }
                    }
                }
            }
            fields.addView(testButton)
        }
        if (existing != null) fields.addView(button("删除这个模型", WorkbenchStyle.Tone.DANGER) {
            AlertDialog.Builder(this).setTitle("删除模型配置？").setMessage(existing.label)
                .setNegativeButton("取消", null).setPositiveButton("删除") { _, _ ->
                    try { aiStore.remove(existing.id); showAiSettings(); alert("模型已删除") }
                    catch (error: Exception) { alert(error.message ?: "删除失败") }
                }.show()
        })
    }

    fun listAiModels(): org.json.JSONArray = aiStore.listPublic()

    fun generateAi(prompt: String, options: JSONObject, succeed: (Any?) -> Unit, fail: (Exception) -> Unit,
                   chunk: (String, String) -> Unit, cancellation: AiRequestCancellation) {
        aiWorker.execute {
            val result = runCatching { aiStore.generate(prompt, options, cancellation) { delta, fullText ->
                runOnUiThread { if (!isDestroyed && !cancellation.isCancelled) chunk(delta, fullText) }
            } }
            runOnUiThread {
                if (isDestroyed || cancellation.isCancelled) return@runOnUiThread
                result.onSuccess { recordDiagnostic("ai.generate", "success"); succeed(it) }
                    .onFailure { recordDiagnostic("ai.generate", "failure"); fail(it as? Exception ?: Exception(it)) }
            }
        }
    }

    private fun openRoom(id: String) {
        if (installingRoom) { alert("正在安装房间，请稍候"); return }
        try {
            val room = store.readInstalled(id)
            val granted = permissions.read(room)
            val requested = permissions.requested(room)
            if (granted == null && (requested.pick || requested.export || requested.ai || requested.host || requested.join)) {
                editRoomPermissions(room, true)
                return
            }
            displayRoom(room, granted ?: RoomGrants())
        } catch (error: Exception) {
            recordDiagnostic("room.open", "failure")
            runtime?.close()
            runtime = null
            showHome()
            alert(error.message ?: "无法打开房间")
        }
    }

    internal fun openRoomAgent(id: String) {
        try {
            if (aiStore.listPublic().length() == 0) { alert("请先配置工作台 AI 模型"); showAiSettings(); return }
            runtime?.close(); runtime = null
            agentView?.close(); agentView = null
            content.removeAllViews(); title.text = "AI 修改房间"
            content.addView(button("返回房间列表（草稿自动保存）") { showHome() }, columnParams())
            val editor = RoomAgentView(this, store, aiStore, permissions, id)
            agentView = editor
            content.addView(editor.webView, LinearLayout.LayoutParams(-1,0,1f))
            setRoomBackEnabled(true)
        } catch (error: Exception) { showHome(); alert(error.message ?: "无法打开 AI 修改") }
    }

    internal fun validateAgentDraft(workspace: RoomAgentWorkspace, scenario: JSONObject, canRun: ()->Boolean = {true}): JSONObject {
        var generation = agentValidationGeneration
        require(scenario.toString().length <= 100_000) { "测试场景过大" }
        val directory = File(filesDir,"agent-validation").apply { mkdirs() }
        val snapshot = File(directory,"${java.util.UUID.randomUUID()}.room")
        RoomAgentWorkspace.pack(workspace.program,snapshot)
        val done = java.util.concurrent.CountDownLatch(1)
        var report = JSONObject().put("passed",false).put("error","测试中断或超时")
        runOnUiThread {
            if (isDestroyed || !canRun() || generation!=agentValidationGeneration) { done.countDown(); return@runOnUiThread }
            generation = ++agentValidationGeneration
            agentValidation = { result ->
                runCatching { result?.getStringExtra("report")?.let { report=JSONObject(it) } }
                done.countDown()
            }
            runCatching {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(this,RoomValidationActivity::class.java)
                    .putExtra("package",snapshot.absolutePath).putExtra("scenario",scenario.toString()),7002)
            }.onFailure {report=JSONObject().put("passed",false).put("error","无法启动隔离测试");done.countDown()}
        }
        try { done.await(90,java.util.concurrent.TimeUnit.SECONDS);return report }
        finally { snapshot.delete();runOnUiThread { if(generation==agentValidationGeneration){agentValidation=null;@Suppress("DEPRECATION") finishActivity(7002)} } }
    }

    internal fun cancelAgentValidation() { ++agentValidationGeneration;agentValidation?.invoke(null);agentValidation=null;@Suppress("DEPRECATION") finishActivity(7002) }

    private fun editRoomPermissions(room: InstalledRoom, openAfter: Boolean) {
        roomPermissionDialog?.dismiss()
        val requested = permissions.requested(room)
        val existing = permissions.read(room) ?: RoomGrants()
        val aiRoles = room.manifest.optJSONObject("permissions")?.optJSONObject("ai")?.optJSONArray("roles")
        val roleNames = aiRoles?.let { roles -> (0 until roles.length()).map(roles::optString).toSet() }.orEmpty()
        val aiLabel = "使用工作台文本 AI" +
            (if ("vision" in roleNames) "、图片识别" else "") +
            (if ("audio" in roleNames) "、音频处理" else "")
        val options = listOfNotNull(
            "选择文件".takeIf { requested.pick }?.let { it to "pick" },
            "导出文件".takeIf { requested.export }?.let { it to "export" },
            aiLabel.takeIf { requested.ai }?.let { it to "ai" },
            "在局域网创建游戏".takeIf { requested.host }?.let { it to "host" },
            "加入局域网游戏".takeIf { requested.join }?.let { it to "join" }
        )
        val selected = booleanArrayOf(existing.pick, existing.export, existing.ai, existing.host, existing.join)
        val index = mapOf("pick" to 0, "export" to 1, "ai" to 2, "host" to 3, "join" to 4)
        AlertDialog.Builder(this).setTitle("${room.name} · 选择允许的能力")
            .setMultiChoiceItems(options.map { it.first }.toTypedArray(),
                options.map { selected[index.getValue(it.second)] }.toBooleanArray()) { _, choice, checked ->
                selected[index.getValue(options[choice].second)] = checked
            }
            .setNegativeButton(if (openAfter) "暂不授权" else "取消") { _, _ ->
                if (openAfter) {
                    try {
                        permissions.save(room, RoomGrants())
                        displayRoom(room, RoomGrants())
                    } catch (error: Exception) { alert(error.message ?: "授权保存失败") }
                }
            }
            .setPositiveButton("保存") { _, _ ->
                val grants = RoomGrants(selected[0], selected[1], selected[2], selected[3], selected[4])
                try {
                    permissions.save(room, grants)
                    if (openAfter) displayRoom(room, grants) else alert("房间授权已更新，下次打开生效")
                } catch (error: Exception) { alert(error.message ?: "授权保存失败") }
            }.create().also { dialog ->
                roomPermissionDialog = dialog
                dialog.setOnDismissListener { if (roomPermissionDialog === dialog) roomPermissionDialog = null }
                dialog.show()
            }
    }

    private fun displayRoom(room: InstalledRoom, grants: RoomGrants) {
        try {
            activeRoomModelPicker?.dismiss()
            runtime?.close()
            content.removeAllViews()
            content.gravity = Gravity.CENTER_HORIZONTAL
            title.text = room.name
            content.addView(button("返回房间列表") { showHome() }, columnParams())
            content.addView(button("AI 修改") { openRoomAgent(room.id) }, columnParams())
            if (grants.ai && aiStore.listPublic().length() > 1) {
                content.addView(button("切换默认 AI") { showRoomModelPicker() }, columnParams())
            }
            if (grants.host || grants.join) content.addView(button("联机与手机热点") { showLanControls() }, columnParams())
            runtime = RoomRuntime(this, room, grants)
            content.addView(runtime!!.webView, LinearLayout.LayoutParams(-1, 0, 1f))
            setRoomBackEnabled(true)
            recordDiagnostic("room.open", "success")
        } catch (error: Exception) {
            recordDiagnostic("room.open", "failure")
            runtime?.close()
            runtime = null
            showHome()
            alert(error.message ?: "无法打开房间")
        }
    }

    private fun showLanControls() {
        hotspotDialog?.dismiss()
        val choices = arrayOf("开启或查看手机热点", "查看／复制游戏加入信息", "结束当前联机", "打开系统网络设置")
        hotspotDialog = AlertDialog.Builder(this).setTitle("局域网联机")
            .setItems(choices) { _, which -> when (which) {
                0 -> startHotspot()
                1 -> {
                    val status = runtime?.multiplayerStatus()
                    val invites = status?.optJSONArray("invitations")
                    if (invites == null || invites.length() == 0) alert("请先开启热点，再在支持联机的房间内创建游戏。玩家连接热点后，使用主机分享的加入信息进入同版本房间。")
                    else {
                        val entries = (0 until invites.length()).map { invites.getJSONObject(it) }
                        AlertDialog.Builder(this).setTitle("选择主机地址")
                            .setItems(entries.map { it.getString("host") }.toTypedArray()) { _, index ->
                                val invitation = entries[index].getString("invitation")
                                val field = TextView(this).apply { text = invitation; setTextIsSelectable(true); setPadding(style.dp(18), style.dp(14), style.dp(18), style.dp(14)) }
                                AlertDialog.Builder(this).setTitle("分享给同一热点的玩家").setView(field)
                                    .setPositiveButton("复制加入信息") { _, _ ->
                                        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("千万间游戏加入信息", invitation))
                                        Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show()
                                    }.setNeutralButton("分享") { _, _ ->
                                        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, invitation), "分享加入信息"))
                                    }.setNegativeButton("关闭", null).show()
                            }.setNegativeButton("关闭", null).show()
                    }
                }
                2 -> AlertDialog.Builder(this).setTitle("结束当前联机？").setMessage("主机结束后，其他玩家会断开连接。")
                    .setPositiveButton("结束") { _, _ -> runtime?.stopMultiplayer(); hotspot.close(); alert("联机和本应用创建的热点已关闭") }
                    .setNegativeButton("取消", null).show()
                3 -> startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS))
            } }.setNegativeButton("关闭", null).create().also { it.show() }
    }

    private fun startHotspot() {
        val active = hotspot.status()
        if (active.optBoolean("active")) { showHotspotInfo(active); return }
        val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            pendingHotspotPermission = true
            requestPermissions(if (Build.VERSION.SDK_INT >= 33) arrayOf(permission) else arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, permission), 7002)
            return
        }
        Toast.makeText(this, "正在开启本地热点", Toast.LENGTH_SHORT).show()
        hotspot.start({ showHotspotInfo(it) }, { alert(it) })
    }

    private fun showHotspotInfo(status: JSONObject) {
        if (isFinishing || isDestroyed) return
        val ssid = status.getString("ssid")
        val password = status.getString("password")
        AlertDialog.Builder(this).setTitle("手机热点已开启")
            .setMessage("热点名称：$ssid\n密码：$password\n\n让其他手机或电脑连接此热点，然后在房间内创建游戏并分享加入信息。这个热点不提供互联网；停止热点会让游戏断线。")
            .setPositiveButton("知道了", null)
            .setNeutralButton("复制热点信息") { _, _ -> getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newPlainText("千万间热点", "热点：$ssid\n密码：$password")) }
            .setNegativeButton("停止热点") { _, _ -> runtime?.stopMultiplayer(); hotspot.close() }.show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 7002 && pendingHotspotPermission) {
            pendingHotspotPermission = false
            val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION
            if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) startHotspot()
            else alert("未允许自动创建热点。可以在系统设置手动开启热点，房间仍可通过局域网开房。")
        }
    }

    private fun showRoomModelPicker() {
        val active = runtime ?: return
        val profiles = aiStore.listPublic()
        if (profiles.length() < 2) return
        val ids = (0 until profiles.length()).map { profiles.getJSONObject(it).getString("id") }
        val labels = (0 until profiles.length()).map { index ->
            profiles.getJSONObject(index).let { "${it.getString("label")} · ${it.getString("model")}" }
        }.toTypedArray()
        val selected = (0 until profiles.length()).firstOrNull { profiles.getJSONObject(it).optBoolean("isDefault") } ?: 0
        activeRoomModelPicker?.dismiss()
        val picker = AlertDialog.Builder(this).setTitle("选择房间默认文本模型")
            .setSingleChoiceItems(labels, selected) { dialog, index ->
                try {
                    aiStore.setDefault(ids[index])
                    active.notifyModelsChanged()
                    dialog.dismiss()
                } catch (error: Exception) { alert(error.message ?: "切换模型失败") }
            }
            .setNegativeButton("取消", null).create()
        picker.setOnDismissListener { if (activeRoomModelPicker === picker) activeRoomModelPicker = null }
        activeRoomModelPicker = picker
        picker.show()
    }

    private fun chooseImport() {
        launchFilePicker(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }) { result ->
            val uri = result?.data ?: return@launchFilePicker
            startRoomImport(uri)
        }
    }

    private fun cancelRoomImport() {
        importGeneration++
        importDialog?.dismiss()
        importDialog = null
        pendingImport?.file?.delete()
        pendingImport = null
    }

    private fun startRoomImport(uri: Uri, openAfterInstall: Boolean = false) {
        cancelRoomImport()
        val generation = importGeneration
        activeRoomModelPicker?.dismiss()
        roomPermissionDialog?.dismiss()
        alert("正在检查房间包…")
        worker.execute {
            val outcome = runCatching { RoomImportSource.snapshot(this, uri, openAfterInstall) }
            runOnUiThread {
                if (isDestroyed || generation != importGeneration) { outcome.getOrNull()?.delete(); return@runOnUiThread }
                outcome.onSuccess { file ->
                    val request = RoomImport(generation, file, openAfterInstall)
                    pendingImport = request
                    inspectSelected(request)
                }.onFailure { error ->
                    showImportError(if (error is SecurityException) "无法读取文件，请从文件管理器重新选择“用千万间打开”，并允许读取此文件。"
                        else error.message ?: "无法读取房间文件")
                }
            }
        }
    }

    private fun showImportError(message: String) {
        importDialog = AlertDialog.Builder(this).setTitle("无法打开房间包").setMessage(message)
            .setPositiveButton("知道了") { _, _ -> cancelRoomImport() }.create().also {
                it.setOnCancelListener { cancelRoomImport() }
                it.show()
            }
    }

    private fun inspectSelected(request: RoomImport, password: String? = null) {
        worker.execute {
            val outcome = runCatching {
                request.file.inputStream().use { transfers.inspect(it, password) }
            }
            runOnUiThread {
                if (isDestroyed || request.generation != importGeneration) return@runOnUiThread
                outcome.onSuccess { report ->
                    recordDiagnostic("room.inspect", "success")
                    val existingRoom = store.list().any { it.id == report.compatibility.id }
                    val dialog = AlertDialog.Builder(this).setTitle("房间导入预检")
                        .setMessage(report.describe(existingRoom)).setNegativeButton("取消") { _, _ -> cancelRoomImport() }
                    if (report.canInstall) dialog.setPositiveButton(if (request.openAfterInstall) "导入并打开" else "导入房间") {
                        _, _ -> installSelected(request, password)
                    }
                    importDialog = dialog.create().also { it.setOnCancelListener { cancelRoomImport() }; it.show() }
                }.onFailure {
                    recordDiagnostic("room.inspect", "failure")
                    if (it is TransferPasswordRequired) askTransferPassword(request)
                    else if (password != null && it.message?.contains("密码错误") == true) {
                        alert("密码错误或房间包已损坏，请重试")
                        askTransferPassword(request)
                    }
                    else showImportError("预检失败：${it.message ?: "文件不受支持"}")
                }
            }
        }
    }

    private fun askTransferPassword(request: RoomImport) {
        val entry = EditText(this).apply {
            hint = "导出时设置的房间包密码"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            style.input(this)
        }
        importDialog = AlertDialog.Builder(this).setTitle("解锁房间包").setView(entry)
            .setNegativeButton("取消") { _, _ -> cancelRoomImport() }
            .setPositiveButton("验证密码") { _, _ -> inspectSelected(request, entry.text.toString()) }
            .create().also { it.setOnCancelListener { cancelRoomImport() }; it.show() }
    }

    private fun installSelected(request: RoomImport, password: String? = null) {
        if (request.generation != importGeneration) return
        pendingImport = null // Worker owns the snapshot until installation has finished.
        pendingFile = null
        showHome() // Close the old room and its database before updating its files.
        installingRoom = true
        val progress = AlertDialog.Builder(this).setMessage("正在安装房间…").setCancelable(false).show()
        importDialog = progress
        worker.execute {
            val outcome = runCatching {
                request.file.inputStream().use { transfers.install(it, password) }
            }
            request.file.delete()
            runOnUiThread {
                installingRoom = false
                progress.dismiss()
                if (isDestroyed || request.generation != importGeneration) return@runOnUiThread
                importDialog = null
                showHome()
                outcome.onSuccess {
                    recordDiagnostic("room.install", "success")
                    alert("已安装：${it.name}")
                    if (request.openAfterInstall) openRoom(it.id)
                }.onFailure { recordDiagnostic("room.install", "failure"); showImportError("导入失败：${it.message ?: "文件不受支持"}") }
            }
        }
    }

    private fun chooseExport(roomId: String) {
        AlertDialog.Builder(this).setTitle("导出房间")
            .setItems(arrayOf("仅程序（分享给别人安装）", "程序＋数据（未加密）", "程序＋数据（密码保护）")) { _, choice ->
                if (choice == 2) {
                    val entry = EditText(this).apply {
                        hint = "设置 8–128 字符的导出密码"
                        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                    }
                    AlertDialog.Builder(this).setTitle("保护房间数据").setView(entry)
                        .setNegativeButton("取消", null)
                        .setPositiveButton("导出") { _, _ -> exportRoom(roomId, true, entry.text.toString()) }.show()
                } else exportRoom(roomId, choice == 1)
            }.setNegativeButton("取消", null).show()
    }

    private fun exportRoom(roomId: String, includeData: Boolean, password: String? = null) {
        worker.execute {
            val outcome = runCatching {
                val room = store.readInstalled(roomId)
                val file = RoomTransferExporter(File(filesDir, "rooms"), cacheDir).create(room, includeData, password)
                room to file
            }
            runOnUiThread {
                if (isDestroyed) {
                    outcome.getOrNull()?.second?.delete()
                    return@runOnUiThread
                }
                outcome.onSuccess { (room, file) ->
                    saveBinary("${room.id}-${room.version}.room", { uri ->
                        if (uri == null) { file.delete(); return@saveBinary }
                        worker.execute {
                            val saved = runCatching {
                                contentResolver.openOutputStream(uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } }
                                    ?: error("无法写入所选位置")
                            }
                            file.delete()
                            runOnUiThread {
                                if (!isDestroyed) saved.onSuccess { recordDiagnostic("room.export", "success"); alert("房间已导出") }
                                    .onFailure { recordDiagnostic("room.export", "failure"); alert("导出失败：${it.message ?: "写入失败"}") }
                            }
                        }
                    }, { file.delete(); alert(it.message ?: "无法选择导出位置") })
                }.onFailure { recordDiagnostic("room.export", "failure"); alert("导出失败：${it.message ?: "无法打包房间"}") }
            }
        }
    }

    private fun recordDiagnostic(type: String, outcome: String) {
        runCatching { diagnostics.record(type, outcome) }
    }

    private fun showDiagnostics() {
        val report = runCatching { diagnostics.report(store.list().size, aiStore.listPublic().length()) }
            .getOrElse { alert("诊断报告准备失败"); return }
        val count = report.getJSONArray("events").length()
        AlertDialog.Builder(this).setTitle("导出诊断报告")
            .setMessage("将导出 Android、WebView 和应用版本，房间与文本模型数量，以及最近 $count 条操作类型和结果。不会包含房间名称、密钥、AI 对话、文件内容、路径或网址。请自行选择保存位置。")
            .setNegativeButton("取消", null)
            .setPositiveButton("选择保存位置") { _, _ ->
                try {
                    launchFilePicker(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "application/json"
                        putExtra(Intent.EXTRA_TITLE, "Roomillion-Android-Diagnostic.json")
                    }) { result ->
                        val uri = result?.data ?: return@launchFilePicker
                        worker.execute {
                            val saved = runCatching {
                                contentResolver.openOutputStream(uri, "wt")?.use { output ->
                                    output.write((report.toString(2) + "\n").toByteArray(Charsets.UTF_8))
                                } ?: error("无法写入所选位置")
                            }
                            runOnUiThread {
                                if (!isDestroyed) saved.onSuccess { alert("诊断报告已导出") }
                                    .onFailure { alert("诊断报告导出失败：${it.message ?: "写入失败"}") }
                            }
                        }
                    }
                } catch (error: Exception) { alert(error.message ?: "无法选择保存位置") }
            }.show()
    }

    private fun launchFilePicker(intent: Intent, callback: (Intent?) -> Unit) {
        if (pendingFile != null) throw IllegalStateException("请先完成上一个文件操作")
        pendingFile = callback
        try { startActivityForResult(intent, FILE_REQUEST) }
        catch (error: Exception) { pendingFile = null; throw error }
    }

    @Deprecated("Legacy Activity result keeps the prototype free of an additional AndroidX activity dependency")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 7002) { val callback=agentValidation; agentValidation=null; callback?.invoke(if(resultCode==RESULT_OK)data else null);return }
        if (requestCode != FILE_REQUEST) return
        val callback = pendingFile
        pendingFile = null
        callback?.invoke(if (resultCode == RESULT_OK) data else null)
    }

    fun pickText(succeed: (Any?) -> Unit, fail: (Exception) -> Unit) {
        try {
            launchFilePicker(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "text/*"
            }) { result ->
                val uri = result?.data
                if (uri == null) { succeed(null); return@launchFilePicker }
                worker.execute {
                  val outcome = runCatching {
                    val name = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "导入文本"
                    val bytes = contentResolver.openInputStream(uri)?.use { input ->
                        val data = input.readUpTo((MAX_TEXT_BYTES + 1).toInt())
                        require(data.size <= MAX_TEXT_BYTES) { "文件超过 8 MiB" }
                        data
                    } ?: error("无法读取文件")
                    JSONObject().put("name", name).put("text", bytes.toString(Charsets.UTF_8))
                  }
                  runOnUiThread {
                    if (!isDestroyed) outcome.onSuccess(succeed).onFailure { fail(it as? Exception ?: Exception(it)) }
                  }
                }
            }
        } catch (error: Exception) { fail(error) }
    }

    fun selectBinary(succeed: (Uri?) -> Unit, fail: (Exception) -> Unit) {
        try {
            launchFilePicker(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }) { result -> succeed(result?.data) }
        } catch (error: Exception) { fail(error) }
    }

    fun saveBinary(name: String, succeed: (Uri?) -> Unit, fail: (Exception) -> Unit) {
        try {
            launchFilePicker(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/octet-stream"
                putExtra(Intent.EXTRA_TITLE, name)
            }) { result -> succeed(result?.data) }
        } catch (error: Exception) { fail(error) }
    }

    fun exportText(name: String, text: String, succeed: (Any?) -> Unit, fail: (Exception) -> Unit) {
        try {
            require(name.isNotBlank() && name.length <= 200 && !name.contains('/') && !name.contains('\\')) { "导出文件名无效" }
            require(text.toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES) { "导出文本超过 8 MiB" }
            launchFilePicker(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "text/plain"
                putExtra(Intent.EXTRA_TITLE, name)
            }) { result ->
                val uri = result?.data
                if (uri == null) { succeed(null); return@launchFilePicker }
                worker.execute {
                  val outcome = runCatching {
                    contentResolver.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                        ?: error("无法写入所选位置")
                    name
                  }
                  runOnUiThread {
                    if (!isDestroyed) outcome.onSuccess(succeed).onFailure { fail(it as? Exception ?: Exception(it)) }
                  }
                }
            }
        } catch (error: Exception) { fail(error) }
    }

    private fun alert(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private fun setRoomBackEnabled(enabled: Boolean) {
        if (Build.VERSION.SDK_INT < 33) return
        roomBackCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        roomBackCallback = null
        if (enabled) {
            val callback = OnBackInvokedCallback { showHome() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            roomBackCallback = callback
        }
    }

    @SuppressLint("GestureBackNavigation") // Android 12 fallback; Android 13+ uses OnBackInvokedCallback.
    @Suppress("DEPRECATION")
    @Deprecated("Android 12 fallback; newer systems use OnBackInvokedCallback")
    override fun onBackPressed() {
        if (runtime != null || agentView != null) showHome() else super.onBackPressed()
    }

    override fun onDestroy() {
        if(this is RoomValidationActivity){worker.shutdownNow();aiWorker.shutdownNow();super.onDestroy();return}
        agentView?.close()
        agentView = null
        hotspotDialog?.dismiss()
        hotspot.close()
        cancelRoomImport()
        roomPermissionDialog?.dismiss()
        cacheDir.listFiles().orEmpty().filter { it.name.startsWith("room-import-") && it.name.endsWith(".room") }.forEach { it.delete() }
        activeRoomModelPicker?.dismiss()
        setRoomBackEnabled(false)
        runtime?.close()
        pendingFile = null
        worker.shutdownNow()
        aiWorker.shutdownNow()
        super.onDestroy()
    }
}
