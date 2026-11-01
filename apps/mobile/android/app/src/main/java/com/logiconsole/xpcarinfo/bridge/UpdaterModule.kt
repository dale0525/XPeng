package com.logiconsole.xpcarinfo.bridge

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 应用内更新需要的三样原生能力：读当前安装包版本、GET 一个 URL、把下载好的 APK 交给系统安装器。
 *
 * 不复用 `XpengHttp`：那套手写 HTTP 只做 POST，并且把服务端证书按指纹固定到小鹏的
 * 三台主机上（`XpengTls.PINS`），访问 GitHub 会直接抛「未固定的主机」。这里走系统
 * 信任库的普通 HTTPS。
 */
class UpdaterModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    private val io = Executors.newCachedThreadPool()

    override fun getName() = "XpengUpdater"

    /**
     * 这两个是 `NativeEventEmitter` 的硬要求：RN 构造 emitter 时会检查模块有没有
     * 它们，缺了就打印 `called with a non-null argument without the required
     * addListener method` 警告。开发版里这条警告会顶出一条黄色 LogBox 条盖住页面
     * 底部。本模块只单向发事件，不需要真的增删监听，给空实现即可。
     */
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

    /** 当前安装包的版本与设备主 ABI，用来决定该下哪个分架构包。 */
    @ReactMethod
    fun versionInfo(promise: Promise) {
        try {
            val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            val out = Arguments.createMap()
            out.putString("versionName", pi.versionName ?: "")
            out.putInt("versionCode", installedVersionCode())
            out.putString("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("E_UPDATE_VERSION", e.message ?: e.javaClass.simpleName, e)
        }
    }

    /** GET 一个文本资源（GitHub API）。非 2xx 直接 reject，不返回空串。 */
    @ReactMethod
    fun fetchText(url: String, promise: Promise) {
        io.execute {
            try {
                val conn = openFollowingRedirects(url)
                val code = conn.responseCode
                if (code !in 200..299) {
                    conn.disconnect()
                    promise.reject("E_UPDATE_HTTP", "HTTP $code")
                    return@execute
                }
                val body = conn.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
                conn.disconnect()
                promise.resolve(body)
            } catch (e: Throwable) {
                promise.reject("E_UPDATE_NET", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    /**
     * 下载到 `cacheDir/updates/<fileName>`，期间持续发 `xpeng-update-progress` 事件。
     * 返回 `{path}`。
     */
    @ReactMethod
    fun download(url: String, fileName: String, promise: Promise) {
        io.execute {
            try {
                val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
                val target = File(dir, fileName)
                val conn = openFollowingRedirects(url)
                val code = conn.responseCode
                if (code !in 200..299) {
                    conn.disconnect()
                    promise.reject("E_UPDATE_HTTP", "HTTP $code")
                    return@execute
                }
                val total = conn.contentLengthLong
                var done = 0L
                var lastEmit = 0L
                conn.inputStream.use { input ->
                    target.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            done += n
                            // 每 100 ms 一次：更密没有视觉收益，反而让 JS 线程空转
                            val now = System.currentTimeMillis()
                            if (now - lastEmit >= 100) {
                                lastEmit = now
                                emitProgress(done, total)
                            }
                        }
                    }
                }
                conn.disconnect()
                emitProgress(done, total)
                val out = Arguments.createMap()
                out.putString("path", target.absolutePath)
                out.putDouble("bytes", done.toDouble())
                promise.resolve(out)
            } catch (e: Throwable) {
                promise.reject("E_UPDATE_DOWNLOAD", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    /** 拉起系统安装器。文件必须经 FileProvider 授权，否则目标进程读不到。 */
    @ReactMethod
    fun install(filePath: String, promise: Promise) {
        try {
            val file = File(filePath)
            if (!file.exists()) throw IllegalStateException("安装包不存在: $filePath")
            val uri: Uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.updates", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            promise.resolve(null)
        } catch (e: Throwable) {
            promise.reject("E_UPDATE_INSTALL", e.message ?: e.javaClass.simpleName, e)
        }
    }

    @Suppress("DEPRECATION")
    private fun installedVersionCode(): Int {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pi.longVersionCode.toInt()
        } else {
            pi.versionCode
        }
    }

    /**
     * GitHub 的 release asset 地址会 302 到 `objects.githubusercontent.com`，
     * 手动跟最多 5 跳；HttpURLConnection 自带的跟随在同协议跳转上能用，
     * 但遇到协议变化会直接放弃并返回 302。
     */
    private fun openFollowingRedirects(url: String): HttpURLConnection {
        var current = url
        repeat(6) {
            val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 30_000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "xpcarinfo-updater")
                setRequestProperty("Accept", "application/vnd.github+json")
            }
            if (conn.responseCode in 300..399) {
                val next = conn.getHeaderField("Location")
                conn.disconnect()
                if (next.isNullOrEmpty()) throw IllegalStateException("重定向缺少 Location")
                current = next
            } else {
                return conn
            }
        }
        throw IllegalStateException("重定向次数过多")
    }

    private fun emitProgress(done: Long, total: Long) {
        val map = Arguments.createMap()
        map.putDouble("done", done.toDouble())
        map.putDouble("total", total.toDouble())
        ctx.emitDeviceEvent("xpeng-update-progress", map)
    }
}
