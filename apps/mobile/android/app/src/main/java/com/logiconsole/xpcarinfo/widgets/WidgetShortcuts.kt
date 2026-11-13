package com.logiconsole.xpcarinfo.widgets

/**
 * 组件里的四个快捷操作：与车控页的默认那组一一对应，不另起一套 id。
 *
 * 图标不用字体：launcher 进程拿不到应用内自定义字体，字体直出会变豆腐块，
 * 所以四格图形按亮暗各预渲染成位图（widget_icon_{light,dark}_<序号>.png），
 * 顺序与下面 ALL 的声明顺序一一对应。字形仍取 `src/ui/icons.ts` 的同名图标：
 * `lock_open` / `vpn_key` / `ac_unit` / `highlight`。
 */
object WidgetShortcuts {

    /**
     * @param id     与 JS 侧 `CustomCommandId` 同名，无界面任务按它选指令
     * @param slot   格子序号，用于 PendingIntent 去重
     */
    data class Action(
        val id: String,
        val slot: Int,
        val label: String,
    )

    private val ALL = listOf(
        Action("doorLock", 0, "解锁"),
        Action("remoteUnlock", 1, "远程解锁"),
        Action("acOn", 2, "开启空调"),
        Action("flash", 3, "闪灯"),
    )

    /** 用户确认组件放的就是这默认四个，不跟随车控页的自定义配置。 */
    fun all(): List<Action> = ALL
}
