package com.logiconsole.xpcarinfo

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.logiconsole.xpcarinfo.bridge.XpengLog
import com.logiconsole.xpcarinfo.bridge.XpengNetPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(XpengNetPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // 日志必须先于一切初始化：进程一启动就要有落盘能力，否则最关键的启动阶段全丢。
    XpengLog.init(this)
    loadReactNative(this)
  }
}
