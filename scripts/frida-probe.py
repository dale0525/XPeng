#!/usr/bin/env python3
"""用 Frida spawn 方式注入小鹏 App，观察它启动时如何处理 token。

壳会隐藏已运行进程（attach 报 process not found），但 spawn 可用。
用法:
    pixi run -e rev python scripts/frida-probe.py <脚本文件> [等待秒数]
"""
import os
import sys
import time

import frida

PKG = 'com.xiaopeng.mycarinfo'
BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      '..', 'work/tools/node_modules/frida-java-bridge')


def java_bridge_source():
    """frida 17 起 Java 桥接不再内置，需手动打包注入。"""
    import subprocess
    out = subprocess.run(
        ['npx', 'frida-compile', '-o', '/dev/stdout'],
        cwd=BRIDGE, capture_output=True, text=True,
    )
    return out.stdout


def main():
    js_path = sys.argv[1]
    wait = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    code = open(js_path).read()

    dev = frida.get_usb_device(timeout=10)
    pid = dev.spawn([PKG])
    print(f'[*] spawned pid={pid}', flush=True)
    session = dev.attach(pid)

    def on_message(msg, data):
        if msg['type'] == 'send':
            print('[JS]', msg['payload'], flush=True)
        elif msg['type'] == 'error':
            print('[ERR]', msg.get('description'), flush=True)

    script = session.create_script(code)
    script.on('message', on_message)
    script.load()
    dev.resume(pid)
    print('[*] resumed, 等待输出…', flush=True)
    time.sleep(wait)
    try:
        session.detach()
    except Exception:
        pass
    print('[*] done', flush=True)


if __name__ == '__main__':
    main()
