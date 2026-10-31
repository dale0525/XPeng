#!/usr/bin/env python3
"""通过 MQTT 下发小鹏车控指令。

协议见 docs/research/xpeng-app-teardown.md §5.5。
用法:
    pixi run -e rev python scripts/mqtt-send.py flash
    pixi run -e rev python scripts/mqtt-send.py --raw '{"cmd_type":1,"cmd_value":1}'
    pixi run -e rev python scripts/mqtt-send.py --listen 30   # 只监听下行
"""
import json
import os
import random
import ssl
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import paho.mqtt.client as mqtt

import renew
import local_env
from probe import dechunk, http

UID = renew.UID
VIN = local_env.get('XP_VIN')
ROOT = os.path.dirname(_HERE)
CRED_PATH = os.path.join(ROOT, 'work/live/mqtt.json')


def creds(force=False):
    """取 MQTT 凭据；每次签发会作废旧凭据，所以默认复用磁盘上的。"""
    if not force and os.path.exists(CRED_PATH):
        try:
            return json.load(open(CRED_PATH))
        except ValueError:
            pass
    resp = renew.call('/biz/v5/mqtt/createMqttAccount/app', renew.get_token())
    if resp.get('code') != 200:
        raise RuntimeError(f"取 MQTT 凭据失败: {resp.get('code')} {resp.get('desc')}")
    d = resp['data']
    json.dump(d, open(CRED_PATH, 'w'))
    return d


def _connect(d, cid):
    """建立连接；返回 (client, rc)。rc!=0 表示凭据失效。"""
    host, port = d['serverSsl'].split(':')
    rc = {}

    def on_connect(c, u, f, r, p=None):
        rc['v'] = r

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cid,
                    protocol=mqtt.MQTTv311)
    c.username_pw_set(d['username'], d['password'])
    c.tls_set(cert_reqs=ssl.CERT_NONE)
    c.tls_insecure_set(True)
    c.on_connect = on_connect
    c.connect(host, int(port), 30)
    c.loop_start()
    time.sleep(3)
    return c, rc.get('v')


def connect_authed():
    """连接 MQTT，凭据失效（Not authorized）时自动重新签发一次。

    警告：createMqttAccount 会作废官方 App 的凭据，把 App 挤下线。
    因此只允许一个客户端持凭据——监听前先确认没有别的实例在跑。
    """
    d = creds()
    cid = d['clientId'] + ':2.0:V5.19.0:com.xiaopeng.probe'
    c, rc = _connect(d, cid)
    if rc != 0:
        # 旧凭据会被后续 createMqttAccount 作废，属正常情况
        c.loop_stop()
        c.disconnect()
        print(f'凭据失效（{rc}），重新签发…', flush=True)
        d = creds(force=True)
        cid = d['clientId'] + ':2.0:V5.19.0:com.xiaopeng.probe'
        c, rc = _connect(d, cid)
    return c, rc


def build_payload(msg_content, msg_id=None, vin=VIN, service_type=19, msg_type=2):
    """构造请求报文。

    msg_content 必须是 JSON 字段。2026-10-30 实测：字符串拼接格式
    （``…"msg_type":4}msg_content:{…}``）broker 会接受 publish，但车辆端
    解析失败、不回任何回执——这是此前「发 4 次闪灯零回执」的真正原因。
    """
    msg_id = msg_id or ('10' + UID + str(int(time.time() * 1000))
                        + f'{random.randint(10, 99)}')
    if isinstance(msg_content, str):
        msg_content = json.loads(msg_content)
    return json.dumps({
        'protocol_ver': '2.0', 'msg_id': msg_id, 'target_id': vin,
        'service_type': service_type, 'msg_type': msg_type,
        'msg_content': msg_content,
    }, separators=(',', ':')), msg_id


