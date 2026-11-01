package com.logiconsole.xpcarinfo.net

import android.util.Log
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocket

/**
 * 最小可用的 MQTT 3.1.1 客户端，只覆盖车控需要的动作：
 * CONNECT → SUBSCRIBE → PUBLISH → 收下行 → PINGREQ 保活。
 *
 * 为什么不引 Paho：需要的能力只有这些，而 Paho 的 Android 版约 200 KB 且会带入
 * 一套自己的线程模型；手写报文编解码在 JS 侧已经做过一遍（packages/protocol），
 * 这里只是把同一套报文搬进 Java，便于复用同一份测试向量。
 *
 * 传输是标准 MQTT over TLS（`iot-app.xiaopeng.com:8883`），broker 只校验用户名
 * 密码，不要求客户端证书。
 */
class MqttClient(
    private val host: String,
    private val port: Int,
    private val clientId: String,
    private val username: String,
    private val password: String,
    private val onMessage: (topic: String, payload: String) -> Unit,
    private val onDisconnect: (reason: String) -> Unit,
) {
    private var socket: SSLSocket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null
    @Volatile private var running = false
    private var reader: Thread? = null
    private var pinger: Thread? = null

    fun connect(timeoutMs: Int = 15_000): Int {
        val raw = Socket()
        raw.connect(InetSocketAddress(host, port), timeoutMs)
        raw.soTimeout = timeoutMs
        val factory = XpengTls.socketFactory(host, null, null)
        val ssl = factory.createSocket(raw, host, port, true) as SSLSocket
        ssl.startHandshake()
        socket = ssl
        input = ssl.inputStream
        output = ssl.outputStream

        write(encodeConnect())
        // PacketReader 返回的是 [headerByte, ...body]：CONNACK 的 body 是
        // [ackFlags, returnCode]，所以 returnCode 在索引 2，不是 3。
        val connack = readPacket() ?: throw IllegalStateException("broker 未返回 CONNACK")
        val rc = if (connack.size >= 3) connack[2].toInt() else -1
        Log.i("MqttClient", "CONNACK bytes=${connack.size} rc=$rc")
        if (rc != 0) return rc

        // 连上之后必须取消读超时：MQTT 是长连接，车端可能几十分钟没有下行，
        // 留着 15 s 超时会让 readLoop 抛 SocketTimeoutException 并误判为断线。
        // 存活靠 PINGREQ/PINGRESP 判定，不靠 socket 超时。
        ssl.soTimeout = 0

        running = true
        reader = Thread { readLoop() }.apply { isDaemon = true; start() }
        pinger = Thread { pingLoop() }.apply { isDaemon = true; start() }
        return 0
    }

    fun subscribe(topics: List<String>) {
        val body = mutableListOf<Byte>()
        body += byteArrayOf(0, 1).toList()
        for (t in topics) {
            val b = t.toByteArray(Charsets.UTF_8)
            body += byteArrayOf((b.size shr 8).toByte(), b.size.toByte()).toList()
            body += b.toList()
            body += 1 // QoS 1
        }
        write(frame(0x82, body.toByteArray()))
    }

    fun publish(topic: String, payload: String) {
        val t = topic.toByteArray(Charsets.UTF_8)
        val p = payload.toByteArray(Charsets.UTF_8)
        val body = ByteArray(2 + t.size + p.size)
        body[0] = (t.size shr 8).toByte()
        body[1] = t.size.toByte()
        System.arraycopy(t, 0, body, 2, t.size)
        System.arraycopy(p, 0, body, 2 + t.size, p.size)
        write(frame(0x30, body))
    }

    fun disconnect() {
        running = false
        try {
            write(frame(0xE0, ByteArray(0)))
        } catch (_: Exception) {
        }
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        socket = null
    }

    private fun write(bytes: ByteArray) {
        val out = output ?: throw IllegalStateException("未连接")
        synchronized(this) {
            out.write(bytes)
            out.flush()
        }
    }

    private fun readLoop() {
        val reason = try {
            val reader = PacketReader(input ?: return)
            while (running) {
                val pkt = reader.next() ?: break
                when (pkt[0].toInt() shr 4) {
                    3 -> {
                        val qos = (pkt[0].toInt() shr 1) and 0x03
                        val topicLen = ((pkt[1].toInt() and 0xff) shl 8) or (pkt[2].toInt() and 0xff)
                        val topic = String(pkt, 3, topicLen, Charsets.UTF_8)
                        var off = 3 + topicLen
                        if (qos > 0) off += 2
                        onMessage(topic, String(pkt, off, pkt.size - off, Charsets.UTF_8))
                    }
                    13 -> Unit // PINGRESP
                    14 -> break
                    else -> Unit
                }
            }
            "连接已关闭"
        } catch (e: Exception) {
            "读取失败: ${e.message}"
        }
        if (running) {
            running = false
            onDisconnect(reason)
        }
    }

    private fun pingLoop() {
        while (running) {
            try {
                Thread.sleep(45_000)
                if (!running) break
                write(frame(0xC0, ByteArray(0)))
            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.w("MqttClient", "心跳失败: ${e.message}")
                break
            }
        }
    }

    private fun encodeConnect(): ByteArray {
        val cid = clientId.toByteArray(Charsets.UTF_8)
        val user = username.toByteArray(Charsets.UTF_8)
        val pass = password.toByteArray(Charsets.UTF_8)
        val body = ByteArray(2 + 4 + 4 + 2 + cid.size + user.size + pass.size + 4)
        var i = 0
        body[i++] = 0; body[i++] = 4
        body[i++] = 'M'.code.toByte(); body[i++] = 'Q'.code.toByte()
        body[i++] = 'T'.code.toByte(); body[i++] = 'T'.code.toByte()
        body[i++] = 4            // 协议级别 3.1.1
        body[i++] = 0xC2.toByte() // username + password + clean session
        body[i++] = 0; body[i++] = 60 // keepalive
        i = putString(body, i, cid)
        i = putString(body, i, user)
        i = putString(body, i, pass)
        return frame(0x10, body.copyOf(i))
    }

    private fun putString(dst: ByteArray, offset: Int, b: ByteArray): Int {
        dst[offset] = (b.size shr 8).toByte()
        dst[offset + 1] = b.size.toByte()
        System.arraycopy(b, 0, dst, offset + 2, b.size)
        return offset + 2 + b.size
    }

    private fun frame(header: Int, body: ByteArray): ByteArray {
        val len = mutableListOf<Byte>()
        var v = body.size
        do {
            var d = v % 128
            v /= 128
            if (v > 0) d = d or 0x80
            len += d.toByte()
        } while (v > 0)
        val out = ByteArray(1 + len.size + body.size)
        out[0] = header.toByte()
        for (k in len.indices) out[1 + k] = len[k]
        System.arraycopy(body, 0, out, 1 + len.size, body.size)
        return out
    }

    private fun readPacket(): ByteArray? {
        val reader = PacketReader(input ?: return null)
        return reader.next()
    }

    /** 从流里切出完整报文，返回 `[headerByte, ...body]`。 */
    private class PacketReader(private val input: InputStream) {
        fun next(): ByteArray? {
            val head = input.read()
            if (head < 0) return null
            var mult = 1
            var len = 0
            while (true) {
                val b = input.read()
                if (b < 0) return null
                len += (b and 0x7f) * mult
                mult *= 128
                if (b and 0x80 == 0) break
            }
            val body = ByteArray(len)
            var read = 0
            while (read < len) {
                val n = input.read(body, read, len - read)
                if (n < 0) return null
                read += n
            }
            val out = ByteArray(1 + len)
            out[0] = head.toByte()
            System.arraycopy(body, 0, out, 1, len)
            return out
        }
    }
}
