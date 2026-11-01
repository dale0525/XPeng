package com.xpengmobile.bridge

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.xpengmobile.net.MqttClient
import com.xpengmobile.net.XpengHttp
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

    override fun getName() = "XpengNet"

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
                promise.resolve(rc)
            } catch (e: Throwable) {
                android.util.Log.e("XpengNet", "mqttConnect 失败", e)
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

    /** 读写本地存储：只存会话与少量偏好，用 SharedPreferences 就够，不必引 AsyncStorage。 */
    @ReactMethod
    fun storageGet(key: String, promise: Promise) {
        val prefs = ctx.getSharedPreferences("xpeng", 0)
        promise.resolve(prefs.getString(key, null))
    }

    @ReactMethod
    fun storageSet(key: String, value: String, promise: Promise) {
        ctx.getSharedPreferences("xpeng", 0).edit().putString(key, value).apply()
        promise.resolve(null)
    }

    @ReactMethod
    fun storageRemove(key: String, promise: Promise) {
        ctx.getSharedPreferences("xpeng", 0).edit().remove(key).apply()
        promise.resolve(null)
    }

    private fun emitMessage(id: String, topic: String, payload: String) {
        val map: WritableMap = Arguments.createMap()
        map.putString("id", id)
        map.putString("topic", topic)
        map.putString("payload", payload)
        ctx.emitDeviceEvent("xpeng-mqtt-message", map)
    }

    private fun emitDisconnect(id: String, reason: String) {
        val map: WritableMap = Arguments.createMap()
        map.putString("id", id)
        map.putString("reason", reason)
        ctx.emitDeviceEvent("xpeng-mqtt-disconnect", map)
    }
}
