package com.logiconsole.xpcarinfo.bridge

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 持久化日志：追加写文件，不依赖 logcat。
 *
 * logcat 的 main 缓冲在本机实测只覆盖十几分钟，用户「走近那 15 秒发生了什么」这类
 * 问题，等连上 adb 时证据早已被滚掉——2026-11-13 就是这么查不下去的。所以关键链路
 * 一律同时落到 App 私有目录里的文件：进程被杀、设备重启、隔天再取，内容都还在。
 *
 * 写文件走独立的后台线程：日志不能阻塞蓝牙回调与主线程，否则观测本身会改变被测行为。
 * 单次失败只吞掉，记日志失败绝不能影响业务。
 */
object XpengLog {
    /** 单个文件上限；超过就滚到 `.1`，只保留一代，避免长期运行吃满存储。 */
    private const val MAX_BYTES = 8L * 1024 * 1024
    private const val FILE_NAME = "xpcarinfo.log"
    private const val TAG = "XpengLog"

    private var appCtx: Context? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private val stamp = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

    fun init(ctx: Context) {
        if (appCtx != null) return
        appCtx = ctx.applicationContext
        val t = HandlerThread("xpeng-log").also { it.start() }
        thread = t
        handler = Handler(t.looper)
        write("=== app start pid=${android.os.Process.myPid()} ===")
    }

    /**
     * 日志目录。
     *
     * 用外部私有目录（`Android/data/<pkg>/files`）而不是内部私有目录：release 包
     * 不可 debuggable，`run-as` 用不了，内部目录的日志只能靠 App 自己导出；外部私有
     * 目录不需要任何存储权限，`adb pull` 直接就能取走——出问题时少一步"先让 App 导出"。
     * 拿不到外部目录（存储未挂载）时退回内部目录，宁可难取也不能不记。
     */
    private fun dir(ctx: Context): File {
        val ext = ctx.getExternalFilesDir(null)
        return ext ?: ctx.filesDir
    }

    /** 记一条。`tag` 用来区分链路，检索时按 tag 过滤。 */
    fun log(tag: String, message: String) {
        Log.i("Xpeng$tag", message)
        write("$tag: $message")
    }

    /** 取日志文件（给 adb 或导出用）。文件不存在时返回 null。 */
    fun file(): File? {
        val ctx = appCtx ?: return null
        val f = File(dir(ctx), FILE_NAME)
        return if (f.exists()) f else null
    }

    /** 清空：只由用户显式触发，平常永不自动删除。 */
    fun clear() {
        val h = handler ?: return
        h.post {
            val ctx = appCtx ?: return@post
            runCatching {
                val d = dir(ctx)
                File(d, FILE_NAME).delete()
                File(d, "$FILE_NAME.1").delete()
            }
        }
    }

    private fun write(line: String) {
        val h = handler ?: return
        val ts = stamp.format(Date())
        h.post {
            val ctx = appCtx ?: return@post
            try {
                val dir = dir(ctx)
                dir.mkdirs()
                val f = File(dir, FILE_NAME)
                if (f.length() > MAX_BYTES) {
                    // 只滚一代：旧代直接覆盖，不累积多份，免得占满存储。
                    val prev = File(dir, "$FILE_NAME.1")
                    if (prev.exists()) prev.delete()
                    f.renameTo(prev)
                }
                f.appendText("$ts $line\n")
            } catch (t: Throwable) {
                Log.w(TAG, "write failed: ${t.javaClass.simpleName}")
            }
        }
    }
}