def send(msg_content, listen=15, **kw):
    got = []

    def on_message(c, u, m):
        got.append(m.payload)
        print(f'[下行] {m.payload[:400]!r}', flush=True)

    c, rc = connect_authed()
    print('MQTT 连接:', rc, flush=True)
    if rc != 0:
        raise RuntimeError(f'MQTT 连接失败: {rc}')
    c.on_message = on_message
    c.subscribe(f'Xmart/Msg/User/{UID}')
    c.subscribe(f'Xmart/Msg/User/{UID}/#')

    payload, mid = build_payload(msg_content, **kw)
    info = c.publish(f'Xmart/Send/User/{UID}', payload)
    info.wait_for_publish(timeout=10)
    print(f'已发送 msg_id={mid} publish_rc={info.rc}', flush=True)
    time.sleep(listen)
    print(f'下行回执: {len(got)} 条', flush=True)
    c.loop_stop()
    c.disconnect()
    return got


def listen(seconds=30):
    got = []

    def on_message(c, u, m):
        got.append((m.topic, m.payload))
        print(f'[{m.topic}] {m.payload[:400]!r}', flush=True)

    c, rc = connect_authed()
    print('MQTT 连接:', rc, flush=True)
    c.on_message = on_message
    dev = json.load(open(CRED_PATH))['clientId'].split(':')[-1]
    for t in (f'Xmart/Msg/User/{UID}', f'Xmart/Msg/User/{UID}/#',
              f'Xp/Msg/Push/{dev}'):
        c.subscribe(t)
    print(f'监听 {seconds} 秒…', flush=True)
    time.sleep(seconds)
    c.loop_stop()
    c.disconnect()
    return got


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)
    if args[0] == '--listen':
        listen(int(args[1]) if len(args) > 1 else 30)
    elif args[0] == '--raw':
        send(args[1])
    elif args[0] == 'shade':
        # 遮阳帘：service_type=12 / cmd_type=4 / cmd_value 1=开 0=关
        # 2026-10-30 实测成功，回执 code:200 + sky_sun_shade_position
        val = int(args[1]) if len(args) > 1 else 1
        send({'cmd_type': 4, 'cmd_value': val}, service_type=12)
    elif args[0] == 'shade-state':
        # 只读查询当前状态（cmd_value 0 即为关闭，故先查再用 1 开）
        send({'cmd_type': 4, 'cmd_value': 0}, service_type=12)
    elif args[0] == 'window':
        # 全车车窗：service_type=12 / cmd_type=1 / cmd_value 2=降(通风位) 1=升
        # 2026-10-30 实测：cv=2 四窗 100→91，cv=1 四窗 91→100。只接受 1/2，其余 code:8。
        # 注意这是「一键全车」，四窗同值联动，不能单独控制某一扇。
        val = int(args[1]) if len(args) > 1 else 1
        send({'cmd_type': 1, 'cmd_value': val}, service_type=12)
    elif args[0] == 'window-state':
        # 只读：st=19 的 instant.window 带四个车窗位置 + 遮阳帘位置
        send({'cmd_type': 2}, service_type=19)
    elif args[0] == 'unlock':
        # 解锁车门：service_type=9 / cmd_type=0
        # 回执 driver_door_lock_st=0。仅解锁车门，不含启动。
        send({'cmd_type': 0}, service_type=9)
    elif args[0] == 'lock':
        # 锁车：service_type=9 / cmd_type=1，回执 driver_door_lock_st=1
        send({'cmd_type': 1}, service_type=9)
    elif args[0] == 'door-state':
        # 只读查门锁状态（cmd_type=1 即锁车动作，故查状态用 cmd_type=0 会触发解锁，
        # 这里改用 service_type=9 的 cmd_type=3 只读通道）
        send({'cmd_type': 3}, service_type=9)
    elif args[0] == 'flash':
        # 闪灯：service_type=5 / cmd_type=1 / cmd_value=1
        # 回执 dipped_headlight_status=1。2026-10-30 实测成功。
        send({'cmd_type': 1, 'cmd_value': 1}, service_type=5)
    elif args[0] == 'ac':
        # 空调开关：service_type=3 / cmd_type=1 / cmd_value 1=开 0=关
        # 回执 hvac_on。2026-10-30 实测成功。
        val = int(args[1]) if len(args) > 1 else 1
        send({'cmd_type': 1, 'cmd_value': val}, service_type=3)
    elif args[0] == 'ac-temp':
        # 设温度：service_type=3 / cmd_type=2 / cmd_value=<摄氏度整数>
        # 回执 hvac_temp。注意：设温度会顺带开机（hvac_on 变 1）。
        send({'cmd_type': 2, 'cmd_value': int(args[1])}, service_type=3)
    elif args[0] == 'ac-state':
        # 查空调状态走 st=19 的全车状态（instant.hvac），比 st=3 的 ct=4 可靠：
        # ct=4 时有时无回执，st=19 稳定返回 hvac 全字段。
        send({'cmd_type': 2}, service_type=19)
    elif args[0] == 'ac-raw':
        # 空调原始通道探测：ac-raw <cmd_type> <cmd_value>
        # 用于 ct=3/5/10 这类「无回执」通道的受控实测。注意 hvac_auto:1 时
        # 不能用 hvac_wind_speed 判断是否生效（自动调节会干扰观测）。
        send({'cmd_type': int(args[1]), 'cmd_value': int(args[2])}, service_type=3)
    elif args[0] == 'ac-cool':
        # 极速降温：service_type=3 / cmd_type=6 / cmd_value 1=开 0=关
        # 2026-10-30 实测：cv=1 → hvac_temp=18、wind=10、hvac_quick_cool_mode=1。
        # cv=2/3 返回 code:8。
        val = int(args[1]) if len(args) > 1 else 1
        send({'cmd_type': 6, 'cmd_value': val}, service_type=3)
    elif args[0] == 'ac-warm':
        # 极速升温：service_type=3 / cmd_type=8 / cmd_value 1=开 0=关
        # 2026-10-30 实测：cv=1 → hvac_temp=32、wind=8、hvac_quick_warm_mode=1。
        val = int(args[1]) if len(args) > 1 else 1
        send({'cmd_type': 8, 'cmd_value': val}, service_type=3)
    elif args[0] == 'ac-high-temp':
        # 高温抑菌：service_type=3 / cmd_type=9 / cmd_value 1=开 0=关
        # 2026-10-30 实测：cv=1 → hvac_high_temp_mode=1、hvac_temp=32、wind=10。
        # cv=2/3 返回 code:8。
        val = int(args[1]) if len(args) > 1 else 1
        send({'cmd_type': 9, 'cmd_value': val}, service_type=3)
    elif args[0] == 'sentry':
        # 哨兵模式开关：service_type=8 / action=2 / settings[{SENTINEL_MODE_VIDEO: 1|0}]
        # 2026-10-31 实测：写 1 → instant.ext.soldier_camera_status 0→1；写 0 → 1→0。
        # settings 按键名匹配，元素顺序无关；不认识的 code 被忽略（不报错、不改任何项）。
        val = int(args[1]) if len(args) > 1 else 1
        send({'action': 2, 'settings': [{'code': 'SENTINEL_MODE_VIDEO', 'value': val}]},
             service_type=8)
    elif args[0] == 'sentry-sensitivity':
        # 哨兵灵敏度：service_type=8 / action=2 / settings[{SENTINEL_MODE_SENSITIVITY: N}]
        # 实测取值 1/2/3 均可写入并回读；0 也能写入（含义未确认）。
        send({'action': 2,
              'settings': [{'code': 'SENTINEL_MODE_SENSITIVITY', 'value': int(args[1])}]},
             service_type=8)
    elif args[0] == 'sentry-state':
        # 只读：service_type=8 / action=1 回 settings[]；哨兵是否开启看 st=19 的
        # instant.ext.soldier_camera_status（1=开 0=关），settings 里没有开关位。
        send({'action': 1}, service_type=8)
    elif args[0] == 'sentry-all':
        # 只读：st=19 的 instant.ext 才是哨兵的完整可观测状态
        send({'cmd_type': 2}, service_type=19)
    elif args[0] == 'camera-state':
        # 只读：service_type=11 / cmd_type=1 返回 camera_status、camera_360、live_push_status
        # camera_status=-2 表示摄像头未开启。本车 avm_exist=0（无环视硬件），
        # 因此实时视频与视角切换在此车无法实测。
        send({'cmd_type': 1, 'cmd_value': 0}, service_type=11)
    else:
        print(__doc__)
