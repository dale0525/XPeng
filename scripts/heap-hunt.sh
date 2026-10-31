#!/usr/bin/env bash
# 从官方 App 的运行进程里取出国内签名凭据（Xp-Appid 与 secret）。
#
# 背景：这两个值不在 APK 里任何静态位置（dex / .so / assets / 字节流全命中 0），
# 是运行时拼出来的。App 发出第一条签名请求后，完整 canonical 串会以明文留在
# Dalvik 主堆里，dump 出来即可读。
#
# 前置：一台 root 的 arm64 安卓设备或模拟器（userdebug 版 adb root 即可），
#       adb 可用。本机 adb 来自 BookReader 项目的 SDK，可用 ADB 环境变量覆盖。
# 用法：pixi run heap-hunt
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${ADB:-/Volumes/LogicExt/Git/BookReader/.android-sdk/platform-tools/adb}"
APK="$ROOT/work/apk/XP_MobileAPP_Android_gw.apk"
OUT="$ROOT/work/heap"
PKG=com.xiaopeng.mycarinfo
MAIN_SPACE=0x02000000   # Dalvik main space 起点
MAIN_SIZE=0x24000000    # 576 MB

if ! [ -x "$ADB" ] && command -v "$ADB" >/dev/null 2>&1; then
  ADB="$(command -v "$ADB")"
fi
[ -x "$ADB" ] || { echo "找不到 adb：$ADB（用 ADB=... 覆盖）" >&2; exit 1; }
[ -f "$APK" ] || { echo "缺少 APK，先跑 pixi run fetch-apk" >&2; exit 1; }
mkdir -p "$OUT"

echo "==> 检查 root"
"$ADB" root >/dev/null 2>&1 || true
sleep 2
if [ "$("$ADB" shell id -u | tr -d '\r')" != "0" ]; then
  echo "adb 未取得 root，无法读 /proc/<pid>/mem" >&2
  exit 1
fi

echo "==> 安装并启动"
"$ADB" install -r -d "$APK" >/dev/null
"$ADB" shell am force-stop "$PKG" || true
"$ADB" shell am start -W -n "$PKG/.core.splashscreen.SplashEmptyActivity" >/dev/null

echo "==> 等待隐私协议页（人工点「同意」进入登录页）"
for _ in $(seq 1 30); do
  if "$ADB" shell dumpsys activity activities 2>/dev/null | grep -q "LoginBySmsActivity"; then break; fi
  sleep 2
done

cat <<'MANUAL'
--------------------------------------------------------------------
接下来两步需要在设备上手动完成，目的是让 App 发出一次签名请求：
  1. 若停在隐私协议页，点「同意」
  2. 在登录页随便填一个手机号，点「获取验证码」（会弹滑块，不用管）
完成后回到终端按回车继续。
--------------------------------------------------------------------
MANUAL
read -r _

PID="$("$ADB" shell pidof "$PKG" | tr -d '\r')"
[ -n "$PID" ] || { echo "进程不在，启动失败" >&2; exit 1; }
echo "==> 进程 PID=$PID，dump Dalvik main space"

DUMP="$OUT/heap_main.bin"
"$ADB" shell "dd if=/proc/$PID/mem bs=1048576 iflag=skip_bytes,count_bytes \
  skip=$MAIN_SPACE count=$MAIN_SIZE 2>/dev/null of=/data/local/tmp/heap_main.bin"
"$ADB" pull /data/local/tmp/heap_main.bin "$DUMP" >/dev/null
"$ADB" shell rm -f /data/local/tmp/heap_main.bin

echo "==> 提取 canonical 串"
"$ROOT/.pixi/envs/rev/bin/python" - "$DUMP" <<'PY'
import re, sys
d = open(sys.argv[1], 'rb').read()
seen = set()
for m in re.finditer(rb'XP-APPID=[^\x00]{40,600}', d):
    s = m.group().decode('latin-1')
    s = re.sub(r'[^\x20-\x7e]', '', s)
    if s in seen:
        continue
    seen.add(s)
    app = re.search(r'XP-APPID=([^&]+)', s)
    print(f"  appId={app.group(1) if app else '?'}  len={len(s)}")
    print(f"    {s[:400]}")
if not seen:
    print("  没找到 canonical 串——确认点过「获取验证码」，且 dump 发生在之后")
PY

echo
echo "==> 下一步：把上面出现的 16 位小写字母数字串逐个当 secret，"
echo "    用 scripts/probe.py 的 signed() 打 /biz/v5/secure/teeIndiv4App，返回 200 的那个就是。"
