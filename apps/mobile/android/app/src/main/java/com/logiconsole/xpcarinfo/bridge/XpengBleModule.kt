package com.logiconsole.xpcarinfo.bridge

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.io.File
import java.util.UUID

@SuppressLint("MissingPermission")
class XpengBleModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "XpengBle"
    private val handler = Handler(Looper.getMainLooper())
    private val adapter get() = ctx.getSystemService(BluetoothManager::class.java)?.adapter
    // Defaults are the vehicle digital-key profile. A Bluetooth charging pile uses
    // a different service and characteristic set, so `connectProfile` overrides
    // these per connection instead of hard-coding one device class.
    private val vehicleServiceId = UUID.fromString("0000ed28-abab-406d-832d-7ad799b479f7")
    private val vehicleWriteId = UUID.fromString("0000ed28-abab-9c8c-2801-b1a015e46d6c")
    private val vehicleReadId = UUID.fromString("0000ed28-abab-9c8c-2802-d3df573ff530")
    private val cccdId = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private data class Write(val bytes: ByteArray, val promise: Promise)
    private var permissionPromise: Promise? = null
    private var scanning: Promise? = null
    private var scanner: BluetoothLeScanner? = null
    private var scanDeadline: Runnable? = null
    private var scanTargetMac: String? = null
    private val devices = linkedMapOf<String, WritableMap>()
    /** 原生侧常驻计时器（重连/重鉴权），见 scheduleKeepAliveTimer。 */
    private data class KaTimer(val mac: String, val reauth: Boolean, val runnable: Runnable)
    private val kaTimers = mutableListOf<KaTimer>()

    /**
     * 抑制条件（WiFi / 坐标）的复查计时器。
     *
     * 抑制必须在扫描之前判定，否则人待在抑制区里也要白跑判距；但抑制条件会自己变化
     * （走出 WiFi 覆盖、离开那个地点），而后台 JS 定时器不可靠，所以由原生按固定间隔
     * 通知 JS 重新判定一次，命中就继续不扫，不命中才把扫描拉起来。
     */
    private var suppressionTimer: Runnable? = null

    /**
     * 连接态 RSSI 探针的常驻计时（见 startLinkRssiProbe）。
     *
     * 与判距扫描一样必须在原生侧计时：Doze 下 RN 的 `setTimeout` 一次都不触发，
     * 采样节奏乱掉就无法与广播采样逐点对齐。
     */
    private var linkRssiProbeMac: String? = null
    private var linkRssiProbeTick: Runnable? = null

    /**
     * 一条 GATT 链路的全部状态。
     *
     * 这些字段 2026-11-13 之前是模块级单例，于是同一时刻只允许一条链路：车辆数字钥匙的
     * 常驻连接是登录后的默认状态，充电桩弹窗的 `connectProfile` 必然拿到 `E_BUSY`。
     * 车与桩是两台独立外设，手机侧也没有「只能连一台」的限制，限制纯粹来自那份单例状态。
     */
    private inner class Link(val mac: String) {        var gatt: BluetoothGatt? = null
        var writer: BluetoothGattCharacteristic? = null
        var ccDescriptor: BluetoothGattDescriptor? = null
        var cccdValue: ByteArray? = null
        var pendingWriteHandle: Int? = null
        var pendingReadHandle: Int? = null
        var connecting: Promise? = null
        var deadline: Runnable? = null
        /**
         * 133 之后的延迟重连。必须可取消：close() 之后它若照旧执行，会建出一条
         * `connecting == null` 的链路，CCCD 永远不写、deadline 也没人重新 arm，
         * 于是这条 gatt 再也不会被关闭——槽位永久泄漏。
         */
        var retry: Runnable? = null
        var serviceId = vehicleServiceId
        var writeId = vehicleWriteId
        var readId = vehicleReadId
        var attemptsLeft = 0
        val writes = ArrayDeque<Write>()
        var writing = false

        fun clearDeadline() { deadline?.let { handler.removeCallbacks(it) }; deadline = null }
        fun armDeadline(timeoutMs: Long = 10000) {
            clearDeadline()
            deadline = Runnable { close("BLE operation timeout") }.also { handler.postDelayed(it, timeoutMs) }
        }

        /**
         * 读一次连接态 RSSI（探针，用于判定「保持连接时能否据此判距」）。
         *
         * 为什么要单独探：车端在已有 GATT 连接时不广播（2026-11-12 实测），所以
         * 「常驻连接」与「广播扫描判距」互斥。若连接态 RSSI 可用，就能在保持连接
         * 的同时判距，从而绕开扫描与建连争用控制器（吃 133）那条路。
         * 回调是异步的，结果经 `xpeng-ble-link-rssi` 上报。
         */
        fun readRssi() {
            val g = gatt ?: run {
                emit("xpeng-ble-link-rssi", Arguments.createMap().apply {
                    putString("mac", mac); putNull("rssi"); putString("error", "no-gatt")
                })
                return
            }
            val started = try { g.readRemoteRssi() } catch (e: Exception) {
                XpengLog.log("ble", "readRemoteRssi threw: ${e.message}")
                false
            }
            if (!started) emit("xpeng-ble-link-rssi", Arguments.createMap().apply {
                putString("mac", mac); putNull("rssi"); putString("error", "not-started")
            })
        }

        fun close(reason: String) {
            XpengLog.log("ble", "close mac=$mac reason=$reason")
            clearDeadline()
            retry?.let { handler.removeCallbacks(it) }; retry = null
            val old = gatt
            gatt = null; writer = null; ccDescriptor = null; cccdValue = null
            pendingWriteHandle = null; pendingReadHandle = null
            serviceId = vehicleServiceId; writeId = vehicleWriteId; readId = vehicleReadId
            attemptsLeft = 0
            connecting?.reject("E_CONNECTION", reason); connecting = null
            while (writes.isNotEmpty()) writes.removeFirst().promise.reject("E_WRITE", reason)
            writing = false
            old?.disconnect(); old?.close()
            links.remove(mac)
            // 只有真的持有过链路才上报：建连第一步就失败时没有对端可断。
            if (old != null) emit("xpeng-ble-disconnect", Arguments.createMap().apply {
                putString("mac", mac); putString("reason", reason)
            })
        }

        /**
         * On a 133 during establishment, retry with a direct connect.
         *
         * Status 133 happens intermittently on the first attempt (the official app hits
         * it too). We retry with auto:false rather than auto:true because a background
         * (auto:true) connect does not reliably deliver onClientConnectionState on this
         * stack — every successful self-client connect here used auto:false. A short
         * delay lets the controller settle before the next attempt.
         */
        fun retryOnEstablishFailure(reason: String): Boolean {
            if (attemptsLeft <= 0) return false
            attemptsLeft -= 1
            val old = gatt
            gatt = null; writer = null; ccDescriptor = null; cccdValue = null
            old?.disconnect(); old?.close()
            val runnable = Runnable {
                retry = null
                try {
                    gatt = adapter!!.getRemoteDevice(mac).connectGatt(ctx, false, callback, BluetoothDevice.TRANSPORT_LE)
                } catch (e: Exception) {
                    close(e.message ?: "Connect retry failed")
                }
            }
            retry = runnable
            handler.postDelayed(runnable, 200)
            return true
        }

        fun drain() {
            if (writing || writes.isEmpty()) return
            val g = gatt ?: return; val wr = writer ?: return
            writing = true; armDeadline()
            val bytes = writes.first().bytes
            val started = if (Build.VERSION.SDK_INT >= 33)
                g.writeCharacteristic(wr, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            else {
                wr.setValue(bytes)
                wr.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION") g.writeCharacteristic(wr)
            }
            if (!started) close("Characteristic write failed to start")
        }

        /**
         * Locate characteristics by attribute handle when a UUID is not known.
         *
         * On Android `instanceId` is the attribute handle. The pile's write handle is
         * `0x0006` and its notify handle `0x0003`, both confirmed by captured HCI, so a
         * profile can be addressed without ever learning the 128-bit UUIDs.
         */
        fun resolveByHandle(g: BluetoothGatt): HandleMatch {
            val wh = pendingWriteHandle
            val rh = pendingReadHandle
            if (wh == null && rh == null) return HandleMatch(null, null, null)
            var svc: BluetoothGattService? = null
            var write: BluetoothGattCharacteristic? = null
            var read: BluetoothGattCharacteristic? = null
            for (s in g.services) for (c in s.characteristics) {
                if (wh != null && c.instanceId == wh) { write = c; svc = s }
                if (rh != null && c.instanceId == rh) { read = c; if (svc == null) svc = s }
            }
            return HandleMatch(svc, write, read)
        }

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) { handler.post {
                if (g !== gatt) return@post
                // 建连结果必须落盘：排查「为什么没连上」时，status 与 state 是唯一的一手事实。
                XpengLog.log("ble", "conn state=$state status=$status mac=${g.device.address}")
                if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) {
                    if (status == 133 && retryOnEstablishFailure("GATT disconnected: $status")) return@post
                    close("GATT disconnected: $status")
                }
                else if (state == BluetoothProfile.STATE_CONNECTED && !g.discoverServices()) close("Service discovery failed to start")
            } }
            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) { handler.post {
                if (g !== gatt) return@post
                XpengLog.log("ble", "services discovered status=$status")
                if (status != BluetoothGatt.GATT_SUCCESS) { close("Service discovery failed: $status"); return@post }
                val byHandle = resolveByHandle(g)
                val service = byHandle.service ?: g.getService(serviceId)
                val rd = byHandle.read ?: service?.getCharacteristic(readId)
                val wr = byHandle.write ?: service?.getCharacteristic(writeId)
                // When resolved by handle the profile UUIDs are unknown; adopt the real
                // characteristic UUIDs so the notification filter in `incoming` matches.
                if (rd != null) readId = rd.uuid
                if (wr != null) writeId = wr.uuid
                writer = wr
                val desc = rd?.getDescriptor(cccdId)
                if (rd == null || wr == null || desc == null) {
                    close("GATT profile not found (service=$serviceId write=$writeId read=$readId handles=${pendingWriteHandle}/${pendingReadHandle})")
                    return@post
                }
                if (!g.setCharacteristicNotification(rd, true)) { close("Notification registration failed"); return@post }
                // Official HCI: requestMtu(160) -> 247, then CCCD 0x0200 (indicate).
                // The car packs the three 0x0082 verify fragments into one 30-byte
                // indication, which the default 23-byte MTU cannot carry.
                ccDescriptor = desc
                cccdValue = if (rd.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0)
                    BluetoothGattDescriptor.ENABLE_INDICATION_VALUE else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                if (!g.requestMtu(160)) close("MTU request failed to start")
            } }
            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) { handler.post {
                if (g !== gatt || connecting == null) return@post
                if (status != BluetoothGatt.GATT_SUCCESS) { close("MTU negotiation failed: $status"); return@post }
                val desc = ccDescriptor; val value = cccdValue
                if (desc == null || value == null) { close("CCCD state missing"); return@post }
                val started = if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(desc, value) == BluetoothStatusCodes.SUCCESS else {
                    desc.setValue(value)
                    @Suppress("DEPRECATION") g.writeDescriptor(desc)
                }
                if (!started) close("CCCD write failed to start")
            } }
            override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) { handler.post {
                if (g !== gatt || connecting == null) return@post
                if (descriptor != ccDescriptor && descriptor.uuid != cccdId) return@post
                if (status != BluetoothGatt.GATT_SUCCESS) close("CCCD write failed: $status") else {
                    clearDeadline(); val p = connecting; connecting = null; p?.resolve(null)
                }
            } }
            override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) { handler.post {
                if (g !== gatt || characteristic.uuid != writeId || !writing) return@post
                clearDeadline()
                if (status != BluetoothGatt.GATT_SUCCESS) { close("GATT write failed: $status"); return@post }
                writes.removeFirst().promise.resolve(null); writing = false; drain()
            } }
            @Deprecated("Legacy Android callback")
            override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                if (Build.VERSION.SDK_INT < 33) incoming(g, characteristic.uuid, characteristic.value.copyOf())
            }
            override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
                incoming(g, characteristic.uuid, value.copyOf())
            }

            /**
             * 连接态 RSSI 的回调（探针）。`status != GATT_SUCCESS` 时 rssi 无意义，
             * 必须报 null 而不是 0——0 会被判距逻辑当成"贴脸"，比不报还危险。
             */
            override fun onReadRemoteRssi(g: BluetoothGatt, rssi: Int, status: Int) { handler.post {
                val ok = status == BluetoothGatt.GATT_SUCCESS
                // 同时落文件：真机对照采样要不接电脑也能事后取（`adb pull` 或界面导出）。
                // 记「读到的值」本身，不在这里做任何滤波或判定。
                XpengLog.log("probe", "link-rssi mac=${g.device.address} " +
                    (if (ok) "rssi=$rssi" else "status=$status"))
                emit("xpeng-ble-link-rssi", Arguments.createMap().apply {
                    putString("mac", g.device.address)
                    if (ok) putInt("rssi", rssi) else putNull("rssi")
                    if (!ok) putInt("status", status)
                })
            } }
        }

        fun incoming(g: BluetoothGatt, uuid: UUID, value: ByteArray) { handler.post {
            if (g !== gatt || uuid != readId) return@post
            XpengLog.log("ble", "rx ${value.size}B ${value.joinToString("") { "%02x".format(it.toInt() and 255) }}")
            emit("xpeng-ble-data", Arguments.createMap().apply {
                putString("mac", g.device.address); putString("hex", value.joinToString("") { "%02x".format(it.toInt() and 255) })
            })
        } }
    }

    private class HandleMatch(
        val service: BluetoothGattService?,
        val write: BluetoothGattCharacteristic?,
        val read: BluetoothGattCharacteristic?,
    )

    /** 按 MAC 索引的活跃链路；同一 MAC 不允许并发两条，不同 MAC 互不阻塞。 */
    private val links = linkedMapOf<String, Link>()

    /**
     * 后台判距用的常驻扫描。它的计时也必须在原生侧：息屏进 Doze 后 RN 的
     * setTimeout 一次都不触发（实测被踢后数分钟零重连），扫描节奏若交给 JS 就会停摆。
     */
    private var proximityMac: String? = null
    private var proximityRssi = 0
    private var proximityRounds = 0
    private var proximityAllResults = 0
    private val proximityCallback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) { handler.post {
            if (proximityMac == null) return@post
            proximityAllResults += 1
            if (!result.device.address.equals(proximityMac, ignoreCase = true)) return@post
            // 同一轮里保留最强的一次：车在移动/遮挡变化时 RSSI 抖动大，取最强比取最后一条稳。
            if (result.rssi > proximityRssi) proximityRssi = result.rssi
        } }
        // 扫描失败要主动上报：否则服务静默空转，用户会以为功能开着却从不触发。
        // 但"重启换窗口"那一瞬的失败是预期内的（停旧启新之间的竞态），此时只能记一行，
        // 否则一次刷新抖动就会把整个判距扫描拆掉，反而更糟。
        override fun onScanFailed(code: Int) { handler.post {
            if (refreshingProximity) {
                XpengLog.log("ble", "scan refresh reported failed: code=$code (kept)")
                return@post
            }
            XpengLog.log("ble", "scan failed: code=$code")
            proximityMac = null
            proximityTick?.let { handler.removeCallbacks(it) }; proximityTick = null
            scanner2?.stopScan(this); scanner2 = null
            emit("xpeng-ble-proximity-failed", Arguments.createMap().apply { putInt("code", code) })
        } }
    }
    private var scanner2: BluetoothLeScanner? = null
    private var proximityTick: Runnable? = null
    /** 定期重启扫描的计时器（对付系统把长跑扫描挂起，见 scheduleProximityRefresh）。 */
    private var proximityRefresh: Runnable? = null
    /** 正在做"重启扫描换活跃窗口"的瞬间：此时 onScanFailed 属预期抖动，不能拆扫描。 */
    private var refreshingProximity = false

    private fun permissions() = if (Build.VERSION.SDK_INT >= 31)
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    private fun missing() = permissions().filter { ctx.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    private fun status(): WritableMap = Arguments.createMap().apply {
        putBoolean("supported", adapter != null)
        putBoolean("granted", missing().isEmpty())
        putBoolean("bluetoothEnabled", missing().isEmpty() && adapter?.isEnabled == true)
        putArray("missing", Arguments.fromList(missing()))
    }
    @ReactMethod fun permissionStatus(p: Promise) { p.resolve(status()) }
    @ReactMethod fun requestPermissions(p: Promise) = handler.post {
        if (missing().isEmpty()) { p.resolve(status()); return@post }
        if (permissionPromise != null) { p.reject("E_BUSY", "Permission request pending"); return@post }
        val activity = ctx.currentActivity as? PermissionAwareActivity
        if (activity == null) { p.reject("E_ACTIVITY", "No activity for permission request"); return@post }
        permissionPromise = p
        activity.requestPermissions(missing().toTypedArray(), 9021, PermissionListener { code, _, _ ->
            if (code != 9021) false else {
                permissionPromise?.resolve(status()); permissionPromise = null; true
            }
        })
    }.let { Unit }
    private fun ready(p: Promise): Boolean {
        if (missing().isNotEmpty()) { p.reject("E_PERMISSION", "Bluetooth permission required"); return false }
        if (adapter?.isEnabled != true) { p.reject("E_BLUETOOTH_OFF", "Bluetooth is off or unsupported"); return false }
        return true
    }
    private fun emit(name: String, data: WritableMap) {
        if (ctx.hasActiveReactInstance()) ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, data)
    }
    @ReactMethod fun addListener(name: String) {}
    @ReactMethod fun removeListeners(count: Double) {}

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) { handler.post {
            // Without a target MAC all named devices are reported, not only car
            // digital keys: a Bluetooth charging pile advertises an `XPAC…` name and
            // was previously invisible because the filter hard-coded "XPED".
            val name = result.scanRecord?.deviceName
            if (scanning != null && (scanTargetMac != null || (name != null && name.isNotEmpty()))) devices[result.device.address] = Arguments.createMap().apply {
                putString("mac", result.device.address); putString("name", result.scanRecord?.deviceName)
                putInt("rssi", result.rssi)
            }
        } }
        override fun onScanFailed(code: Int) { handler.post { endScan("Scan failed: $code") } }
    }
    private fun endScan(error: String? = null) {
        scanDeadline?.let { handler.removeCallbacks(it) }; scanDeadline = null
        scanner?.stopScan(scanCallback); scanner = null
        val p = scanning; scanning = null
        if (error != null) p?.reject("E_SCAN", error)
        else if (scanTargetMac != null) p?.resolve(Arguments.createMap().apply {
            val target = devices.entries.firstOrNull { it.key.equals(scanTargetMac, ignoreCase = true) }?.value
            putBoolean("targetSeen", target != null)
            if (target != null) putInt("rssi", target.getInt("rssi")) else putNull("rssi")
            putInt("total", devices.size)
        })
        else p?.resolve(Arguments.createArray().apply { devices.values.forEach { pushMap(it) } })
        scanTargetMac = null
        devices.clear()
    }
    @ReactMethod fun scan(timeoutMs: Double, p: Promise) = startScan(null, timeoutMs, p)
    @ReactMethod fun scanTarget(mac: String, timeoutMs: Double, p: Promise) = startScan(mac, timeoutMs, p)
    private fun startScan(targetMac: String?, timeoutMs: Double, p: Promise) { handler.post {
        if (!ready(p)) return@post
        // 扫描是控制器级资源，与「有没有链路」无关：车辆常驻连接不该挡住找桩。
        if (scanning != null) { p.reject("E_BUSY", "BLE scan already running"); return@post }
        if (!timeoutMs.isFinite() || timeoutMs < 1 || timeoutMs > 60000) { p.reject("E_TIMEOUT", "Invalid scan timeout"); return@post }
        scanning = p; scanTargetMac = targetMac; devices.clear(); scanner = adapter?.bluetoothLeScanner
        try {
            // GATT service UUID is not necessarily present in the advertising packet.
            scanner!!.startScan(null,
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
            scanDeadline = Runnable { endScan() }.also { handler.postDelayed(it, timeoutMs.toLong()) }
        } catch (e: Exception) { endScan(e.message ?: "Scan failed") }
    } }
    @ReactMethod fun stopScan(p: Promise) { handler.post { endScan(); p.resolve(null) } }

    /**
     * 车控用的短超时连接：人离车几十米时蓝牙必然连不上，等满 10 秒只是在白等，
     * 超时才退云端会把一次锁车拖到十几秒。3 秒够车旁的正常建连，不够就立刻走云端。
     */
    /**
     * 周期读连接态 RSSI 的探针（站位对照采样用）。
     *
     * 与广播采样**不能同时跑**：车端在已有 GATT 连接时不广播（2026-11-12 实测），
     * 所以两遍分开做——先连上跑本探针采「连接态 RSSI」，再断开跑判距扫描采「广播 RSSI」，
     * 同一站位各采一遍，之后比对哪条曲线更有分辨力。
     *
     * 另一个必须由本探针回答的问题：`HCI_Read_RSSI` 读的是该连接上**最后一次收到报文**
     * 的 RSSI，而常驻连接约 127 s 才有一次重鉴权流量。若期间无报文，读数可能在两个
     * 流量点之间冻住不变——那样它就不能用来判距。日志里逐点记值即可看出是否冻住。
     */
    @ReactMethod fun startLinkRssiProbe(mac: String, intervalMs: Double, p: Promise) { handler.post {
        val m = mac.uppercase()
        stopLinkRssiProbeInternal("restart")
        linkRssiProbeMac = m
        val interval = if (intervalMs.isFinite() && intervalMs >= 500) intervalMs.toLong() else PROBE_INTERVAL_MS
        val tick = object : Runnable {
            override fun run() {
                val cur = linkRssiProbeMac ?: return
                links[cur]?.readRssi()
                handler.postDelayed(this, interval)
            }
        }
        linkRssiProbeTick = tick
        XpengLog.log("probe", "link-rssi probe start mac=$m interval=${interval}ms")
        handler.postDelayed(tick, 0L)
        p.resolve(null)
    } }

    @ReactMethod fun stopLinkRssiProbe(p: Promise) { handler.post {
        stopLinkRssiProbeInternal("stopped by JS"); p.resolve(null)
    } }

    private fun stopLinkRssiProbeInternal(reason: String) {
        val was = linkRssiProbeMac
        linkRssiProbeMac = null
        linkRssiProbeTick?.let { handler.removeCallbacks(it) }; linkRssiProbeTick = null
        if (was != null) XpengLog.log("probe", "link-rssi probe stop mac=$was reason=$reason")
    }

    @ReactMethod fun connect(mac: String, p: Promise) = startConnect(mac, false, 3000, p)
    @ReactMethod fun connectDiagnostic(mac: String, p: Promise) = startConnect(mac, true, 45000, p)

    /**
     * 探针入口：读一次指定链路的连接态 RSSI，结果走 `xpeng-ble-link-rssi` 事件。
     *
     * 只做读，不改任何连接状态；链路不存在时立刻回一个带 `error` 的事件，让调用方
     * 能区分「没链路」与「读了但车端没回」。
     */
    @ReactMethod fun readLinkRssi(mac: String, p: Promise) { handler.post {
        val link = links[mac.uppercase()]
        if (link == null) {
            emit("xpeng-ble-link-rssi", Arguments.createMap().apply {
                putString("mac", mac.uppercase()); putNull("rssi"); putString("error", "no-link")
            })
        } else {
            link.readRssi()
        }
        p.resolve(null)
    } }
    private fun startConnect(mac: String, autoConnect: Boolean, timeoutMs: Long, p: Promise) { handler.post {
        if (!ready(p)) return@post
        if (!BluetoothAdapter.checkBluetoothAddress(mac)) { p.reject("E_ADDRESS", "Invalid BLE address"); return@post }
        val link = openLink(mac, p) ?: return@post
        link.connecting = p; link.armDeadline(timeoutMs); link.attemptsLeft = 3
        try { link.gatt = adapter!!.getRemoteDevice(link.mac).connectGatt(ctx, autoConnect, link.callback, BluetoothDevice.TRANSPORT_LE) }
        catch (e: Exception) { link.close(e.message ?: "Connect failed") }
        if (link.gatt == null) link.close("Connection could not start")
    } }

    /**
     * Connect using an explicit GATT profile instead of the vehicle digital-key one.
     *
     * The pile's service `1b7e8251-...` is known, but the 128-bit UUIDs of its write
     * and notify characteristics were never recovered (the official HCI slice has no
     * complete characteristic declaration). Pass `writeHandle`/`readHandle` instead:
     * they are addressable by attribute handle (`0x0006` write, `0x0003` notify), so
     * a client does not need those UUIDs.
     */
    @ReactMethod fun connectProfile(
        mac: String,
        serviceUuid: String?,
        writeUuid: String?,
        readUuid: String?,
        writeHandle: Double?,
        readHandle: Double?,
        autoConnect: Boolean,
        timeoutMs: Double,
        p: Promise,
    ) { handler.post {
        if (!ready(p)) return@post
        if (!BluetoothAdapter.checkBluetoothAddress(mac)) { p.reject("E_ADDRESS", "Invalid BLE address"); return@post }
        if (!timeoutMs.isFinite() || timeoutMs < 1 || timeoutMs > 60000) { p.reject("E_TIMEOUT", "Invalid connect timeout"); return@post }
        val service = serviceUuid?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        val write = writeUuid?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        val read = readUuid?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        if (service == null && (write == null || read == null) && (writeHandle == null || readHandle == null)) {
            p.reject("E_PROFILE", "Profile needs a service UUID or both characteristic handles"); return@post
        }
        val link = openLink(mac, p) ?: return@post
        link.serviceId = service ?: vehicleServiceId
        link.writeId = write ?: vehicleWriteId
        link.readId = read ?: vehicleReadId
        link.pendingWriteHandle = writeHandle?.toInt()
        link.pendingReadHandle = readHandle?.toInt()
        link.connecting = p; link.armDeadline(timeoutMs.toLong()); link.attemptsLeft = 3
        try { link.gatt = adapter!!.getRemoteDevice(link.mac).connectGatt(ctx, autoConnect, link.callback, BluetoothDevice.TRANSPORT_LE) }
        catch (e: Exception) { link.close(e.message ?: "Connect failed") }
        if (link.gatt == null) link.close("Connection could not start")
    } }

    /** 为一条新链路占位；同一 MAC 已有链路时按 E_BUSY 拒绝，不同 MAC 互不阻塞。 */
    private fun openLink(mac: String, p: Promise): Link? {
        val key = mac.uppercase()
        if (!BleLinks.admit(links.keys, key)) { p.reject("E_BUSY", "BLE operation pending for $key"); return null }
        return Link(key).also { links[key] = it }
    }

    private fun linkOrReject(mac: String, p: Promise): Link? {
        val link = links[mac.uppercase()]
        if (link == null) { p.reject("E_NOT_READY", "No BLE link for $mac"); return null }
        return link
    }

    /** Enumerate the connected device's services and characteristics for profiling. */
    @ReactMethod fun dumpServices(mac: String, p: Promise) { handler.post {
        val g = linkOrReject(mac, p)?.gatt ?: return@post
        val result = Arguments.createArray()
        for (svc in g.services) {
            val item = Arguments.createMap()
            item.putString("service", svc.uuid.toString())
            val chars = Arguments.createArray()
            for (c in svc.characteristics) {
                val ch = Arguments.createMap()
                ch.putString("uuid", c.uuid.toString())
                ch.putInt("handle", c.instanceId)
                ch.putInt("properties", c.properties)
                chars.pushMap(ch)
            }
            item.putArray("characteristics", chars)
            result.pushMap(item)
        }
        p.resolve(result)
    } }
    @ReactMethod fun write(mac: String, hex: String, p: Promise) { handler.post {
        if (!ready(p)) return@post
        val link = linkOrReject(mac, p) ?: return@post
        if (link.gatt == null || link.writer == null || link.connecting != null) { p.reject("E_NOT_READY", "BLE not subscribed"); return@post }
        if (hex.isEmpty() || hex.length % 2 != 0 || !hex.all { it.digitToIntOrNull(16) != null }) {
            p.reject("E_HEX", "Invalid hexadecimal frame"); return@post
        }
        val bytes = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        XpengLog.log("ble", "tx ${bytes.size}B $hex")
        link.writes.addLast(Write(bytes, p)); link.drain()
    } }
    @ReactMethod fun disconnect(mac: String, p: Promise) { handler.post {
        links[mac.uppercase()]?.close("Disconnected by client")
        p.resolve(null)
    } }
    /**
     * 把进程抬到前台服务级别，让 App 退到后台后 GATT 连接与 JS 线程继续存活。
     *
     * 只改进程优先级，不碰连接本身：断线与重连由 JS 侧 `BleLink` 负责，
     * 因为重连要参考账号切换与 UI 状态，那些信息只在 JS 侧。
     */
    @ReactMethod fun startKeepAlive(text: String, p: Promise) { handler.post {
        requestNotificationPermission()
        try {
            BleKeepAliveService.start(ctx, text); p.resolve(null)
        } catch (e: Exception) {
            p.reject("E_KEEPALIVE", e.message ?: "Cannot start keep-alive service")
        }
    } }
    /**
     * 只刷新通知文案，不负责拉起服务。
     *
     * 拉起前台服务只能在 App 处于前台时做（Android 12 起后台启动会被拒），而连接状态
     * 变化大多发生在后台。所以启动时机固定在 `startKeepAlive`，这里服务没在跑就什么都不做。
     */
    @ReactMethod fun updateKeepAlive(text: String, p: Promise) { handler.post {
        BleKeepAliveService.update(text); p.resolve(null)
    } }
    @ReactMethod fun stopKeepAlive(p: Promise) { handler.post {
        BleKeepAliveService.stop(ctx); p.resolve(null)
    } }

    /**
     * 发一条一次性动作通知（如「已自动锁车」）。
     *
     * 走原生而不是 JS 的推送库：动作发生在后台，此刻 JS 可能已被系统冻结，
     * 而这条通知的意义正是「事情做完了，即使你没在看手机」。
     */
    @ReactMethod fun notifyEvent(title: String, text: String, p: Promise) { handler.post {
        try {
            BleKeepAliveService.notifyEvent(ctx, title, text)
            p.resolve(null)
        } catch (e: Throwable) {
            p.reject("E_NOTIFY", e.message ?: e.javaClass.simpleName, e)
        }
    } }

    /**
     * 由原生计时驱动常驻连接的重连/重鉴权。
     *
     * 为什么不用 JS 的 `setTimeout`：RN 的定时器走宿主(View)时钟，Activity 退到后台后
     * `JavaTimerManager` 会暂停它——实测息屏后台时断开事件能到 JS、状态也更新成「重连中」，
     * 但退避/重鉴权的 `setTimeout` 一次都不触发（被踢后数分钟零重连）。原生 `Handler`
     * 在前台服务持有 `PARTIAL_WAKE_LOCK` 时主线程消息照常执行，故计时放原生、JS 只响应。
     *
     * 这里还顺带用原生刷新通知文案，避免后台只靠 JS 改文案时被同样冻结。
     */
    @ReactMethod fun scheduleKeepAliveTimer(mac: String, reauth: Boolean, delayMs: Double, p: Promise) { handler.post {
        val m = mac.uppercase()
        clearTimers(m, reauth)
        val runnable = Runnable {
            emit(
                if (reauth) "xpeng-ble-reauth-due" else "xpeng-ble-retry-due",
                Arguments.createMap().apply { putString("mac", m) },
            )
        }
        handler.postDelayed(runnable, delayMs.toLong().coerceAtLeast(0L))
        kaTimers.add(KaTimer(m, reauth, runnable))
        p.resolve(null)
    } }
    @ReactMethod fun cancelKeepAliveTimers(p: Promise) { handler.post {
        kaTimers.forEach { handler.removeCallbacks(it.runnable) }
        kaTimers.clear()
        p.resolve(null)
    } }

    private fun clearTimers(mac: String, reauth: Boolean) {
        val stale = kaTimers.filter { it.mac == mac && it.reauth == reauth }
        if (stale.isEmpty()) return
        stale.forEach { handler.removeCallbacks(it.runnable) }
        kaTimers.removeAll(stale)
    }

    /**
     * 抑制复查：按固定间隔通知 JS 重新判定 WiFi / 坐标，命中就继续不扫。
     *
     * 间隔取 20 s：抑制条件的真实变化（走出 WiFi 覆盖、离开那个地点）都是分钟级的，
     * 20 s 足够及时，又不必像判距那样 1.5 s 一轮——抑制期间本来就不该耗电。
     */
    @ReactMethod fun scheduleSuppressionTimer(intervalMs: Double, p: Promise) { handler.post {
        suppressionTimer?.let { handler.removeCallbacks(it) }
        val runnable = object : Runnable {
            override fun run() {
                emit("xpeng-ble-suppression-due", Arguments.createMap())
                handler.postDelayed(this, intervalMs.toLong().coerceAtLeast(1000L))
            }
        }
        suppressionTimer = runnable
        handler.postDelayed(runnable, intervalMs.toLong().coerceAtLeast(1000L))
        p.resolve(null)
    } }
    @ReactMethod fun cancelSuppressionTimer(p: Promise) { handler.post {
        suppressionTimer?.let { handler.removeCallbacks(it) }
        suppressionTimer = null
        p.resolve(null)
    } }


    /**
     * Android 13 起前台服务的常驻通知要单独授权；没授权服务照样跑，但用户看不到
     * 通知条，也就不知道连接还在。这里只在启动保活时顺带申请，不参与 `ready()` 门禁。
     */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val activity = ctx.currentActivity as? PermissionAwareActivity ?: return
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9022, PermissionListener { code, _, _ -> code == 9022 })
    }

    /**
     * 启动/停止后台判距扫描。
     *
     * 用地址过滤 + `SCAN_MODE_LOW_POWER`：低功耗模式下控制器自己按占空比扫，比 JS 反复
     * start/stop 省电得多。每 `PROXIMITY_WINDOW_MS` 收一次本轮最强 RSSI 并上报，本轮一
     * 次广播都没收到就报 null（等价"很远"）——车端休眠停播时必须能表达"扫不到"，
     * 否则人走了它还以为在附近。
     */
    @ReactMethod fun startProximityScan(mac: String, p: Promise) {
      // 必须用块体：`= handler.post{}` 会让 Kotlin 推断返回 Boolean，TurboModule
      // 解析注解时要求「返回 void 的才可为同步方法」，实测直接崩在模块加载。
      handler.post {
        if (!ready(p)) return@post
        if (adapter?.bluetoothLeScanner == null) { p.reject("E_UNSUPPORTED", "BLE scanning unavailable"); return@post }
        stopProximityLoop("restart")
        proximityMac = mac.uppercase()
        proximityRssi = Int.MIN_VALUE
        proximityRounds = 0
        proximityAllResults = 0
        scanner2 = adapter?.bluetoothLeScanner
        try {
            scanner2!!.startScan(
                listOf(android.bluetooth.le.ScanFilter.Builder().setDeviceAddress(proximityMac).build()),
                ScanSettings.Builder()
                    // 不用 LOW_POWER：实测该模式下本机控制器几乎不给回调（连无关设备都是
                    // results=0），判距永远拿不到 RSSI。BALANCED 的占空比足以判距，
                    // 又不像 LOW_LATENCY 那样一直满速扫。
                    .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
                    .build(),
                proximityCallback,
            )
        } catch (e: Exception) {
            stopProximityLoop("start failed")
            p.reject("E_SCAN", e.message ?: "startProximityScan failed")
            return@post
        }
        XpengLog.log("ble", "scan start: mac=$proximityMac mode=BALANCED")
        p.resolve(null)
        scheduleProximityTick()
        scheduleProximityRefresh()
      }
    }

    /**
     * 停扫描。`reason` 由 JS 侧给：事后要能分辨是"进前台"、"要建连"还是"被抑制"
     * 停的，否则只看到扫描断了却不知道是谁断的，排障只能靠猜。
     */
    @ReactMethod fun stopProximityScan(reason: String, p: Promise) { handler.post { stopProximityLoop(reason); p.resolve(null) } }

    /** 判距链路的可观测性：release 包下 JS 的 console.warn 不进 logcat。 */
    @ReactMethod fun logProximity(message: String, p: Promise) {
        XpengLog.log("ble", message)
        p.resolve(null)
    }

    /**
     * 导出日志到用户可直接取的位置。
     *
     * 返回文件绝对路径；`adb pull <path>` 即可取走。日志本身一直在写外部私有目录，
     * 这里只是把它复制一份到 Download 下，方便不接电脑时用文件管理器取。
     */
    @ReactMethod fun exportLog(p: Promise) { handler.post {
        try {
            val src = XpengLog.file()
            if (src == null) { p.reject("E_NO_LOG", "No log file yet"); return@post }
            val downloads = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
            downloads.mkdirs()
            val dst = File(downloads, "xpcarinfo.log")
            src.copyTo(dst, overwrite = true)
            XpengLog.log("ble", "log exported to ${dst.absolutePath}")
            p.resolve(dst.absolutePath)
        } catch (e: Throwable) {
            p.reject("E_EXPORT", e.message ?: e.javaClass.simpleName)
        }
    } }

    /** 日志文件当前路径与大小，给界面显示"日志在哪、有多少"。 */
    @ReactMethod fun logInfo(p: Promise) { handler.post {
        val f = XpengLog.file()
        p.resolve(Arguments.createMap().apply {
            putString("path", f?.absolutePath)
            putDouble("bytes", (f?.length() ?: 0L).toDouble())
        })
    } }

    /** 清空日志（用户主动要求时用；平时永不自动清理）。 */
    @ReactMethod fun clearLog(p: Promise) { handler.post {
        XpengLog.clear()
        p.resolve(null)
    } }

    /**
     * 定期把判距扫描**整个重启一遍**（stopScan -> startScan）。
     *
     * 为什么必须这么做：2026-11-26 实测，本机（HyperOS）蓝牙栈会用云控的
     * `screenState` / `balancedTimeout` / `backgroundTimeout` 把**长时间运行**的
     * BALANCED 扫描挂起。12:30 起那条扫描跑了一整晚，`dumpsys bluetooth_manager`
     * 里被标成 `Forced` 超时，29925 s 中有 23502 s 处于 `Suspended`——手机息屏的
     * 每一秒几乎一一对应。期间 JS 每 1.5 s 都在采样，但系统一条广播都不递送（全是
     * `s=?`），人走到车旁也不会解锁，直到点亮屏幕把扫描从挂起里放出来。
     *
     * 而**新启动**的扫描能拿到一段活跃窗口：同日 11:45 手机已息屏锁屏，11:47:06
     * 离开地理围栏新起的扫描仍在息屏下 2 秒内扫到车、11:47:18 完成解锁。所以对付
     * 挂起的办法就是别让它一直跑——每隔 [PROXIMITY_REFRESH_MS] 重启一次，每秒都
     * 重新拿到活跃期。重启不碰 GATT 链路（判距只在扫描态做），也不会误触发动作：
     * 判距状态保存在 JS 侧 proximityTracker，重启扫描只清"本轮最强 RSSI"。
     *
     * 30 s 的取值：既要明显短于系统挂起前给的活跃窗口（分钟级），又不能太频繁——
     * 每次 stop/start 本身有开销，且会丢掉亚秒级的在途广播。
     */
    private fun scheduleProximityRefresh() {
        proximityRefresh?.let { handler.removeCallbacks(it) }
        val tick = Runnable { restartProximityScanForFreshWindow() }
        proximityRefresh = tick
        handler.postDelayed(tick, PROXIMITY_REFRESH_MS)
    }

    /**
     * 原地重启扫描：不改变 `proximityMac`、不重置轮次计数，只是向控制器重新下一次
     * `startScan`。失败就当作一次扫描失败上报，交给 JS 的恢复路径处理。
     */
    private fun restartProximityScanForFreshWindow() {
        val mac = proximityMac ?: return
        val sc = scanner2
        if (sc == null) { scheduleProximityRefresh(); return }
        refreshingProximity = true
        try {
            sc.stopScan(proximityCallback)
        } catch (_: Exception) {}
        // 换一个 ScanCallback 实例没有意义——停旧启新用同一个回调即可。
        try {
            sc.startScan(
                listOf(android.bluetooth.le.ScanFilter.Builder().setDeviceAddress(mac).build()),
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build(),
                proximityCallback,
            )
            XpengLog.log("ble", "scan refreshed (fresh active window) mac=$mac")
        } catch (e: Exception) {
            XpengLog.log("ble", "scan refresh failed: ${e.message}")
        } finally {
            refreshingProximity = false
        }
        scheduleProximityRefresh()
    }

    private fun scheduleProximityTick() {
        proximityTick?.let { handler.removeCallbacks(it) }
        val tick = Runnable {
            val mac = proximityMac ?: return@Runnable
            // MIN_VALUE 表示本轮一条广播都没有。
            val seen = proximityRssi != Int.MIN_VALUE
            val rssi = if (seen) proximityRssi else null
            proximityRssi = Int.MIN_VALUE
            proximityRounds += 1
            // 每轮读数不再单独落盘：JS 侧在详细日志打开时会把它与判距器内部状态
            // 合成一行写盘（见 feedProximity），合并后一天只需 5 MB 左右；
            // 这里再写一份既重复又会让日志一天内就滚掉。
            proximityAllResults = 0
            emit("xpeng-ble-proximity-rssi", Arguments.createMap().apply {
                putString("mac", mac)
                if (rssi == null) putNull("rssi") else putInt("rssi", rssi)
                putInt("round", proximityRounds)
            })
            scheduleProximityTick()
        }
        proximityTick = tick
        handler.postDelayed(tick, PROXIMITY_WINDOW_MS)
    }

    /** 扫描启停的全部变更都走这里，`reason` 由调用方给，日志里能看出是谁停的。 */
    private fun stopProximityLoop(reason: String) {
        val wasRunning = proximityMac != null
        proximityMac = null
        proximityTick?.let { handler.removeCallbacks(it) }; proximityTick = null
        proximityRefresh?.let { handler.removeCallbacks(it) }; proximityRefresh = null
        try { scanner2?.stopScan(proximityCallback) } catch (_: Exception) {}
        scanner2 = null
        if (wasRunning) XpengLog.log("ble", "scan stop: $reason")
    }

    override fun invalidate() {
        handler.post { endScan("Module invalidated")
            links.values.toList().forEach { it.close("Module invalidated") }
            kaTimers.forEach { handler.removeCallbacks(it.runnable) }; kaTimers.clear()
            permissionPromise?.reject("E_INVALIDATED", "Module invalidated"); permissionPromise = null }
        stopProximityLoop("module invalidated")
        stopLinkRssiProbeInternal("module invalidated")
        super.invalidate()
    }

    private companion object {
        /**
         * 判距采样窗口：每 1.5 s 汇总一次本轮最强 RSSI。
         *
         * 决策延迟 = (样本数-1) × 窗口 + 停留时间，窗口是唯一能压的项：5 s × 2 + 3 s ≈ 15 s
         * 实测，用户 2026-11-12 明确嫌慢。降到 1.5 s 后是 1.5 s × 2 + 1.5 s = 4.5 s，
         * 而"连续 3 轮够强"的安全判据一字未动（真机静态序列最长只能连跑 2 轮，降到 2 轮
         * 就会误解锁，已用测试固定）。
         *
         * 省电影响很小：扫描模式仍是 BALANCED（控制器自行占空比，与窗口无关），
         * 变的只是 JS 侧汇总频率——3.5 s 多一次唤醒，相对于每轮扫描本身可忽略。
         */
        const val PROXIMITY_WINDOW_MS = 1500L

        /**
         * 连接态 RSSI 探针的默认周期。
         *
         * 取 1.5 s 与判距窗口一致：两遍采样（连接态 / 广播）要对齐比较，
         * 节奏不同就没法逐点对照。探针只在用户手动开启时运行，不影响日常耗电。
         */
        const val PROBE_INTERVAL_MS = 1500L

        /**
         * 判距扫描的重启周期。见 scheduleProximityRefresh 的说明：本机蓝牙栈会把长跑
         * 扫描挂起，只有新启动的扫描才有活跃窗口（2026-11-26 实测）。
         */
        const val PROXIMITY_REFRESH_MS = 30_000L
    }
}
