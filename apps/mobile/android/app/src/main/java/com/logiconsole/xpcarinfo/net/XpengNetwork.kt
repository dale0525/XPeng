package com.logiconsole.xpcarinfo.net

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * 小鹏服务端证书链：叶子证书由 `Xiaopeng Motors Intermediate CA` 签发，而后者
 * 不在系统信任库里（官方 App 也是自带私有 CA 作信任锚）。
 *
 * 这里按**叶子证书的 SHA-256 指纹**做固定校验，不依赖 CA 链：中间 CA 私钥若被
 * 轮换，只信链会静默接受新签发的任意证书，固定叶子则必须随版本显式更新。
 * 证书有效期见下方注释，到期前必须换成本地保存的新指纹：
 *   echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null \
 *     | openssl x509 -noout -fingerprint -sha256
 */
object XpengTls {
    /** 各主机的叶子证书指纹（sha256，小写 hex）。 */
    private val PINS = mapOf(
        // 到期 2029-10-29
        "apps.xiaopeng.com" to
            "5825d0eb5ec1f1c2a67b4509af5ff1226d56d6aad884e7ec32ab0246d7f12c26",
        // 到期 2034-12-10
        "apps-uc.xiaopeng.com" to
            "fcc82b81bf59d644d92d4c188a3d6b0051715c86ddd8f081a0113689a86d3775",
        // 到期 2027-11-12
        "iot-app.xiaopeng.com" to
            "591a3075077516943eecd91da5acf287dad1cb007361e9f76bf923abe8626df6",
    )

    fun socketFactory(
        host: String,
        clientCertPem: String?,
        clientKeyPem: String?,
    ): SSLSocketFactory {
        val expected = PINS[host] ?: throw IllegalArgumentException("未固定的主机: $host")
        val ctx = SSLContext.getInstance("TLS")
        val keyManagers = if (clientCertPem != null && clientKeyPem != null) {
            keyManagersFrom(clientCertPem, clientKeyPem)
        } else {
            null
        }
        ctx.init(keyManagers, arrayOf(PinnedTrustManager(expected)), null)
        return ctx.socketFactory
    }

    private fun keyManagersFrom(certPem: String, keyPem: String): Array<javax.net.ssl.KeyManager> {
        val cert = CertificateFactory.getInstance("X.509")
            .generateCertificate(certPem.byteInputStream()) as X509Certificate
        val der = Base64.decode(
            keyPem.replace(Regex("-----[A-Z ]+-----"), "").replace(Regex("\\s"), ""),
            Base64.DEFAULT,
        )
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
        val ks = KeyStore.getInstance("PKCS12")
        ks.load(null, null)
        ks.setKeyEntry("client", key, charArrayOf(), arrayOf(cert))
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(ks, charArrayOf())
        return kmf.keyManagers
    }

    private class PinnedTrustManager(private val expectedSha256: String) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("证书链为空")
            val fp = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
                .joinToString("") { "%02x".format(it) }
            if (fp != expectedSha256) {
                throw CertificateException("服务端证书指纹不匹配: $fp")
            }
        }
    }
}

/** 一次 HTTP/1.1 POST 的结果。 */
data class HttpResult(val status: Int, val body: String, val setCookie: List<String>)

/**
 * 手写 HTTP/1.1 而不是用 OkHttp：只发一种请求（POST + JSON），需要的能力只有
 * 「自定义 TLS 信任锚 + 可选客户端证书」。手写约 100 行，省掉一个 ~1.2 MB 的
 * 依赖，符合本项目对包体积的要求。
 */
object XpengHttp {
    fun post(
        host: String,
        path: String,
        headers: Map<String, String>,
        body: String,
        clientCertPem: String?,
        clientKeyPem: String?,
        timeoutMs: Int = 20_000,
    ): HttpResult {
        val factory = XpengTls.socketFactory(host, clientCertPem, clientKeyPem)
        val bodyBytes = body.toByteArray(Charsets.UTF_8)
        val head = buildString {
            append("POST ").append(path).append(" HTTP/1.1\r\n")
            append("Host: ").append(host).append("\r\n")
            append("Connection: close\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ").append(bodyBytes.size).append("\r\n")
            append("Accept-Encoding: identity\r\n")
            for ((k, v) in headers) append(k).append(": ").append(v).append("\r\n")
            append("\r\n")
        }

        val raw = Socket().use { plain ->
            plain.connect(InetSocketAddress(host, 443), timeoutMs)
            plain.soTimeout = timeoutMs
            (factory.createSocket(plain, host, 443, true) as SSLSocket).use { ssl ->
                ssl.startHandshake()
                ssl.outputStream.write(head.toByteArray(Charsets.UTF_8))
                ssl.outputStream.write(bodyBytes)
                ssl.outputStream.flush()
                ssl.inputStream.readFully()
            }
        }
        return parse(raw)
    }

    private fun InputStream.readFully(): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private fun parse(raw: ByteArray): HttpResult {
        val sep = indexOfHeaderEnd(raw)
        val headText = String(raw, 0, sep, Charsets.ISO_8859_1)
        val lines = headText.split("\r\n")
        val status = lines.firstOrNull()?.split(" ")?.getOrNull(1)?.toIntOrNull() ?: 0
        val headerMap = mutableMapOf<String, String>()
        val cookies = mutableListOf<String>()
        for (line in lines.drop(1)) {
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            val name = line.substring(0, idx).trim().lowercase()
            val value = line.substring(idx + 1).trim()
            headerMap[name] = value
            if (name == "set-cookie") cookies += value
        }
        val bodyStart = sep + 4
        val bodyBytes = raw.copyOfRange(bodyStart, raw.size)
        val body = if (headerMap["transfer-encoding"]?.contains("chunked") == true) {
            dechunk(bodyBytes)
        } else {
            bodyBytes
        }
        return HttpResult(status, String(body, Charsets.UTF_8), cookies)
    }

    private fun indexOfHeaderEnd(b: ByteArray): Int {
        for (i in 0 until b.size - 3) {
            if (b[i] == 13.toByte() && b[i + 1] == 10.toByte() &&
                b[i + 2] == 13.toByte() && b[i + 3] == 10.toByte()
            ) {
                return i
            }
        }
        return b.size
    }

    private fun dechunk(body: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < body.size) {
            var lineEnd = i
            while (lineEnd < body.size - 1 &&
                !(body[lineEnd] == 13.toByte() && body[lineEnd + 1] == 10.toByte())
            ) {
                lineEnd++
            }
            val sizeText = String(body, i, lineEnd - i, Charsets.ISO_8859_1).trim()
            val size = sizeText.substringBefore(';').toIntOrNull(16) ?: break
            i = lineEnd + 2
            if (size == 0) break
            out.write(body, i, size)
            i += size + 2
        }
        return out.toByteArray()
    }
}
