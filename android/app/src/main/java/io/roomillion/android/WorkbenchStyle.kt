package io.roomillion.android

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** Native workbench styling only; untrusted room pages keep their own appearance. */
internal class WorkbenchStyle(private val context: Context) {
    enum class Tone { PRIMARY, SECONDARY, QUIET, DANGER }

    val background = Color.rgb(245, 248, 245)
    val ink = Color.rgb(28, 41, 36)
    val muted = Color.rgb(97, 113, 105)
    val forest = Color.rgb(31, 86, 68)
    val border = Color.rgb(219, 229, 222)
    fun dp(value: Int) = (value * context.resources.displayMetrics.density + 0.5f).toInt()

    fun shape(fill: Int, outline: Int? = null, radius: Int = 14) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        outline?.let { setStroke(dp(1), it) }
    }

    fun button(view: Button, tone: Tone = Tone.SECONDARY) {
        val fill = when (tone) {
            Tone.PRIMARY -> forest
            Tone.SECONDARY -> Color.WHITE
            Tone.QUIET -> Color.TRANSPARENT
            Tone.DANGER -> Color.rgb(255, 242, 239)
        }
        val color = when (tone) {
            Tone.PRIMARY -> Color.WHITE
            Tone.DANGER -> Color.rgb(157, 55, 43)
            else -> forest
        }
        view.apply {
            isAllCaps = false
            textSize = 15f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
                intArrayOf(muted, color)))
            backgroundTintList = null
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(36, 55, 128, 98)),
                shape(fill, if (tone == Tone.SECONDARY) border else null), shape(Color.WHITE))
            stateListAnimator = null
            elevation = 0f
            minHeight = dp(48)
            minimumHeight = dp(48)
            minWidth = 0
            minimumWidth = 0
            setPadding(dp(16), dp(12), dp(16), dp(12))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) }
        }
    }

    fun input(view: EditText) {
        view.apply {
            textSize = 15f
            setTextColor(ink)
            setHintTextColor(muted)
            backgroundTintList = null
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_focused), shape(Color.WHITE, forest, 12))
                addState(intArrayOf(), shape(Color.WHITE, border, 12))
            }
            minHeight = dp(52)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4); bottomMargin = dp(12) }
        }
    }

    fun card(): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = shape(Color.WHITE, border, 18)
        setPadding(dp(16), dp(16), dp(16), dp(12))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
    }

    fun text(value: String, heading: Boolean = false): TextView = TextView(context).apply {
        text = value
        textSize = if (heading) 19f else 14f
        setTextColor(if (heading) ink else muted)
        if (heading) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setLineSpacing(dp(3).toFloat(), 1f)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12); topMargin = if (heading) dp(6) else 0 }
    }
}
