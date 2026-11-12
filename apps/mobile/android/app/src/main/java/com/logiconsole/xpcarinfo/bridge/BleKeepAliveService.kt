package com.logiconsole.xpcarinfo.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
import android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import com.logiconsole.xpcarinfo.MainActivity
import com.logiconsole.xpcarinfo.R

/**
 * 常驻 BLE 连接的前台服务。它只做一件事：把进程抬到前台服务级别，让 App 退到
 * 后台后 RN 的 JS 线程与 GATT 连接继续存活，系统内存吃紧时不按后台进程回收。
 *
 * 这里不碰蓝牙、也不做重连。GATT 由 `XpengBleModule` 持有，重连状态机在 JS 侧
 * `packages/protocol/src/ble-link.ts`：重连要看账号切换与 UI 状态，那些信息只在 JS 侧。
 *
 * 局限：前台服务降低被杀概率，不等于免疫。进程真被系统杀掉（厂商省电策略、用户
 * 强停）之后连接就断了，直到 App 重新打开。
 */
class BleKeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private val wakeLockTimeoutMs = 10 * 60 * 1000L
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val renewWakeLock = object : Runnable {
        override fun run() {
            acquireWakeLock()
            handler.postDelayed(this, wakeLockTimeoutMs - 60_000L)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 进不了前台就立刻退出，不留在后台占进程：`BLUETOOTH_CONNECT` 在服务启动后
        // 才被撤销时，`startForeground` 会抛 SecurityException（Android 14 起
        // `connectedDevice` 类型校验），实测会让整个进程崩掉。
        if (!promote(intent?.getStringExtra(EXTRA_TEXT).orEmpty())) {
            stopSelf()
        } else {
            // 前台服务只把进程抬到前台，不阻止 CPU 休眠；息屏进 Doze 后 JS 定时器
            // 全停，重连与重鉴权都不执行（实测：息屏 150 s 内一次重连都没有）。持一把
            // partial wake lock 让 CPU 在息屏时保持清醒。
            acquireWakeLock()
            handler.removeCallbacks(renewWakeLock)
            handler.postDelayed(renewWakeLock, wakeLockTimeoutMs - 60_000L)
        }
        // 不用 START_STICKY：进程被杀后即使服务被拉起，Activity 未启动、RN 运行时也不会
        // 初始化，连接照样不存在。让系统别假装恢复，比拉起一个空壳诚实。
        return START_NOT_STICKY
    }

    /** 重取：Doze 会把超过 10 分钟的 wakelock 判为失效，故到期前释放并重新获取。 */
    @Suppress("WakelockTimeout")
    private fun acquireWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xpcarinfo:ble-keep-alive").apply {
            setReferenceCounted(false)
            acquire(wakeLockTimeoutMs)
        }
    }

    private fun releaseWakeLock() {
        handler.removeCallbacks(renewWakeLock)
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    override fun onDestroy() {
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        detach(this)
        super.onDestroy()
    }

    /**
     * 抬到前台并设通知；权限不满足时返回 false 而不是抛出去。
     *
     * 服务同时声明了 `connectedDevice`（蓝牙钥匙）与 `location`（判「哪些地点附近不解锁」要
     * 取一次坐标）。`location` 类型只在前台服务运行期间才允许在后台读位置，而判距动作恰好
     * 都发生在后台——没有这个类型，取坐标在后台会被系统直接拒。
     *
     * 但 `location` 类型有运行时前提：用户必须已授予定位权限且系统定位开关打开，否则
     * `startForeground` 抛 SecurityException，整个服务连同蓝牙保活一起死。所以定位没就绪时
     * 只按 `connectedDevice` 上报，宁可少一个类型，也不能拖垮现有连接保活。
     */
    private fun promote(text: String): Boolean = try {
        if (Build.VERSION.SDK_INT >= 29) {
            val types = if (locationReady()) FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or FOREGROUND_SERVICE_TYPE_LOCATION
                        else FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            startForeground(NOTIFICATION_ID, buildNotification(text), types)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification(text))
        }
        true
    } catch (e: SecurityException) {
        false
    }

    /** 与 `XpengWifiLocationModule` 的判据保持一致：权限齐 + 系统定位开着。 */
    private fun locationReady(): Boolean {
        val granted = Build.VERSION.SDK_INT < 23 ||
            checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!granted) return false
        return try {
            getSystemService(android.location.LocationManager::class.java)?.isLocationEnabled == true
        } catch (_: Exception) {
            false
        }
    }

    private fun buildNotification(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "蓝牙钥匙连接", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "保持与车辆数字钥匙模块的蓝牙连接"
                    setShowBadge(false)
                },
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("蓝牙钥匙")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_ble)
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "ble-keep-alive"
        private const val NOTIFICATION_ID = 4021
        private const val EXTRA_TEXT = "text"

        /**
         * 存活实例。服务已在跑时直接改通知，不再走 `startForegroundService`：
         * Android 12 起从后台启动前台服务会被拒，而连接状态变化正是发生在后台。
         */
        private var instance: BleKeepAliveService? = null

        /**
         * 启动服务（或就地把通知文案改掉）。
         *
         * Android 14 起 `connectedDevice` 类型的前台服务要求调用方持有
         * `BLUETOOTH_CONNECT`，缺了会在 `startForeground` 里抛 SecurityException
         * 直接崩掉服务。用户可能在设置里随时撤销这项权限，所以这里先看权限再拉起。
         */
        @JvmStatic
        fun start(context: Context, text: String) {
            if (Build.VERSION.SDK_INT >= 31 &&
                context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED) return
            val running = instance
            if (running != null) {
                if (!running.promote(text)) running.stopSelf()
                return
            }
            val intent = Intent(context, BleKeepAliveService::class.java).putExtra(EXTRA_TEXT, text)
            context.startForegroundService(intent)
        }

        /** 服务未运行时静默返回：拉起服务只能在 App 前台做，见 `XpengBleModule.updateKeepAlive`。 */
        @JvmStatic
        fun update(text: String) {
            val running = instance ?: return
            if (!running.promote(text)) running.stopSelf()
        }

        @JvmStatic
        fun stop(context: Context) {
            instance = null
            context.stopService(Intent(context, BleKeepAliveService::class.java))
        }

        @JvmStatic
        fun attach(service: BleKeepAliveService) { instance = service }

        @JvmStatic
        fun detach(service: BleKeepAliveService) { if (instance === service) instance = null }
    }

    override fun onCreate() {
        super.onCreate()
        attach(this)
    }
}