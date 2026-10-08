package io.roomillion.android

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withSubstring
import androidx.test.espresso.matcher.ViewMatchers.withText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidDiagnosticStoreTest {
    @Test fun reportContainsOnlyAllowlistedMetadataAndBoundsHistory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = AndroidDiagnosticStore(context)
        store.clear()
        try {
            assertTrue(runCatching { store.record("room.secret-123", "success") }.isFailure)
            assertTrue(runCatching { store.record("room.open", "https://private.example/secret") }.isFailure)
            repeat(105) { store.record("room.install", if (it % 2 == 0) "success" else "failure") }
            val report = AndroidDiagnosticStore(context).report(7, 2)
            assertEquals("0.1", report.getString("formatVersion"))
            assertEquals(7, report.getInt("roomCount"))
            assertEquals(2, report.getInt("textModelCount"))
            assertEquals(100, report.getJSONArray("events").length())
            assertEquals("room.install", report.getJSONArray("events").getJSONObject(0).getString("type"))
            val serialized = report.toString()
            assertFalse(serialized.contains("private.example"))
            assertFalse(serialized.contains("secret-123"))
            assertFalse(serialized.contains(context.filesDir.absolutePath))
            assertTrue(report.getJSONObject("environment").getInt("androidApi") >= 31)
        } finally { store.clear() }
    }

    @Test fun exportRequiresReviewOfIncludedAndExcludedFields() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(
            Intent(target, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as MainActivity
        try {
            onView(withText("导出诊断报告")).perform(click())
            onView(withText("选择保存位置")).check(matches(isDisplayed()))
            onView(withSubstring("不会包含房间名称、密钥、AI 对话")).check(matches(isDisplayed()))
            onView(withText("取消")).perform(click())
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
