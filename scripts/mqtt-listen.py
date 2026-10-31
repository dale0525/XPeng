#!/usr/bin/env python3
"""MQTT 下行监听器：抓 App 发的车控指令回执，用来反推 service_type / cmd_type。

只订阅、不发送。App 自己发指令时，车辆的回执会走同一个下行主题。
"""
import json
import os
import ssl
import sys
import time

import paho.mqtt.client as mqtt

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import renew  # noqa: E402

UID = renew.UID
TOPIC = f'Xmart/Msg/User/{UID}'
CRED_PATH = os.path.join(os.path.dirname(_HERE), 'work/live/mqtt.json')

# 关注的 service_type（车控相关），None 表示全收
WATCH = None


def creds(force=False):
    if not force and os.path.exists(CRED_PATH):
        try:
            return json.load(open(CRED_PATH))
        except ValueError:
            pass
    resp = renew.call('/biz/v5/mqtt/createMqttAccount/app', renew.get_token())
    if resp.get('code') != 200:
        raise RuntimeError(f"取凭据失败: {resp.get('code')} {resp.get('desc')}")
    d = resp['data']
    json.dump(d, open(CRED_PATH, 'w'))
    return d


def main():
    d = creds()
    host, port = d['serverSsl'].split(':')
    rc = {}

    def on_connect(c, u, f, r, p=None):
        rc['v'] = r
        print(f'已连接 rc={r}', flush=True)
        c.subscribe(TOPIC, qos=1)

    seen = set()

    def on_message(c, u, m):
        try:
            msg = json.loads(m.payload)
        except Exception:
            return
        st = msg.get('service_type')
        mc = msg.get('msg_content')
        if not isinstance(mc, dict):
            return
        if WATCH is not None and st not in WATCH:
            return
        key = (st, json.dumps(mc, sort_keys=True))
        if key in seen:
            return
        seen.add(key)
        ts = time.strftime('%H:%M:%S')
        body = json.dumps(mc, ensure_ascii=False)
        print(f'[{ts}] st={st} {body[:500]}', flush=True)

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                    client_id=f'xmart:app:{UID}:sniff{int(time.time())}',
                    protocol=mqtt.MQTTv311)
    c.username_pw_set(d['username'], d['password'])
    c.tls_set(cert_reqs=ssl.CERT_NONE)
    c.tls_insecure_set(True)
    c.on_connect = on_connect
    c.on_message = on_message
    c.connect(host, int(port), 30)
    c.loop_start()
    print(f'监听 {TOPIC}，Ctrl-C 结束', flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        c.loop_stop()


if __name__ == '__main__':
    if len(sys.argv) > 1:
        WATCH = {int(x) for x in sys.argv[1].split(',')}
    main()
