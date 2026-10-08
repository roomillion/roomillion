package io.roomillion.android

/** Audited first batch of offline browser modules bundled with the Android host. */
internal object AndroidModuleCatalog {
    val supported = setOf(
        "data.date@1", "data.decimal@1", "data.csv@1", "data.search@1",
        "ui.chart@1", "security.sanitize@1", "document.markdown@1", "archive.zip@1",
        "utility.qrcode@1", "document.spreadsheet@1", "document.pdf.view@1",
        "document.word.write@1", "document.word.read@1", "document.word.preview@1"
    )
    private val requires = mapOf(
        "document.markdown@1" to setOf("security.sanitize@1"),
        "document.word.read@1" to setOf("security.sanitize@1"),
        "document.word.preview@1" to setOf("archive.zip@1", "security.sanitize@1")
    )

    fun missingDependencies(declared: Set<String>): List<String> = declared.flatMap { id ->
        requires[id].orEmpty().filterNot(declared::contains).map { "$id 需要 $it" }
    }
}
