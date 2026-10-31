#!/usr/bin/env bash
# 连续采样 App 进程堆，捕获 eyJ token 明文。
# token 只在有网络请求时短暂出现在堆里，空闲时抓不到，所以要持续轮询。
# 用法: ./scripts/watch-token.sh [轮数] [间隔秒]
set -uo pipefail
ADB=/Volumes/LogicExt/Git/BookReader/.android-sdk/platform-tools/adb
PKG=com.xiaopeng.mycarinfo
OUT=work/live
ROUNDS=${1:-60}
INTERVAL=${2:-2}
mkdir -p "$OUT"

for i in $(seq 1 "$ROUNDS"); do
  PID=$("$ADB" shell pidof "$PKG" | tr -d '\r')
  if [ -z "$PID" ]; then sleep "$INTERVAL"; continue; fi

  "$ADB" shell "dd if=/proc/$PID/mem bs=1048576 iflag=skip_bytes,count_bytes \
    skip=0x02000000 count=0x24000000 2>/dev/null | strings -n 16 | \
    grep -oE '(accessToken|refreshToken)=eyJ[A-Za-z0-9_.-]{60,}' | sort -u \
    > /data/local/tmp/tok_scan.txt" 2>/dev/null
  "$ADB" pull /data/local/tmp/tok_scan.txt "$OUT/tok_scan.txt" >/dev/null 2>&1

  if [ -s "$OUT/tok_scan.txt" ]; then
    echo "=== 第 $i 轮命中 (PID=$PID) ==="
    cat "$OUT/tok_scan.txt" | head -4
    python3 - "$OUT/tok_scan.txt" <<'PY'
import sys, re
lines = open(sys.argv[1]).read().splitlines()
at = [l.split('=', 1)[1] for l in lines if l.startswith('accessToken=')]
rt = [l.split('=', 1)[1] for l in lines if l.startswith('refreshToken=')]
if at:
    best = max(at, key=len)
    open('work/live/access_token.txt', 'w').write(best)
    print(f'  已保存 accessToken ({len(best)} B)')
if rt:
    best = max(rt, key=len)
    open('work/live/refresh_token.txt', 'w').write(best)
    print(f'  已保存 refreshToken ({len(best)} B)')
PY
    # 抓到一对就退出
    if grep -q '^accessToken=' "$OUT/tok_scan.txt" && grep -q '^refreshToken=' "$OUT/tok_scan.txt"; then
      echo "已获得完整令牌对，退出采样"
      exit 0
    fi
  fi
  sleep "$INTERVAL"
done
echo "采样结束，未获得完整令牌对"
