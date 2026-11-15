package com.logiconsole.xpcarinfo.bridge

/**
 * 链路占位判定。
 *
 * 2026-11-13 之前原生模块只维护一个 `gatt`/`scanning` 字段，于是车辆数字钥匙的常驻
 * 连接（登录后的默认状态）会把充电桩弹窗的 `connectProfile` 一律挡成 `E_BUSY`。车与桩
 * 是两台独立外设，限制只应针对「同一地址重复连接」这一件事。
 */
internal object BleLinks {
    /**
     * 这次连接该不该放行。
     *
     * @param active 当前已占位的地址（大写）
     * @param mac 本次请求的地址
     */
    fun admit(active: Collection<String>, mac: String): Boolean = mac.uppercase() !in active
}
