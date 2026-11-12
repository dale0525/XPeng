package com.logiconsole.xpcarinfo.bridge

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener

/**
 * 「哪些 WiFi 下、哪些地点附近不自动解闭锁」需要的两样系统能力：读 WiFi 名、读一次坐标。
 *
 * 为什么要单独一个模块：这两样都和蓝牙无关，塞进 `XpengBleModule` 只会让那个已经很长的
 * 类更难读；它们要的权限（定位）也与蓝牙那套 BLUETOOTH_* 完全不同。
 *
 * 省电是这里的硬约束，两个探针的代价差着一个量级：
 * - 读当前 SSID 只查一次系统状态，不占射频、不进定位；
 * - 取坐标会唤醒定位链路。所以 `currentLocation` 先看有没有足够新的 last-known
 *   （通常瞬时返回），没有才做一次限时的单次定位请求，且到点立刻收手。
 * 本模块不持有任何周期性任务，调用方不来问，它就完全不耗电。
 */
@SuppressLint("MissingPermission")
class XpengWifiLocationModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "XpengWifiLocation"

    private val handler = Handler(Looper.getMainLooper())
    private var permissionPromise: Promise? = null

    @ReactMethod fun addListener(name: String) = Unit
    @ReactMethod fun removeListeners(count: Double) = Unit

    /** 读 WiFi 名的前提是定位权限：Android 10 起 SSID 被当作位置信息，没权限只回占位串。 */
    private fun locationPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31) arrayOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    ) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun missingLocation() =
        locationPermissions().filter { ctx.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

    private fun locationEnabled(): Boolean {
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled
            else lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        } catch (_: Exception) {
            false
        }
    }

    private fun status(): WritableMap = Arguments.createMap().apply {
        putBoolean("granted", missingLocation().isEmpty())
        // 系统定位开关关着时，即便权限齐全也读不到真实 SSID、也取不到坐标。
        // 界面要把这件事说出来，否则用户会以为名单生效了而实际一直不生效。
        putBoolean("locationEnabled", locationEnabled())
        putArray("missing", Arguments.fromList(missingLocation()))
    }

    @ReactMethod fun permissionStatus(p: Promise) { p.resolve(status()) }

    @ReactMethod fun requestPermissions(p: Promise) {
        handler.post {
            if (missingLocation().isEmpty()) { p.resolve(status()); return@post }
            if (permissionPromise != null) { p.reject("E_BUSY", "Permission request pending"); return@post }
            val activity = ctx.currentActivity as? PermissionAwareActivity
            if (activity == null) { p.reject("E_ACTIVITY", "No activity for permission request"); return@post }
            permissionPromise = p
            activity.requestPermissions(missingLocation().toTypedArray(), 9023, PermissionListener { code, _, _ ->
                if (code != 9023) false else {
                    permissionPromise?.resolve(status()); permissionPromise = null; true
                }
            })
        }
    }

    /**
     * 当前连着的 WiFi 名。拿不到时回空串而不是 `<unknown ssid>`：占位串是系统的"读不到"，
     * 若原样上抛，JS 侧还要再识别一次同一个约定的字符串。
     *
     * 用已弃用的 `WifiManager.connectionInfo` 而不是 `ConnectivityManager` 的
     * `NetworkCapabilities.transportInfo`：2026-11-12 在 Pixel 4a / Android 13 / targetSdk 36
     * 上实测，同一个 Wi-Fi 下前者回 `"Logic"`、后者回 `<unknown ssid>`（netId=-1），后者是
     * 系统按位置敏感字段脱敏后的结果，拿它做判定等于名单永远不生效。官方对这条旧 API 的
     * 说明也是「继续可用」。仍需 `ACCESS_FINE_LOCATION` + 系统定位开关打开。
     */
    @ReactMethod fun currentSsid(p: Promise) {
        handler.post {
            val raw = try {
                @Suppress("DEPRECATION")
                ctx.getSystemService(WifiManager::class.java)?.connectionInfo?.ssid
            } catch (_: Exception) { null }
            p.resolve(unquote(raw) ?: "")
        }
    }

    /**
     * 取一次坐标，`null` 表示取不到。
     *
     * @param maxAgeMs 缓存定位的新鲜度门槛：超过它就去要一次新定位，**而不是**判成没有位置。
     * @param timeoutMs 允许这次定位最多占用多久；`<= 0` 表示不等待、只可能用缓存。
     *
     * 2026-11-12 真机故障：原实现把超过 maxAgeMs 的 last-known 直接丢弃并返回 null。
     * 人静止在家时系统不再更新 last-known（实测同一个点停了 4.4 小时、provider 全是 OFF），
     * 于是「静止」被误判成「不知道在哪」，按 100 m 半径记录的规则永不命中，车辆在半径内
     * 仍反复解闭锁。陈旧只说明该去要一次新定位——实测主动请求 4 秒内就能返回。
     */
    @ReactMethod fun currentLocation(maxAgeMs: Double, timeoutMs: Double, p: Promise) {
        handler.post {
            if (missingLocation().isNotEmpty() || !locationEnabled()) { p.resolve(null); return@post }
            val lm = ctx.getSystemService(LocationManager::class.java)
            if (lm == null) { p.resolve(null); return@post }
            val maxAge = maxAgeMs.toLong().coerceIn(0L, 6 * 3600_000L)
            val newest = newestLastKnown(lm)
            val age = newest?.let { System.currentTimeMillis() - it.time }
            if (newest != null && age != null && age <= maxAge) {
                p.resolve(toMap(newest))
                return@post
            }
            if (timeoutMs <= 0) { p.resolve(null); return@post }
            // 缓存过期或没有缓存：要一次新的。拿不到再退回缓存（比"不知道在哪"更有用，
            // 距离判定本身会把远点排除掉，不存在"旧点导致误挡"的风险）。
            requestOnce(lm, timeoutMs.toLong().coerceIn(500L, 30_000L)) { fix ->
                p.resolve((fix ?: newest)?.let(::toMap))
            }
        }
    }

    private fun newestLastKnown(lm: LocationManager): Location? {
        var best: Location? = null
        for (provider in lm.allProviders) {
            val loc = try { lm.getLastKnownLocation(provider) } catch (_: Exception) { null } ?: continue
            if (best == null || loc.time > best.time) best = loc
        }
        return best
    }

    private fun toMap(location: Location) = Arguments.createMap().apply {
        putDouble("lat", location.latitude)
        putDouble("lon", location.longitude)
        putDouble("accuracyM", if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0)
        putDouble("timeMs", location.time.toDouble())
    }

    /**
     * 单次定位：向所有已启用的 provider 各挂一个一次性回调，谁先给出定位就用谁，到点全撤。
     * 用 `requestSingleUpdate` 而不是持续 `requestLocationUpdates`——本功能只在判距动作
     * 发生的那一瞬需要位置，持续监听是纯耗电。
     */
    private fun requestOnce(lm: LocationManager, timeoutMs: Long, done: (Location?) -> Unit) {
        val providers = ArrayList<String>()
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (try { lm.isProviderEnabled(provider) } catch (_: Exception) { false }) providers.add(provider)
        }
        if (providers.isEmpty()) { done(null); return }

        var settled = false
        val listeners = ArrayList<LocationListener>()
        lateinit var timeout: Runnable

        fun finish(location: Location?) {
            if (settled) return
            settled = true
            handler.removeCallbacks(timeout)
            listeners.forEach { listener -> try { lm.removeUpdates(listener) } catch (_: Exception) {} }
            listeners.clear()
            done(location)
        }

        timeout = Runnable { finish(null) }
        for (provider in providers) {
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) { handler.post { finish(location) } }
                override fun onProviderEnabled(provider: String) = Unit
                override fun onProviderDisabled(provider: String) = Unit
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
            }
            listeners.add(listener)
            try {
                @Suppress("DEPRECATION")
                lm.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            } catch (_: Exception) {
                listeners.remove(listener)
            }
        }
        if (listeners.isEmpty()) { done(null); return }
        handler.postDelayed(timeout, timeoutMs)
    }

    /** 去掉系统给 SSID 加的双引号；`<unknown ssid>`、空串一律当作"读不到"。 */
    private fun unquote(raw: String?): String? {
        if (raw == null) return null
        var value = raw.trim()
        if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.substring(1, value.length - 1)
        value = value.trim()
        if (value.isEmpty() || value == "<unknown ssid>" || value == "0x") return null
        return value
    }
}