---
name: android-emulator
description: 启动、截屏、点击小鹏官方 App 的取证模拟器。需要跑官方 App 走登录/滑块、抓包、或从模拟器取文件时加载。
---

# 取证模拟器

模拟器跑在 BookReader 项目下，AVD 名 `xp19`，系统 `userdebug`（`adb root` 直接可用）。

## 路径

```
SDK=/Volumes/LogicExt/Git/BookReader/.android-sdk
ADB=$SDK/platform-tools/adb
AVD=~/.android/avd/xp19.avd/config.ini
```

## 启动

**必须有窗口 + 硬件 GPU。** 无头模式用户看不到界面；软件渲染会卡到系统 ANR。

```bash
grep hw.gpu "$AVD"          # 期望 hw.gpu.enabled=yes / hw.gpu.mode=host
nohup $SDK/emulator/emulator -avd xp19 -no-audio -no-snapshot -writable-system > /tmp/emu.log 2>&1 &
```

启动参数里**不要**加 `-no-window`，**不要**加 `-gpu swiftshader_indirect`——后者会覆盖 AVD 的 `hw.gpu.mode=host`。

`-gpu guest` 也不行：API 37 上它会回退到 `swangle`（软件 ANGLE），日志出现 `gles_mode_selected:swangle`，App 随即卡成 `System UI isn't responding`。启动后确认日志里是 `gles_mode_selected:host`：

```bash
grep gles_mode_selected /tmp/emu.log
```

等启动完成：

```bash
for i in $(seq 1 40); do [ "$($ADB shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break; sleep 8; done
$ADB root
```

## 重启与残留

同一 AVD 已有实例时再启动会报 `Running multiple emulators with the same AVD`。清理顺序：

```bash
$ADB emu kill; sleep 4
pkill -f qemu-system-aarch64
$ADB kill-server
rm -f ~/.android/avd/xp19.avd/*.lock
```

## 截屏：两种方式，按页面选

`adb shell screencap` 对 **HomeActivity 等普通页面可用**，但对 **`LoginBySmsActivity` 返回全黑**（实测 15580 B 纯黑 PNG，此时 `dumpsys` 显示它确实是 topResumed，窗口也没有 `FLAG_SECURE`）。原因是该页走硬件图层，`screencap` 抓不到。

登录页及之后的页面改用 macOS 截窗口区域：

```bash
osascript -e 'tell application "System Events" to tell process "qemu-system-aarch64" to set frontmost to true'
screencapture -R100,100,388,891 -x /tmp/win.png
```

窗口位置随启动变化，先用 AppleScript 取：`get {position, size} of window 1`。

## 坐标换算

`input tap/swipe` 用的是**设备坐标**（1080×2400），`screencapture` 出来的是**窗口图**（776×1782，含顶部约 52 px 标题栏）。换算：

```
设备 x = 图 x × 1080 / 776          # 约 ×1.392
设备 y = (图 y − 52) × 2400 / 1730  # 先扣标题栏
```

滑条在 WebView `[108,941]-[972,1524]` 内，滑条中心约设备 `y≈1454`。滑块起点 `x≈173`。

## 易盾滑块

App 内的滑块由易盾 SDK 驱动，**拖动必须一次到位**：`input swipe` 拖偏一次就会刷新图片重来，连续几次后锁成「失败过多，点此重试」。

```bash
$ADB shell "input swipe 173 1454 <目标x> 1454 900"
```

目标 x 按缺口中心换算。锁定后点该提示条可重试。

**脚本生成的轨迹过不了服务端风控**，用 Chrome + CDP 驱动易盾官方 H5 拿到的票据同样被拒。所以需要真实验证码时，让用户在模拟器里亲手划——不要试图自动化这一步。

**跑易盾前先关掉 Frida**，它会检测并杀进程：

```bash
$ADB shell pkill -f frida-server
```

## 取 token

登录后解 token 前**必须**先对齐 deviceId，否则真 token 也会被拒（`12010104`）：

```bash
pixi run -e rev python scripts/unseal-token.py --save   # 内置 sync_device_id()
pixi run -e rev python scripts/renew.py status
```

deviceId 在 `shared_prefs/device_id.xml.xml`，App 每重装一次就换一个。

## 系统 CA

抓包用的证书安装脚本：`scripts/emu-ca.sh`。
