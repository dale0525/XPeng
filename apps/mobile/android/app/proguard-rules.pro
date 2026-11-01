# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# --- 本项目的保留规则 ---

# RN 的 TurboModule / ViewManager 由原生按类名反射注册，R8 改名后会在运行时
# 找不到模块（表现为 "Could not find generated setter" 或直接红屏）
-keep class com.logiconsole.xpcarinfo.bridge.** { *; }
-keep class com.logiconsole.xpcarinfo.net.** { *; }
-keepclassmembers class * extends com.facebook.react.uimanager.ViewManager {
    public <init>(...);
}
-keepclassmembers class * extends com.facebook.react.bridge.ReactContextBaseJavaModule {
    public <init>(...);
}

# JS 侧通过 name 字符串找原生模块，保留其 getName 返回值语义
-keepclassmembers class * implements com.facebook.react.bridge.NativeModule {
    java.lang.String getName();
}

# WebView 的 @JavascriptInterface 方法由 Chromium 反射调用
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Hermes 不需要额外规则；保留注解避免误删
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
