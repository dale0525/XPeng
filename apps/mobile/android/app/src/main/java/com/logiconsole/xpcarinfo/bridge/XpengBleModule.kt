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
    private val serviceId = UUID.fromString("0000ed28-abab-406d-832d-7ad799b479f7")
    private val writeId = UUID.fromString("0000ed28-abab-9c8c-2801-b1a015e46d6c")
    private val readId = UUID.fromString("0000ed28-abab-9c8c-2802-d3df573ff530")
    private val cccdId = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private var gatt: BluetoothGatt? = null
    private var writer: BluetoothGattCharacteristic? = null
    private var ccDescriptor: BluetoothGattDescriptor? = null
    private var cccdValue: ByteArray? = null
    private var connecting: Promise? = null
    private var deadline: Runnable? = null
    private var permissionPromise: Promise? = null
    private var scanning: Promise? = null
    private var scanner: BluetoothLeScanner? = null
    private var scanDeadline: Runnable? = null
    private var scanTargetMac: String? = null
    private val devices = linkedMapOf<String, WritableMap>()
    private data class Write(val bytes: ByteArray, val promise: Promise)
    private val writes = ArrayDeque<Write>()
    private var writing = false

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
            if (scanning != null && (scanTargetMac != null || result.scanRecord?.deviceName?.startsWith("XPED") == true)) devices[result.device.address] = Arguments.createMap().apply {
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
    private fun armDeadline(timeoutMs: Long = 10000) {
        clearDeadline()
        deadline = Runnable { close("BLE operation timeout") }.also { handler.postDelayed(it, timeoutMs) }
    }
    private fun close(reason: String) {
        clearDeadline()
        val old = gatt; val mac = old?.device?.address
        gatt = null; writer = null; ccDescriptor = null; cccdValue = null
        connecting?.reject("E_CONNECTION", reason); connecting = null
        while (writes.isNotEmpty()) writes.removeFirst().promise.reject("E_WRITE", reason)
        writing = false
        old?.disconnect(); old?.close()
        if (mac != null) emit("xpeng-ble-disconnect", Arguments.createMap().apply {
            putString("mac", mac); putString("reason", reason)
        })
    }
    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) { handler.post {
            if (g !== gatt) return@post
            if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) close("GATT disconnected: $status")
            else if (state == BluetoothProfile.STATE_CONNECTED && !g.discoverServices()) close("Service discovery failed to start")
        } }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) { handler.post {
            if (g !== gatt) return@post
            if (status != BluetoothGatt.GATT_SUCCESS) { close("Service discovery failed: $status"); return@post }
            val service = g.getService(serviceId)
            val rd = service?.getCharacteristic(readId)
            writer = service?.getCharacteristic(writeId)
            val desc = rd?.getDescriptor(cccdId)
            if (rd == null || writer == null || desc == null) { close("ED28 characteristics missing"); return@post }
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
            if (g !== gatt || descriptor.uuid != cccdId || connecting == null) return@post
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
        try { gatt = adapter!!.getRemoteDevice(mac).connectGatt(ctx, autoConnect, callback, BluetoothDevice.TRANSPORT_LE) }
        catch (e: Exception) { close(e.message ?: "Connect failed") }
        if (gatt == null) close("Connection could not start")
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
    override fun invalidate() {
        handler.post { endScan("Module invalidated"); close("Module invalidated")
            permissionPromise?.reject("E_INVALIDATED", "Module invalidated"); permissionPromise = null }
        super.invalidate()
    }
}
