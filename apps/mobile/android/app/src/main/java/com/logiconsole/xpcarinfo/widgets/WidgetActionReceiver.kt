package com.logiconsole.xpcarinfo.widgets

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.logiconsole.xpcarinfo.widgets.headless.WidgetHeadlessService

/**
 * 组件上按钮的点击入口。
 *
 * 点按后不打开任何界面：起一个无界面 JS 任务由 RN 侧下发车控指令（签名与取 MQTT
 * 凭据都在 TS，原生做不了）。任务结束后由 JS 把结果写回快照并重画组件。
 *
 * 这里只做转发与兜底：进程被杀时 JS 任务起不来，此时退回打开 App，
 * 至少让用户看到一个「需要登录」或「App 未就绪」的界面，而不是点了没反应。
 */
class WidgetActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        // 两个前缀都接受：三档组件各自的 actionPrefix 不同，但处理逻辑一致。
        val commandId = action.substringAfterLast('.')
        if (commandId.isBlank()) return
        Log.i(BaseWidgetProvider.TAG, "action received command=$commandId")

        val started = WidgetHeadlessService.start(context, commandId)
        if (!started) {
            // 起不来只可能是系统限制（极少见）。此时打开 App 让用户自己再点一次，
            // 总比按下去毫无反应好；不做「转交后自动补发」——那需要在 App 里多存一份
            // 待办指令并处理重复下发，收益不抵复杂度。
            Log.w(BaseWidgetProvider.TAG, "headless start refused, falling back to app for $commandId")
            val open = Intent(context, com.logiconsole.xpcarinfo.MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            runCatching { context.startActivity(open) }
        }
    }
}
