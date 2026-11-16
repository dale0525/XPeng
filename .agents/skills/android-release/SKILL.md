---
name: android-release
description: 构建、发布或安装 `apps/mobile` 的 APK 时加载。涉及本地构建装机、打 tag 发版、覆盖安装被拒（签名不一致 / 无法降级）、配置签名密钥与 GitHub Secrets。
---

# 构建与发布

本地构建与 CI 发版必须产出**同一签名、单调递增的 versionCode**，否则两边互相装不上。
两条都是踩过的坑，改构建配置前先看这里。

## 签名：本地与 CI 共用一把 release 密钥

密钥在 `apps/mobile/android/keystore/xpcarinfo-release.jks`，口令在同目录
`signing.properties`，两者都在 `.gitignore` 里。`app/build.gradle` 的
`signingConfigs` 会读 `signing.properties` 并注入同名属性；CI 走 `-P` 传进来的
路径，优先级高于本地文件。

同一把密钥必须以四个 Secret 存在 GitHub 上，CI 才能签出能覆盖安装的包：

| Secret | 内容 |
| --- | --- |
| `XP_RELEASE_KEYSTORE_B64` | `base64 -i xpcarinfo-release.jks` |
| `XP_RELEASE_STORE_PASSWORD` | `signing.properties` 里的 `xpReleaseStorePassword` |
| `XP_RELEASE_KEY_ALIAS` | `xpcarinfo` |
| `XP_RELEASE_KEY_PASSWORD` | 同 store password |

**更换密钥的代价**：已装设备必须卸载重装，登录态与蓝牙标定一起清空。换之前先确认
真的需要换（2026-11-16 因为本地一直用 debug 签名、CI 用 release 签名，只能卸载重装）。

核对两包签名是否一致：

```bash
apksigner verify --print-certs <apk> | grep -E "certificate DN|SHA-256"
```

`apksigner` 需要 JDK，本机用 `JAVA_HOME=.pixi/envs/default/lib/jvm`。

## versionCode：时间戳，不是 run_number

`app/build.gradle` 用构建时刻的 epoch 分钟数（约 2.9e7）作为 versionCode，除非显式
`-PxpVersionCode` 覆盖。CI 不再传这个值。

**不要改回 `run_number + 1000`**：它与本地手写的号段互不相干。本地一旦传过更大的号
（2026-11-15 本地 1031、CI 1011），正式版就被系统当降级包拒装，而 `run_number` 涨得
很慢，永远追不上。

`versionName` 必须与 tag 去掉 `v` 后完全一致：应用内更新拿安装包的 versionName 与
GitHub 最新 tag 比较，格式不同会永远报有更新。

## 覆盖安装被拒的分流

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 两包签名不同 | 统一密钥后重装；已有设备需卸载一次 |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | 新包 versionCode 更小 | 检查 versionCode 来源，勿手填小值 |
| `INSTALL_FAILED_INVALID_APK` | 包损坏或架构不匹配 | 确认装的不是分架构包中的另一架构 |

真机装包前先读现装版本，避免白跑一趟：

```bash
adb -s <host:port> shell dumpsys package com.logiconsole.xpcarinfo | grep -E "versionCode|versionName"
```

无线调试端口随 adbd 重启变化，用户每次会给新端口。

## 发版

打 tag 触发 `.github/workflows/release.yml`，产出
`xpcarinfo-<version>-{arm64-v8a,armeabi-v7a,universal}.apk` 并挂到同名 Release。

重发同一版本要先删远端 tag（本地与远端都删），否则 push tag 会被拒。发版属于发布动作，
需用户明确授权。
