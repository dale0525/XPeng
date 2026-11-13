package com.logiconsole.xpcarinfo.widgets.headless

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.logiconsole.xpcarinfo.widgets.BaseWidgetProvider

/**
 * 无界面的 JS 任务入口：组件上的按钮点了以后，靠它把 App 的 RN 运行时拉起来跑一次下发。
 *
 * 为什么不在原生侧直接发：签名（两层）、密钥池、MQTT 凭据全在 TypeScript，
 * 原生只有 TLS 与 MQTT 帧传输。要么把整条协议搬进 Kotlin，要么让 JS 跑一次；
 * 用户选了后者，代价是冷启动时第一次点击要等 1–3 秒。
 *
 * 任务名与 JS 侧 `AppRegistry.registerHeadlessTask('XpengWidgetAction')` 必须一致。
 */
class WidgetHeadlessService : HeadlessJsTaskService() {

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val commandId = intent?.getStringExtra(EXTRA_COMMAND) ?: return null
        val data = Arguments.createMap().apply {
            putString("commandId", commandId)
            // 亮暗不影响下发，但 JS 侧要据此在插件结果里带上主题标记，
            // 免得同一次点击在亮暗两种桌面上重画成不同结论。
            putBoolean("nightMode", isNightMode(this@WidgetHeadlessService))
        }
        return HeadlessJsTaskConfig(
            TASK_KEY,
            data,
            // 下发链路最多要等车端回执 20s（carLink.send 的默认超时），再留出
            // 取凭据与建连的余量；超时只会终止 JS 运行时，不影响车端动作。
            TIMEOUT_MS,
            // 允许前台执行：用户可能正开着 App 就点桌面组件，此时不应该被拒绝。
            true,
        )
    }

    private fun isNightMode(context: Context): Boolean =
        (context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES

    companion object {
        const val TAG = BaseWidgetProvider.TAG
        const val TASK_KEY = "XpengWidgetAction"
        const val EXTRA_COMMAND = "xpeng.widget.command"
        private const val TIMEOUT_MS = 45_000L

        /**
         * 起一次下发任务；返回是否成功交给了系统。
         *
         * Android 12+ 后台起服务有限制，但组件点击属于用户显式交互，不在限制范围内，
         * 所以这里不做前台服务包装——多一条常驻通知只会让用户困惑。
         */
        fun start(context: Context, commandId: String): Boolean {
            val intent = Intent(context, WidgetHeadlessService::class.java).apply {
                putExtra(EXTRA_COMMAND, commandId)
            }
            // 只能 startService：HeadlessJsTaskService 不会 startForeground，
            // 用 startForegroundService 起它会在 5 秒内因没发通知被系统判 ANR 杀掉。
            // 组件点击属于用户显式交互，App 在临时白名单内，后台起普通服务是允许的。
            return runCatching {
                context.startService(intent)
                true
            }.getOrElse { e ->
                Log.w(TAG, "start headless failed: ${e.javaClass.simpleName} ${e.message}")
                false
            }
        }
    }
}
