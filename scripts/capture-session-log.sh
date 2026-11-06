#!/usr/bin/env bash
# 真机自测用：把 XPSession（续期/加密/冷启动/MQTT）日志实时显示在终端，同时落一份到文件。
# 用法：bash scripts/capture-session-log.sh [输出文件]
# 设备：默认 USB 那台 Pixel 4a；若走网络 adb，先 export XPENG_ADB_SERIAL=192.168.123.15:5555
set -euo pipefail

SDK="${ANDROID_HOME:-/Volumes/LogicExt/Git/BookReader/.android-sdk}"
ADB="$SDK/platform-tools/adb"
SERIAL="${XPENG_ADB_SERIAL:-0B181JEC210197}"
OUT="${1:-/tmp/xpeng-session-$(date +%Y%m%d-%H%M%S).log}"

"$ADB" -s "$SERIAL" logcat -c
echo "抓取中，按 Ctrl+C 结束。输出：$OUT"
echo "过滤：XPSession / XpengNet / MqttClient / ReactNativeJS"
# -v time 带时间戳；三个自定义 TAG + ReactNativeJS 兜底看 JS 侧异常。
"$ADB" -s "$SERIAL" logcat -v time \
  XPSession:V XpengNet:V MqttClient:V ReactNativeJS:V *:S \
  2>&1 | tee "$OUT"
