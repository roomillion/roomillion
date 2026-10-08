package io.roomillion.android

import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.util.UUID

/** Renders bounded Markdown into a room-private PDF artifact without exposing paths to the room. */
class RoomPdfDocumentService(private val cache: File, private val blobs: RoomBlobStore) {
    companion object {
        private const val MAX_SOURCE_CHARS = 1_000_000
        private const val MAX_PAGES = 500
        private const val PAGE_WIDTH = 595
        private const val PAGE_HEIGHT = 842
        private const val MARGIN = 48f
    }

    fun render(source: Any, options: JSONObject = JSONObject()): JSONObject {
        val markdown = when (source) {
            is String -> source
            is JSONObject -> {
                require(source.length() == 1 && source.has("artifactId")) { "PDF 源必须是 Markdown 文本或 Markdown 制品 ID" }
                val (item, file) = blobs.getFile(source.getString("artifactId"))
                require(item.optString("kind") == "artifact" &&
                    item.optString("mimeType") in setOf("text/markdown", "text/plain")) { "源制品必须是 Markdown 或纯文本" }
                require(file.length() <= MAX_SOURCE_CHARS * 4L) { "Markdown 内容超过安卓 PDF 排版上限" }
                file.readText(Charsets.UTF_8)
            }
            else -> throw IllegalArgumentException("PDF 源必须是 Markdown 文本或 Markdown 制品 ID")
        }
        require(markdown.isNotBlank()) { "Markdown 内容不能为空" }
        require(markdown.length <= MAX_SOURCE_CHARS) { "单次安卓 PDF 排版最多处理 100 万字符" }
        val title = options.optString("title").ifBlank { "Roomillion 文档" }.take(200)
        val name = options.optString("name").ifBlank { "$title.pdf" }
        require(name.length <= 240) { "PDF 文件名过长" }
        val temporary = File(cache, "room-pdf-${UUID.randomUUID()}.pdf")
        val pages = try {
            require(cache.mkdirs() || cache.isDirectory) { "PDF 暂存目录不可用" }
            val pdf = PdfDocument()
            try {
                val total = drawMarkdown(pdf, markdown)
                temporary.outputStream().use { output -> pdf.writeTo(output) }
                total
            } finally { pdf.close() }
        } catch (error: Exception) { temporary.delete(); throw error }
        var token: String? = null
        try {
            require(temporary.length() in 1..RoomBlobStore.MAX_BLOB_BYTES) { "生成的 PDF 超过安卓附件上限" }
            val metadata = JSONObject().put("source", "markdown").put("title", title).put("pages", pages)
            token = blobs.begin(JSONObject().put("name", name).put("mimeType", "application/pdf")
                .put("kind", "artifact").put("metadata", metadata)).getString("token")
            FileInputStream(temporary).use { input ->
                val buffer = ByteArray(RoomBlobStore.CHUNK_BYTES)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    blobs.write(token, if (count == buffer.size) buffer else buffer.copyOf(count))
                }
            }
            return blobs.finish(token)
        } catch (error: Exception) {
            token?.let(blobs::abort)
            throw error
        } finally { temporary.delete() }
    }

    private fun drawMarkdown(pdf: PdfDocument, markdown: String): Int {
        val normal = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(31, 38, 46)
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        }
        val bold = Paint(normal).apply { typeface = Typeface.create("sans-serif", Typeface.BOLD) }
        val footer = Paint(normal).apply { textSize = 8f; color = Color.GRAY }
        var page: PdfDocument.Page? = null
        var pages = 0
        var y = 0f
        fun startPage() {
            require(pages < MAX_PAGES) { "PDF 页数超过安卓上限 $MAX_PAGES" }
            pages++
            page = pdf.startPage(PdfDocument.PageInfo.Builder(PAGE_WIDTH, PAGE_HEIGHT, pages).create())
            y = MARGIN + 12f
        }
        fun finishPage() {
            val current = page ?: return
            current.canvas.drawText(pages.toString(), PAGE_WIDTH / 2f, PAGE_HEIGHT - 20f, footer)
            pdf.finishPage(current)
            page = null
        }
        startPage()
        var code = false
        val body = markdown.replace("\r\n", "\n").replace('\r', '\n')
            .replace(Regex("(?s)^---\n.*?\n---(?:\n|$)"), "")
            .replace(Regex("(?s)<!--.*?-->"), "")
        for (sourceLine in body.split('\n')) {
            if (sourceLine.trimStart().startsWith("```")) { code = !code; continue }
            if (sourceLine.isBlank()) { y += 8f; continue }
            val heading = if (!code) Regex("^\\s*(#{1,6})\\s+(.+)$").find(sourceLine) else null
            val level = heading?.groupValues?.get(1)?.length ?: 0
            val source = heading?.groupValues?.get(2) ?: sourceLine.trimStart()
            val text = cleanInline(source).let { value ->
                when {
                    !code && Regex("^[-+*]\\s+").containsMatchIn(value) -> "• " + value.replaceFirst(Regex("^[-+*]\\s+"), "")
                    !code && value.startsWith("> ") -> "│ " + value.removePrefix("> ")
                    else -> value
                }
            }
            if (text.isBlank()) continue
            val paint = if (level > 0) bold else normal
            paint.textSize = when { level > 0 -> (24 - level * 2).coerceAtLeast(12).toFloat(); code -> 9f; else -> 10.5f }
            val lineHeight = paint.textSize * 1.55f
            if (level > 0) y += 7f
            var offset = 0
            while (offset < text.length) {
                if (y + lineHeight > PAGE_HEIGHT - MARGIN - 18f) { finishPage(); startPage() }
                val available = PAGE_WIDTH - MARGIN * 2 - if (code) 12f else 0f
                val count = paint.breakText(text, offset, text.length, true, available, null).coerceAtLeast(1)
                val end = (offset + count).coerceAtMost(text.length)
                page!!.canvas.drawText(text, offset, end, MARGIN + if (code) 12f else 0f, y, paint)
                offset = end
                y += lineHeight
            }
            y += if (level > 0) 9f else 4f
        }
        finishPage()
        return pages
    }

    private fun cleanInline(value: String): String = value
        .replace(Regex("!\\[([^]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1")
        .replace(Regex("<[^>]+>"), "")
        .replace(Regex("[*_~`]"), "")
}
