package com.logiconsole.xpcarinfo.bridge

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class XpengNetPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(XpengNetModule(ctx), UpdaterModule(ctx), XpengBleModule(ctx), XpengWifiLocationModule(ctx))

    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
        listOf(CaptchaWebViewManager(), RtmpPlayerViewManager())
}
