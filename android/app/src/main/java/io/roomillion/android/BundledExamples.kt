package io.roomillion.android

/** Public desktop examples verified for the Android room-host subset. */
data class BundledExample(val fileName: String, val name: String)

object BundledExamples {
    val all = listOf(
        BundledExample("inventory.room", "物资台账"),
        BundledExample("meeting-actions.room", "会议行动项"),
        BundledExample("ai-debate.room", "AI 辩论场"),
        BundledExample("ai-model-benchmark.room", "AI模型能力测试"),
        BundledExample("audio-analysis.room", "音频分析室"),
        BundledExample("document-workbench.room", "文档浏览与转换")
    )
}
