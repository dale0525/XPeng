#!/usr/bin/env bash
# 下载小鹏 App 最新 APK 到 work/apk/。
# a.xiaopeng.com/dl/gw 是短链，跳转后的 OSS 地址带时效签名，所以每次都走短链。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/work/apk"
APK="$OUT_DIR/XP_MobileAPP_Android_gw.apk"
mkdir -p "$OUT_DIR"

if [ -f "$APK" ]; then
  echo "==> APK 已存在：$APK"
  ls -lh "$APK"
  exit 0
fi

echo "==> 下载 $APK"
curl -fL --retry 3 -o "$APK" "https://a.xiaopeng.com/dl/gw"
ls -lh "$APK"
