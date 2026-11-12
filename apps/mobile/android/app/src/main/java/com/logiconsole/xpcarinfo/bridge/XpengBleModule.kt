package com.logiconsole.xpcarinfo.bridge

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
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
    private var serviceId = vehicleServiceId
    private var writeId = vehicleWriteId
    private var readId = vehicleReadId
    private var gatt: BluetoothGatt? = null
    private var writer: BluetoothGattCharacteristic? = null
    private var ccDescriptor: BluetoothGattDescriptor? = null
    private var cccdValue: ByteArray? = null
    private var pendingWriteHandle: Int? = null
    private var pendingReadHandle: Int? = null
    private var connecting: Promise? = null
    private var deadline: Runnable? = null
    // Connection retry state. Captured on a real phone 2026-11-07: the official app
    // connects with auto:false, gets status 133 (GATT_CONN_FAILED_ESTABLISHMENT),
    // then reconnects ~40 ms later with auto:true and succeeds. We replicate exactly
    // that, so the first attempt is auto:false and 133 escalates to auto:true.
    private var connectMac: String? = null
    private var connectTimeoutMs: Long = 10000
    private var connectAttemptsLeft = 0
    private var permissionPromise: Promise? = null
    private var scanning: Promise? = null
    private var scanner: BluetoothLeScanner? = null
    private var scanDeadline: Runnable? = null
    private var scanTargetMac: String? = null
    private val devices = linkedMapOf<String, WritableMap>()
    private data class Write(val bytes: ByteArray, val promise: Promise)
    private val writes = ArrayDeque<Write>()
    private var writing = false
    /** 原生侧常驻计时器（重连/重鉴权），见 scheduleKeepAliveTimer。 */
    private data class KaTimer(val mac: String, val reauth: Boolean, val runnable: Runnable)
    private val kaTimers = mutableListOf<KaTimer>()
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
        override fun onScanFailed(code: Int) { handler.post {
            proximityMac = null
            scanner2?.stopScan(this); scanner2 = null
            emit("xpeng-ble-proximity-failed", Arguments.createMap().apply { putInt("code", code) })
        } }
    }
    private var scanner2: BluetoothLeScanner? = null
    private var proximityTick: Runnable? = null

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
        if (scanning != null || gatt != null) { p.reject("E_BUSY", "BLE operation pending"); return@post }
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

    private fun clearDeadline() { deadline?.let { handler.removeCallbacks(it) }; deadline = null }
    /**
     * On a 133 during establishment, retry with a direct connect.
     *
     * Status 133 happens intermittently on the first attempt (the official app hits
     * it too). We retry with auto:false rather than auto:true because a background
     * (auto:true) connect does not reliably deliver onClientConnectionState on this
     * stack — every successful self-client connect here used auto:false. A short
     * delay lets the controller settle before the next attempt.
     */
    private fun retryOnEstablishFailure(reason: String): Boolean {
        val mac = connectMac
        if (connectAttemptsLeft <= 0 || mac == null) return false
        connectAttemptsLeft -= 1
        val old = gatt
        gatt = null; writer = null; ccDescriptor = null; cccdValue = null
        old?.disconnect(); old?.close()
        handler.postDelayed({
            try {
                gatt = adapter!!.getRemoteDevice(mac).connectGatt(ctx, false, callback, BluetoothDevice.TRANSPORT_LE)
            } catch (e: Exception) {
                close(e.message ?: "Connect retry failed")
            }
        }, 200)
        return true
    }
    private fun armDeadline(timeoutMs: Long = 10000) {
        clearDeadline()
        deadline = Runnable { close("BLE operation timeout") }.also { handler.postDelayed(it, timeoutMs) }
    }
    private fun close(reason: String) {
        clearDeadline()
        val old = gatt; val mac = old?.device?.address
        gatt = null; writer = null; ccDescriptor = null; cccdValue = null
        pendingWriteHandle = null; pendingReadHandle = null
        serviceId = vehicleServiceId; writeId = vehicleWriteId; readId = vehicleReadId
        connectMac = null; connectAttemptsLeft = 0
        connecting?.reject("E_CONNECTION", reason); connecting = null
        while (writes.isNotEmpty()) writes.removeFirst().promise.reject("E_WRITE", reason)
        writing = false
        old?.disconnect(); old?.close()
        if (mac != null) emit("xpeng-ble-disconnect", Arguments.createMap().apply {
            putString("mac", mac); putString("reason", reason)
        })
    }
    /**
     * Locate characteristics by attribute handle when a UUID is not known.
     *
     * On Android `instanceId` is the attribute handle. The pile's write handle is
     * `0x0006` and its notify handle `0x0003`, both confirmed by captured HCI, so a
     * profile can be addressed without ever learning the 128-bit UUIDs.
     */
    private class HandleMatch(
        val service: BluetoothGattService?,
        val write: BluetoothGattCharacteristic?,
        val read: BluetoothGattCharacteristic?,
    )

    private fun resolveByHandle(g: BluetoothGatt): HandleMatch {
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

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) { handler.post {
            if (g !== gatt) return@post
            if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) {
                if (status == 133 && retryOnEstablishFailure("GATT disconnected: $status")) return@post
                close("GATT disconnected: $status")
            }
            else if (state == BluetoothProfile.STATE_CONNECTED && !g.discoverServices()) close("Service discovery failed to start")
        } }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) { handler.post {
            if (g !== gatt) return@post
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
    }
    private fun incoming(g: BluetoothGatt, uuid: UUID, value: ByteArray) { handler.post {
        if (g !== gatt || uuid != readId) return@post
        emit("xpeng-ble-data", Arguments.createMap().apply {
            putString("mac", g.device.address); putString("hex", value.joinToString("") { "%02x".format(it.toInt() and 255) })
        })
    } }
    @ReactMethod fun connect(mac: String, p: Promise) = startConnect(mac, false, 10000, p)
    @ReactMethod fun connectDiagnostic(mac: String, p: Promise) = startConnect(mac, true, 45000, p)
    private fun startConnect(mac: String, autoConnect: Boolean, timeoutMs: Long, p: Promise) { handler.post {
        if (!ready(p)) return@post
        if (gatt != null || scanning != null) { p.reject("E_BUSY", "BLE operation pending"); return@post }
        if (!BluetoothAdapter.checkBluetoothAddress(mac)) { p.reject("E_ADDRESS", "Invalid BLE address"); return@post }
        connecting = p; armDeadline(timeoutMs)
        connectMac = mac; connectTimeoutMs = timeoutMs; connectAttemptsLeft = 3
        try { gatt = adapter!!.getRemoteDevice(mac).connectGatt(ctx, autoConnect, callback, BluetoothDevice.TRANSPORT_LE) }
        catch (e: Exception) { close(e.message ?: "Connect failed") }
        if (gatt == null) close("Connection could not start")
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
        if (gatt != null || scanning != null) { p.reject("E_BUSY", "BLE operation pending"); return@post }
        if (!BluetoothAdapter.checkBluetoothAddress(mac)) { p.reject("E_ADDRESS", "Invalid BLE address"); return@post }
        if (!timeoutMs.isFinite() || timeoutMs < 1 || timeoutMs > 60000) { p.reject("E_TIMEOUT", "Invalid connect timeout"); return@post }
        val service = serviceUuid?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        val write = writeUuid?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        val read = readUuid?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        if (service == null && (write == null || read == null) && (writeHandle == null || readHandle == null)) {
            p.reject("E_PROFILE", "Profile needs a service UUID or both characteristic handles"); return@post
        }
        serviceId = service ?: vehicleServiceId
        writeId = write ?: vehicleWriteId
        readId = read ?: vehicleReadId
        pendingWriteHandle = writeHandle?.toInt()
        pendingReadHandle = readHandle?.toInt()
        connecting = p; armDeadline(timeoutMs.toLong())
        connectMac = mac; connectTimeoutMs = timeoutMs.toLong(); connectAttemptsLeft = 3
        try { gatt = adapter!!.getRemoteDevice(mac).connectGatt(ctx, autoConnect, callback, BluetoothDevice.TRANSPORT_LE) }
        catch (e: Exception) { close(e.message ?: "Connect failed") }
        if (gatt == null) close("Connection could not start")
    } }

    /** Enumerate the connected device's services and characteristics for profiling. */
    @ReactMethod fun dumpServices(p: Promise) { handler.post {
        val g = gatt
        if (g == null) { p.reject("E_NOT_READY", "No GATT connection"); return@post }
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
    private fun drain() {
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
    @ReactMethod fun write(hex: String, p: Promise) { handler.post {
        if (!ready(p)) return@post
        if (gatt == null || writer == null || connecting != null) { p.reject("E_NOT_READY", "BLE not subscribed"); return@post }
        if (hex.isEmpty() || hex.length % 2 != 0 || !hex.all { it.digitToIntOrNull(16) != null }) {
            p.reject("E_HEX", "Invalid hexadecimal frame"); return@post
        }
        val bytes = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        writes.addLast(Write(bytes, p)); drain()
    } }
    @ReactMethod fun disconnect(p: Promise) { handler.post { close("Disconnected by client"); p.resolve(null) } }
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
        stopProximityLoop()
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
            stopProximityLoop()
            p.reject("E_SCAN", e.message ?: "startProximityScan failed")
            return@post
        }
        p.resolve(null)
        scheduleProximityTick()
      }
    }

    @ReactMethod fun stopProximityScan(p: Promise) { handler.post { stopProximityLoop(); p.resolve(null) } }

    /** 判距链路的可观测性：release 包下 JS 的 console.warn 不进 logcat。 */
    @ReactMethod fun logProximity(message: String, p: Promise) {
        android.util.Log.i("XpengBle", "proximity $message")
        p.resolve(null)
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
            // 判距是本功能唯一的输入，扫不到车与"车很远"在行为上无法区分，真车排障
            // 只能靠这行：没有它就只能看到"没触发"，看不出是没扫到还是阈值不对。
            val seenAny = proximityAllResults
            proximityAllResults = 0
            android.util.Log.i("XpengBle", "proximity round=$proximityRounds rssi=${rssi ?: "none"} results=$seenAny")
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

    private fun stopProximityLoop() {
        proximityMac = null
        proximityTick?.let { handler.removeCallbacks(it) }; proximityTick = null
        try { scanner2?.stopScan(proximityCallback) } catch (_: Exception) {}
        scanner2 = null
    }

    override fun invalidate() {
        handler.post { endScan("Module invalidated"); close("Module invalidated")
            kaTimers.forEach { handler.removeCallbacks(it.runnable) }; kaTimers.clear()
            permissionPromise?.reject("E_INVALIDATED", "Module invalidated"); permissionPromise = null }
        stopProximityLoop()
        super.invalidate()
    }

    private companion object {
        /**
         * 判距采样窗口：每 1.5 s 汇总一次本轮最强 RSSI。
         *
         * 决策延迟 = (样本数-1) × 窗口 + 停留时间，窗口是唯一能压的项：5 s × 2 + 3 s ≈ 15 s
         * 实测，用户 2026-11-12 明确嫌慢。降到 1.5 s 后是 1.5 s × 2 + 1.5 s = 4.5 s，
         * 而"连续 3 轮够强"的安全判据一字未动（真机静态序列最长只能连跑 2 轮，降到 2 轮
         * 就会误解锁，已用测试钉住）。
         *
         * 省电影响很小：扫描模式仍是 BALANCED（控制器自行占空比，与窗口无关），
         * 变的只是 JS 侧汇总频率——3.5 s 多一次唤醒，相对于每轮扫描本身可忽略。
         */
        const val PROXIMITY_WINDOW_MS = 1500L
    }
}
