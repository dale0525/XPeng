package com.logiconsole.xpcarinfo.widgets

import android.content.Context
import android.content.res.Configuration
import com.logiconsole.xpcarinfo.R
import org.json.JSONObject

/**
 * 2x4 要显示的两枚读数，以及用户在 App 里配置的四个快捷操作。
 *
 * 数据源头在 JS 侧（MQTT 拿到的整包状态），原生拿不到——签名与凭据获取全在 TS。
 * 所以 JS 每次拿到新状态就写一份快照到这里，组件只负责读。
 *
 * 与 JS 侧的键名必须一致：`StorageKey.widgetSnapshot = "widget.snapshot"`，
 * 走同一个 SharedPreferences（"xpeng"，与 `XpengNetModule.storageGet` 一致）。
 */
data class WidgetSnapshot(
    val soc: Int?,
    val rangeKm: Int?,
    val updatedAt: Long,
) {
    fun socText(context: Context): String =
        soc?.toString() ?: context.getString(R.string.widget_placeholder)

    fun rangeText(context: Context): String =
        rangeKm?.toString() ?: context.getString(R.string.widget_placeholder)

    /** 能量条填充比例：0..1。没有读数时不画填充，不要假装 0%。 */
    fun socFraction(): Float = (soc?.coerceIn(0, 100) ?: 0) / 100f

    /** 车辆图按系统夜间模式挑：稿里亮暗两版不是同一张图，不能靠 tint 反相。 */
    fun carDrawable(context: Context): Int {
        val night = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return if (night == Configuration.UI_MODE_NIGHT_YES) {
            R.drawable.widget_car_dark
        } else {
            R.drawable.widget_car_light
        }
    }

    companion object {
        const val PREFS = "xpeng"
        const val KEY_SNAPSHOT = "widget.snapshot"

        fun read(context: Context): WidgetSnapshot {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_SNAPSHOT, null)
            if (raw.isNullOrBlank()) return WidgetSnapshot(null, null, 0L)
            return runCatching {
                val o = JSONObject(raw)
                WidgetSnapshot(
                    soc = if (o.has("soc") && !o.isNull("soc")) o.getInt("soc") else null,
                    rangeKm = if (o.has("rangeKm") && !o.isNull("rangeKm")) o.getInt("rangeKm") else null,
                    updatedAt = o.optLong("updatedAt", 0L),
                )
            }.getOrElse { WidgetSnapshot(null, null, 0L) }
        }


    }
}
