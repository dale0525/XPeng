package com.logiconsole.xpcarinfo.bridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.logiconsole.xpcarinfo.net.MqttClient
import com.logiconsole.xpcarinfo.net.XpengHttp
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * 把「需要 TLS/mTLS 的 HTTP」与「MQTT 长连接」交给原生实现，JS 侧只做协议与 UI。
 *
 * 为什么不让 JS 发请求：服务端强制 mTLS，客户端证书要装进 KeyStore；RN 自带的
 * fetch 不支持按请求切换客户端证书，而引入 OkHttp 会多出约 1.2 MB 的依赖。
 */
class XpengNetModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    private val io = Executors.newCachedThreadPool()
    private val clients = ConcurrentHashMap<String, MqttClient>()
    private val networkLock = Any()
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var currentNetworkHandle: Long? = null

    override fun getName() = "XpengNet"

    override fun initialize() {
        super.initialize()
        XpengLog.init(ctx)
        registerNetworkCallback()
    }

    override fun invalidate() {
        unregisterNetworkCallback()
        clients.values.toList().forEach { runCatching { it.disconnect() } }
        clients.clear()
        super.invalidate()
    }

    /**
     * 监听系统默认网络变化（WiFi ↔ 移动数据切换、断网与恢复）。
     *
     * 仅靠 `AppState` 切前台重连不够：人在前台切网时 `AppState` 不会变，旧 socket
     * 报 IOException 后会一直卡在离线横幅；后台切网同样不会自愈。用
     * `registerDefaultNetworkCallback` 把系统切网直接透传给 JS，触发立刻重连。
     */
    private fun registerNetworkCallback() {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val handle = network.networkHandle
                val switched: Boolean
                synchronized(networkLock) {
                    val prev = currentNetworkHandle
                    if (prev == handle) return
                    currentNetworkHandle = handle
                    switched = prev != null
                }
                XpengLog.log("net", "network available handle=$handle switched=$switched")
                emitNetworkChange(available = true, switched = switched)
            }

            override fun onLost(network: Network) {
                val handle = network.networkHandle
                synchronized(networkLock) {
                    if (currentNetworkHandle != handle) return
                    currentNetworkHandle = null
                }
                XpengLog.log("net", "network lost handle=$handle")
                emitNetworkChange(available = false, switched = false)
            }
        }
        try {
            synchronized(networkLock) {
                currentNetworkHandle = cm.activeNetwork?.networkHandle
            }
            cm.registerDefaultNetworkCallback(callback)
            connectivityManager = cm
            networkCallback = callback
        } catch (e: Throwable) {
            Log.w("XpengNet", "registerDefaultNetworkCallback 失败: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        val cm = connectivityManager
        val cb = networkCallback
        connectivityManager = null
        networkCallback = null
        if (cm != null && cb != null) {
            runCatching { cm.unregisterNetworkCallback(cb) }
        }
    }

    /** `NativeEventEmitter` 要求模块提供这两个方法，否则构造 emitter 时报警告（开发版会弹出黄色 LogBox 条）。 */
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

    /**
     * POST 到 `host`。`clientCertPem`/`clientKeyPem` 同时给出时启用 mTLS。
     * 返回 `{status, body, setCookie}`。
     */
    @ReactMethod
    fun post(
        host: String,
        path: String,
        headersJson: ReadableMap,
        body: String,
        clientCertPem: String?,
        clientKeyPem: String?,
        promise: Promise,
    ) {
        io.execute {
            try {
                val headers = mutableMapOf<String, String>()
                // ReadableMap 的 keySetIterator 返回 Dynamic（ReadableMapKeySetIterator），
                // Kotlin 的 for-in 不认它的 hasNext/next，只能显式循环
                val it = headersJson.keySetIterator()
                while (it.hasNextKey()) {
                    val k = it.nextKey()
                    headers[k] = headersJson.getString(k) ?: ""
                }
                val res = XpengHttp.post(host, path, headers, body, clientCertPem, clientKeyPem)
                val out = Arguments.createMap()
                out.putInt("status", res.status)
                out.putString("body", res.body)
                val cookies = Arguments.createArray()
                res.setCookie.forEach { cookies.pushString(it) }
                out.putArray("setCookie", cookies)
                promise.resolve(out)
            } catch (e: Throwable) {
                promise.reject("E_HTTP", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    /** 连上 broker 并订阅；同一 id 重复连接会先断开旧的。返回 CONNACK 返回码。 */
    @ReactMethod
    fun mqttConnect(
        id: String,
        host: String,
        port: Int,
        clientId: String,
        username: String,
        password: String,
        topicsJson: ReadableMap,
        promise: Promise,
    ) {
        io.execute {
            try {
                clients.remove(id)?.disconnect()
                val topics = mutableListOf<String>()
                val it = topicsJson.keySetIterator()
                while (it.hasNextKey()) topics += topicsJson.getString(it.nextKey()) ?: ""
                val client = MqttClient(
                    host = host,
                    port = port,
                    clientId = clientId,
                    username = username,
                    password = password,
                    onMessage = { topic, payload -> emitMessage(id, topic, payload) },
                    onDisconnect = { reason -> emitDisconnect(id, reason) },
                )
                clients[id] = client
                val rc = client.connect()
                if (rc == 0) client.subscribe(topics)
                XpengLog.log("mqtt", "connect id=$id host=$host rc=$rc")
                promise.resolve(rc)
            } catch (e: Throwable) {
                android.util.Log.e("XpengNet", "mqttConnect 失败", e)
                XpengLog.log("mqtt", "connect failed id=$id err=${e.message ?: e.javaClass.simpleName}")
                promise.reject("E_MQTT", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    @ReactMethod
    fun mqttPublish(id: String, topic: String, payload: String, promise: Promise) {
        io.execute {
            try {
                val client = clients[id] ?: throw IllegalStateException("未连接")
                client.publish(topic, payload)
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("E_MQTT_PUB", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    @ReactMethod
    fun mqttDisconnect(id: String, promise: Promise) {
        io.execute {
            clients.remove(id)?.disconnect()
            promise.resolve(null)
        }
    }

    /**
     * 读写本地存储：只存会话与少量偏好。`session.v1` 落盘前用 Keystore 包成密文，
     * 取的时候解回原文明文 JSON（JS 侧 `JSON.parse` 不能见到信封）。
     * 解不开只清该 key 并返回 null——`App.tsx` 会吞掉 init 的异常，
     * 一旦 reject 或把密文交出去，界面会永久停在 loading。
     */
    @ReactMethod
    fun storageGet(key: String, promise: Promise) {
        io.execute {
            val prefs = ctx.getSharedPreferences("xpeng", 0)
            val stored = prefs.getString(key, null)
            if (key != "session.v1" || stored == null || !SessionEnvelope.isEnvelope(stored)) {
                if (key == "session.v1" && stored != null) {
                    // 存量明文：原样交给 JS，顺手升级为密文，下次启动即密文。
                    val migrated = runCatching { SessionEnvelope.encrypt(stored) }
                        .onSuccess { prefs.edit().putString(key, it).apply() }
                    Log.i("XPSession", "storageGet legacy plaintext migrated=${migrated.isSuccess} bytes=${stored.length}")
                } else if (key == "session.v1") {
                    Log.i("XPSession", "storageGet no session")
                }
                promise.resolve(stored)
                return@execute
            }
            try {
                val plain = SessionEnvelope.decrypt(stored)
                Log.i("XPSession", "storageGet envelope decrypted bytes=${plain.length}")
                promise.resolve(plain)
            } catch (e: Throwable) {
                // 密钥失效 / 信封损坏：清会话回登录页，保留 device.id，绝不 reject。
                prefs.edit().remove(key).apply()
                Log.w("XPSession", "storageGet decrypt failed, session cleared: ${e.javaClass.simpleName}")
                promise.resolve(null)
            }
        }
    }

    @ReactMethod
    fun storageSet(key: String, value: String, promise: Promise) {
        io.execute {
            try {
                val stored = if (key == "session.v1") SessionEnvelope.encrypt(value) else value
                ctx.getSharedPreferences("xpeng", 0).edit().putString(key, stored).apply()
                if (key == "session.v1") Log.i("XPSession", "storageSet encrypted bytes=${value.length}")
                promise.resolve(null)
            } catch (e: Throwable) {
                Log.e("XPSession", "storageSet failed: ${e.javaClass.simpleName}")
                promise.reject("E_STORAGE", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    @ReactMethod
    fun storageRemove(key: String, promise: Promise) {
        ctx.getSharedPreferences("xpeng", 0).edit().remove(key).apply()
        if (key == "session.v1") Log.i("XPSession", "storageRemove session cleared")
        promise.resolve(null)
    }

    /**
     * 让桌面组件重画：JS 拿到新状态或写完快照后调用。
     *
     * 不把「写快照」也做成原生方法——快照走 storageSet 已经落到同一个
     * SharedPreferences（"xpeng"/"widget.snapshot"），原生读得到；这里只补一个
     * 「该重画了」的触发点，避免 JS 侧每次状态更新都去猜桌面有没有组件。
     */
    @ReactMethod
    fun refreshWidgets(promise: Promise) {
        try {
            val count = com.logiconsole.xpcarinfo.widgets.BaseWidgetProvider.refreshAll(ctx)
            Log.i("XPWidget", "refreshWidgets count=$count")
            promise.resolve(count)
        } catch (e: Throwable) {
            promise.reject("E_WIDGET", e.message ?: e.javaClass.simpleName, e)
        }
    }

    /** console.* 的 TAG 由 RN 固定为 ReactNativeJS、混着框架日志；这里改用业务 TAG 便于一条 filterspec 收全。 */
    @ReactMethod
    fun log(level: String, tag: String, message: String) {
        when (level) {
            "e" -> Log.e(tag, message)
            "w" -> Log.w(tag, message)
            else -> Log.i(tag, message)
        }
    }

    private fun emitMessage(id: String, topic: String, payload: String) {
        val map: WritableMap = Arguments.createMap()
        map.putString("id", id)
        map.putString("topic", topic)
        map.putString("payload", payload)
        ctx.emitDeviceEvent("xpeng-mqtt-message", map)
    }

    private fun emitDisconnect(id: String, reason: String) {
        XpengLog.log("mqtt", "disconnect id=$id reason=$reason")
        val map: WritableMap = Arguments.createMap()
        map.putString("id", id)
        map.putString("reason", reason)
        ctx.emitDeviceEvent("xpeng-mqtt-disconnect", map)
    }

    private fun emitNetworkChange(available: Boolean, switched: Boolean) {
        if (!ctx.hasActiveReactInstance()) return
        val map: WritableMap = Arguments.createMap()
        map.putBoolean("available", available)
        map.putBoolean("switched", switched)
        ctx.emitDeviceEvent("xpeng-network-change", map)
    }
}
