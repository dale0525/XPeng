#!/usr/bin/env bash
# 把 mitmproxy CA 装进模拟器的系统信任库（Android 14+ 需要覆盖 conscrypt apex 并重启 zygote）。
# 用法：pixi run -e rev bash scripts/emu-ca.sh
set -euo pipefail
ADB="${ADB:-/Volumes/LogicExt/Git/BookReader/.android-sdk/platform-tools/adb}"
CA="${CA:-$HOME/.mitmproxy/mitmproxy-ca-cert.pem}"
HASH="$(openssl x509 -inform PEM -subject_hash_old -in "$CA" | head -1)"
TMP="$(mktemp -d)"
openssl x509 -inform PEM -in "$CA" > "$TMP/$HASH.0"

"$ADB" root >/dev/null 2>&1 || true
sleep 2
"$ADB" remount >/dev/null 2>&1 || true
"$ADB" push "$TMP/$HASH.0" "/sdcard/$HASH.0" >/dev/null
"$ADB" shell "mount -o rw,remount /system 2>/dev/null || true
  cp /sdcard/$HASH.0 /system/etc/security/cacerts/$HASH.0
  chmod 644 /system/etc/security/cacerts/$HASH.0
  mkdir -p /data/local/tmp/cacerts
  cp /apex/com.android.conscrypt/cacerts/* /data/local/tmp/cacerts/ 2>/dev/null || true
  cp /system/etc/security/cacerts/* /data/local/tmp/cacerts/ 2>/dev/null || true
  cp /sdcard/$HASH.0 /data/local/tmp/cacerts/
  mount -t tmpfs tmpfs /apex/com.android.conscrypt/cacerts
  cp /data/local/tmp/cacerts/* /apex/com.android.conscrypt/cacerts/
  chmod 644 /apex/com.android.conscrypt/cacerts/*
  chcon -R u:object_r:system_security_cacerts_file:s0 /apex/com.android.conscrypt/cacerts"
echo "CA $HASH 已安装；重启 zygote 让 Conscrypt 重新加载信任库"
"$ADB" shell "stop; sleep 1; start" || true
sleep 25
for _ in $(seq 1 30); do
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 5
done
echo "done"
rm -rf "$TMP"
