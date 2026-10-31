#!/usr/bin/env python3
"""用 am dumpheap 抓 App 完整堆快照，从中提取易盾票据（CN31_ 开头）。

为什么用 dumpheap 而不是反复 dd /proc/pid/mem：之前每 0.2 秒扫几百 MB 的做法
会让 dd 长期抢占 I/O，把 App 主线程卡死、弹 ANR，连滑块都初始化超时。
dumpheap 是一次性操作，快照完整，对 App 的干扰小得多。

用法：
    pixi run -e rev python scripts/grab-ticket.py           # 抓一次并解析
    pixi run -e rev python scripts/grab-ticket.py --keep    # 保留 hprof 文件
"""

import argparse
import os
import re
import subprocess
import sys

ADB = os.environ.get(
    'ADB', '/Volumes/LogicExt/Git/BookReader/.android-sdk/platform-tools/adb')
PKG = 'com.xiaopeng.mycarinfo'
REMOTE = '/data/local/tmp/xp.hprof'
LOCAL = 'work/live/xp.hprof'
TICKET_RE = re.compile(rb'CN31_[A-Za-z0-9*._]{100,}')


def adb(*args):
    return subprocess.run([ADB, *args], capture_output=True).stdout.decode(
        'utf8', 'replace')


def main():
    ap = argparse.ArgumentParser(description='dumpheap 抓易盾票据')
    ap.add_argument('--keep', action='store_true', help='保留 hprof')
    a = ap.parse_args()

    pid = adb('shell', f'pidof {PKG}').strip()
    if not pid:
        print('App 没在运行')
        return 1
    print(f'App pid={pid}，开始 dumpheap…', flush=True)
    adb('shell', f'rm -f {REMOTE}')
    out = adb('shell', f'am dumpheap {pid} {REMOTE}')
    print(f'  {out.strip() or "(无输出)"}', flush=True)

    # dumpheap 是异步的，等文件写完
    for _ in range(60):
        size = adb('shell', f'stat -c %s {REMOTE} 2>/dev/null').strip()
        if size.isdigit() and int(size) > 1024 * 1024:
            break
        import time
        time.sleep(1)
    else:
        print('hprof 没生成或太小')
        return 1
    print(f'  hprof {int(size) // 1024 // 1024} MB', flush=True)

    os.makedirs(os.path.dirname(LOCAL), exist_ok=True)
    adb('pull', REMOTE, LOCAL)
    adb('shell', f'rm -f {REMOTE}')
    if not os.path.exists(LOCAL):
        print('拉取失败')
        return 1

    print('  解析中…', flush=True)
    hits = set()
    carry = b''
    with open(LOCAL, 'rb') as f:
        while True:
            chunk = f.read(1 << 24)
            if not chunk:
                break
            buf = carry + chunk
            for m in TICKET_RE.finditer(buf):
                hits.add(m.group().decode('ascii', 'replace'))
            # 票据可能跨块，保留尾部 4KB 与下一块拼接
            carry = buf[-4096:]

    if not hits:
        print('堆里没找到 CN31_ 票据（可能已被 GC）')
        if not a.keep:
            os.remove(LOCAL)
        return 2

    out_path = 'work/live/app_ticket.txt'
    best = sorted(hits, key=len, reverse=True)[0]
    with open(out_path, 'w') as f:
        f.write(best)
    print(f'\n*** 找到 {len(hits)} 张票据，最长 {len(best)} B ***')
    print(best[:130] + '…')
    print(f'已写入 {out_path}')
    for t in sorted(hits, key=len, reverse=True)[:5]:
        print(f'  len={len(t)}  {t[:60]}…')
    if not a.keep:
        os.remove(LOCAL)
    return 0


if __name__ == '__main__':
    sys.exit(main())
