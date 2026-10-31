#!/usr/bin/env bash
# 在登录完成的瞬间从 App 进程堆里抓 accessToken + refreshToken 明文。
# 用法: ./scripts/grab-tokens.sh
set -euo pipefail
ADB=/Volumes/LogicExt/Git/BookReader/.android-sdk/platform-tools/adb
PKG=com.xiaopeng.mycarinfo
OUT=work/live
mkdir -p "$OUT"

PID=$("$ADB" shell pidof "$PKG" | tr -d '\r')
[ -n "$PID" ] || { echo "App 未运行"; exit 1; }
echo "PID=$PID"

# dalvik-main space 0x02000000..0x26000000
"$ADB" shell "dd if=/proc/$PID/mem bs=1048576 iflag=skip_bytes,count_bytes \
  skip=0x02000000 count=0x24000000 2>/dev/null | \
  strings -n 16 > /data/local/tmp/tok.txt"
"$ADB" pull /data/local/tmp/tok.txt "$OUT/tok.txt" >/dev/null 2>&1
"$ADB" shell "rm -f /data/local/tmp/tok.txt"

python3 - "$OUT/tok.txt" <<'PY'
import re, sys
d = open(sys.argv[1], 'rb').read()
at = re.findall(rb'accessToken=(eyJ[A-Za-z0-9_\-\.]{50,})', d)
rt = re.findall(rb'refreshToken=([A-Za-z0-9_\-\.]{50,})', d)
def pick(lst):
    # 取最长的（完整 JWT 比被截断的长）
    return max(lst, key=len).decode() if lst else None
a, r = pick(at), pick(rt)
if a:
    open('work/live/access_token.txt', 'w').write(a)
    print(f"accessToken  长度 {len(a)}")
else:
    print("accessToken  未找到")
if r:
    open('work/live/refresh_token.txt', 'w').write(r)
    print(f"refreshToken 长度 {len(r)}")
else:
    print("refreshToken 未找到")
PY
