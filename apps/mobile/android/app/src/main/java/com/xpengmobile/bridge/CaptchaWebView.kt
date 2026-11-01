package com.xpengmobile.bridge

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.Event

/**
 * 装易盾滑块的 WebView。
 *
 * 为什么必须用 WebView：易盾的验证码 SDK 是 H5 实现，票据里的加密指纹由 SDK 在
 * 页面里采集（`cstaticdun.126.net/load.min.js`）。任何在原生侧「模拟拖动」的做法
 * 都会产出被判失败的票据——风控看轨迹。所以这里只负责把 SDK 页面装起来，拖动由
 * 真人完成，`validate` 票据通过 JS 桥回传给 JS 层。
 *
 * 不引 react-native-webview：只用到「加载一段 HTML + 双向传两个字符串」，
 * 用原生 ViewManager 约 120 行，比引入整个库省 1 MB 以上包体积。
 */
@SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
class CaptchaWebView(context: ThemedReactContext) : WebView(context) {

    init {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.userAgentString = settings.userAgentString + " XpengMobile/0.1"
        addJavascriptInterface(Bridge(), "XpengBridge")
        webViewClient = WebViewClient()
        // 页面里的 JS 错误与 console 输出都进 logcat：滑块页白屏时只能从这里查
        webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.i("CaptchaWebView", "${'$'}{m.messageLevel()} ${'$'}{m.message()} @${'$'}{m.lineNumber()}")
                return true
            }
        }
    }

    inner class Bridge {
        /** 滑块通过：把 `validate` 票据交给 JS 层去换 token。 */
        @JavascriptInterface
        fun onValidate(validate: String) = emit("validate", validate)

        @JavascriptInterface
        fun onError(message: String) = emit("error", message)

        @JavascriptInterface
        fun onReady() = emit("ready", "")

        /**
         * 用 `UIManagerHelper.getEventDispatcher` 派发事件。
         * 新架构（Bridgeless）下 `getJSModule(RCTEventEmitter)` 会抛
         * IllegalArgumentException，事件永远到不了 JS。
         */
        private fun emit(type: String, value: String) {
            val reactContext = context as ReactContext
            val surfaceId = UIManagerHelper.getSurfaceId(this@CaptchaWebView)
            val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(
                reactContext,
                id,
            ) ?: return
            val payload: WritableMap = Arguments.createMap().apply {
                putString("type", type)
                putString("value", value)
            }
            dispatcher.dispatchEvent(
                object : Event<CaptchaEvent>(surfaceId, id) {
                    override fun getEventName() = "topCaptcha"
                    override fun getEventData(): WritableMap = payload
                },
            )
        }
    }
}

/** 事件类型占位：RN 的 Event 需要具体子类，这里只用来满足泛型。 */
private class CaptchaEvent(surfaceId: Int, viewTag: Int) : Event<CaptchaEvent>(surfaceId, viewTag) {
    override fun getEventName() = "topCaptcha"
    override fun getEventData(): WritableMap = Arguments.createMap()
}

class CaptchaWebViewManager : SimpleViewManager<CaptchaWebView>() {
    override fun getName() = "CaptchaWebView"

    override fun createViewInstance(ctx: ThemedReactContext) = CaptchaWebView(ctx)

    override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
        mutableMapOf("topCaptcha" to mutableMapOf("registrationName" to "onChange"))

    /** 页面 HTML。由 JS 侧把易盾 SDK 与我们的回调拼好再传进来。 */
    @ReactProp(name = "html")
    fun setHtml(view: CaptchaWebView, html: String?) {
        if (html.isNullOrEmpty()) return
        view.loadDataWithBaseURL(
            "https://cstaticdun.126.net",
            html,
            "text/html",
            "UTF-8",
            null,
        )
    }
}
