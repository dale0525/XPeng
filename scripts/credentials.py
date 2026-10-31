#!/usr/bin/env python3
"""自研车控客户端的凭据生命周期管理。

三套凭据（实测，见 docs/research/xpeng-app-teardown.md §2.9）：
  accessToken   2 小时   取数据 / 申请 MQTT 凭据
  refreshToken  90 天    换新 accessToken（响应是 WEEB，不可直接当 token 用）
  MQTT 凭据     7 天     全部车控

设计原则：日常车控只依赖 MQTT 凭据（7 天），不依赖 accessToken（2 小时）。
登录后立刻申请 MQTT 凭据，之后 7 天内不必碰 HTTP token。

CLI:
  status            查看三套凭据剩余时间
  ensure-mqtt       确保有可用 MQTT 凭据（剩余不足 1 天则用 accessToken 续）
  save-tokens       从模拟器本地存储解出 token 并落盘
"""
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.path.join(ROOT, 'work/live')
AT_PATH = os.path.join(LIVE, 'access_token.txt')
RT_PATH = os.path.join(LIVE, 'refresh_token.txt')
MQTT_PATH = os.path.join(LIVE, 'mqtt.json')

MQTT_MARGIN = 86400  # MQTT 凭据剩余不足 1 天时续期


def _read(path):
    try:
        return open(path).read().strip()
    except OSError:
        return ''


def _signed(path, extra_plain, body='{}'):
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    import token_mgr as T
    from probe import dechunk, http

    h = T._headers(body, extra_plain=extra_plain)
    raw = dechunk(http('apps.xiaopeng.com', path, h, body))
    if isinstance(raw, bytes):
        raw = raw.decode('utf8', 'replace')
    i, j = raw.find('{'), raw.rfind('}')
    return json.loads(raw[i:j + 1])


def mqtt_status():
    """返回 (剩余秒数, 凭据 dict)；无凭据返回 (None, None)。"""
    try:
        d = json.load(open(MQTT_PATH))
    except (OSError, ValueError):
        return None, None
    exp = d.get('expireTime', 0) / 1000
    left = exp - datetime.datetime.now().timestamp()
    return left, d


def ensure_mqtt(force=False):
    """确保 MQTT 凭据可用。剩余不足 MQTT_MARGIN 时用 accessToken 重新申请。"""
    left, cur = mqtt_status()
    if not force and left is not None and left > MQTT_MARGIN:
        print(f'MQTT 凭据仍可用，剩余 {left/86400:.1f} 天，跳过续期')
        return cur

    at = _read(AT_PATH)
    if not at:
        raise RuntimeError('缺少 accessToken，先跑 scripts/unseal-token.py --save')

    r = _signed('/biz/v5/mqtt/createMqttAccount/app', '&accessToken=' + at)
    if r.get('code') != 200:
        raise RuntimeError(f'申请 MQTT 凭据失败: {r.get("code")} {r.get("desc")}')
    d = r['data']
    json.dump(d, open(MQTT_PATH, 'w'))
    exp = datetime.datetime.fromtimestamp(d['expireTime'] / 1000)
    print(f'MQTT 凭据已更新，有效期至 {exp:%Y-%m-%d %H:%M}（7 天）')
    return d


def status():
    now = datetime.datetime.now()
    print(f'现在: {now:%Y-%m-%d %H:%M:%S}')

    at = _read(AT_PATH)
    if at:
        r = _signed('/biz/v5/vehicle/v2/myVehicles', '&accessToken=' + at)
        print(f'accessToken : {"有效" if r.get("code") == 200 else "已失效"}'
              f'（{r.get("code")}），有效期 2 小时')
    else:
        print('accessToken : 缺失')

    rt = _read(RT_PATH)
    print(f'refreshToken: {"已保存" if rt else "缺失"}'
          f'（{len(rt)} B，有效期 90 天滑动）')

    left, d = mqtt_status()
    if left is None:
        print('MQTT 凭据   : 缺失')
    else:
        exp = datetime.datetime.fromtimestamp(d['expireTime'] / 1000)
        flag = '可用' if left > 0 else '已过期'
        print(f'MQTT 凭据   : {flag}，剩余 {left/86400:.1f} 天（至 {exp:%m-%d %H:%M}）')
        print(f'              -> 车控可{"正常工作" if left > 0 else "需先续期"}')


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if cmd == 'status':
        status()
    elif cmd == 'ensure-mqtt':
        ensure_mqtt(force='--force' in sys.argv)
    elif cmd == 'save-tokens':
        os.system(f'pixi run -e rev python {ROOT}/scripts/unseal-token.py --save')
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
