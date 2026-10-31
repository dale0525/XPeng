#!/usr/bin/env bash
# 反编译 APK：apktool 出可回编译工程，jadx 出 Java 源码。
# 需先执行 pixi run fetch-tools 与 pixi run fetch-apk。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="$ROOT/work/apk/XP_MobileAPP_Android_gw.apk"
OUT="$ROOT/work/apk/decode"
SRC="$ROOT/work/apk/jadx_out"

[[ -f "$APK" ]] || { echo "缺少 $APK，先跑 pixi run fetch-apk" >&2; exit 1; }
[[ -f "$ROOT/.tools/apktool.jar" ]] || { echo "缺少 apktool，先跑 pixi run fetch-tools" >&2; exit 1; }

if [[ ! -d "$OUT" ]]; then
  echo "== apktool =="
  java -jar "$ROOT/.tools/apktool.jar" d -f -o "$OUT" "$APK"
fi

if [[ ! -d "$SRC" ]]; then
  echo "== jadx =="
  "$ROOT/.tools/jadx/bin/jadx" -d "$SRC" --no-res "$APK"
fi

echo "apktool: $OUT"
echo "jadx:    $SRC"
