package com.logiconsole.xpcarinfo.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.util.Log
import android.widget.RemoteViews
import com.logiconsole.xpcarinfo.MainActivity
import com.logiconsole.xpcarinfo.R

/**
 * 三档桌面组件的共同骨架。
 *
 * 每档只需要声明自己的布局与四个 PendingIntent 的触发码；拼 RemoteViews、画车辆图、
 * 把点击路由到主入口或无界面任务，都在这里做一次。
 *
 * 点击路由（用户已确认的口径）：
 * - 四个按钮各自下发一条车控指令，走无界面 JS 任务，不打开界面；
 * - 卡片其余区域打开 App，且已经落在车控页。
 */
abstract class BaseWidgetProvider(private val layoutId: Int) : AppWidgetProvider() {

    /** 单个按钮的点击 action 前缀；子类用 actionFor(slot) 拼出完整 action。 */
    protected abstract val actionPrefix: String

    /** 这一档是否展示电量/续航读数（只有 2x4 展示）。 */
    protected open val showsReadout: Boolean = false

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (id in appWidgetIds) {
            appWidgetManager.updateAppWidget(id, buildViews(context, id))
        }
        Log.i(TAG, "onUpdate ids=${appWidgetIds.toList()} layout=$layoutId")
    }

    /** 字号、颜色这类随主题变化的东西在 RemoteViews 里只能逐个 set，收在这里统一做。 */
    protected fun buildViews(context: Context, widgetId: Int): RemoteViews {
        val views = RemoteViews(context.packageName, layoutId)
        val shortcuts = WidgetShortcuts.all()

        // 图形用预渲染位图而不是图标字体：launcher 进程里拿不到自定义字体，
        // 早期用 fontFamily 直出时四个图标全变成豆腐块（实测 Pixel 4a + Android 13）。
        val night = isNight(context)
        shortcuts.forEachIndexed { index, action ->
            val iconId = context.resources.getIdentifier("widget_icon_$index", "id", context.packageName)
            val labelId = context.resources.getIdentifier("widget_label_$index", "id", context.packageName)
            if (iconId == 0 || labelId == 0) return@forEachIndexed
            views.setImageViewResource(iconId, iconDrawable(index, night))
            views.setTextViewText(labelId, action.label)
            // 整格点击：作用域是格子本身，所以要给每个格子的根 View 单独设 PendingIntent。
            val slotId = context.resources.getIdentifier("widget_slot_$index", "id", context.packageName)
            if (slotId != 0) views.setOnClickPendingIntent(slotId, actionIntent(context, widgetId, action))
        }

        if (showsReadout) fillReadout(context, views)
        // 卡片其余区域打开 App：RemoteViews 的根布局点击兜住按钮之外的空白。
        views.setOnClickPendingIntent(
            context.resources.getIdentifier("widget_root", "id", context.packageName),
            openAppIntent(context),
        )
        return views
    }

    private fun isNight(context: Context): Boolean =
        (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    /** 图标位图按亮/暗各出一套：亮色深灰、暗色浅白，不靠 tint 反相。 */
    private fun iconDrawable(index: Int, night: Boolean): Int {
        val name = if (night) "widget_icon_dark_$index" else "widget_icon_light_$index"
        return R.drawable::class.java.fields.firstOrNull { it.name == name }?.getInt(null)
            ?: R.drawable.widget_icon_light_0
    }

    /** 2x4 专用：填电量与续航，并按夜间模式挑车辆图。 */
    private fun fillReadout(context: Context, views: RemoteViews) {
        val snapshot = WidgetSnapshot.read(context)
        views.setTextViewText(
            context.resources.getIdentifier("widget_soc_value", "id", context.packageName),
            snapshot.socText(context),
        )
        views.setTextViewText(
            context.resources.getIdentifier("widget_range_value", "id", context.packageName),
            snapshot.rangeText(context),
        )
        // 没有读数时把进度清成 0 而不是保留上一次的值：宁可空条，也不要让用户
        // 以为「上次的 80%」是现在的读数。
        val barId = context.resources.getIdentifier("widget_soc_bar", "id", context.packageName)
        views.setProgressBar(barId, 100, (snapshot.socFraction() * 100).toInt(), snapshot.soc == null)

        val carId = context.resources.getIdentifier("widget_car", "id", context.packageName)
        views.setImageViewResource(carId, snapshot.carDrawable(context))
    }

    /** 按钮点击：不进界面，直接交给无界面任务下发。 */
    private fun actionIntent(context: Context, widgetId: Int, action: WidgetShortcuts.Action): PendingIntent {
        val intent = Intent(context, WidgetActionReceiver::class.java).apply {
            this.action = "$actionPrefix.${action.id}"
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            // data 必须唯一：PendingIntent 的相等判定含 data，四格用同一个 action 会互相覆盖。
            data = Uri.parse("xpeng://widget/$widgetId/${action.id}")
        }
        return PendingIntent.getBroadcast(
            context,
            widgetId * 10 + action.slot,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** 点卡片进 App。App 默认就停在车控页，所以只负责把 App 带到前台。 */
    private fun openAppIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            this.action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            data = Uri.parse("xpeng://open/control")
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val TAG = "XPWidget"

        /** 状态变了就重画所有已经放到桌面上的组件；返回重画了几个。 */
        fun refreshAll(context: Context): Int {
            val manager = AppWidgetManager.getInstance(context)
            var count = 0
            listOf(
                WidgetQuick2x2Provider::class.java,
                WidgetQuick1x4Provider::class.java,
                WidgetDashboard2x4Provider::class.java,
            ).forEach { cls ->
                val ids = manager.getAppWidgetIds(ComponentName(context, cls))
                if (ids.isEmpty()) return@forEach
                count += ids.size
                val intent = Intent(context, cls).apply { action = AppWidgetManager.ACTION_APPWIDGET_UPDATE }
                intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
                context.sendBroadcast(intent)
            }
            return count
        }
    }
}

/** 2x2：四宫格快捷操作。 */
class WidgetQuick2x2Provider : BaseWidgetProvider(R.layout.widget_quick_2x2) {
    override val actionPrefix = "com.logiconsole.xpcarinfo.widget.ACTION_2X2"
}

/** 1x4：一行四格快捷操作。 */
class WidgetQuick1x4Provider : BaseWidgetProvider(R.layout.widget_quick_1x4) {
    override val actionPrefix = "com.logiconsole.xpcarinfo.widget.ACTION_1X4"
}

/** 2x4：读数 + 车辆图 + 四格操作。 */
class WidgetDashboard2x4Provider : BaseWidgetProvider(R.layout.widget_dashboard_2x4) {
    override val actionPrefix = "com.logiconsole.xpcarinfo.widget.ACTION_2X4"
    override val showsReadout = true
}
