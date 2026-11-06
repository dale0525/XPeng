#!/usr/bin/env python3
"""Read-only MQTT frame sniffer: subscribe, log every frame, never publish.

Never calls createMqttAccount. Re-issuing credentials invalidates the official
App's MQTT session and kicks it offline, so this script reuses the credentials
already on disk and connects with an independent clientId suffix instead.
"""
import argparse
import json
import os
import ssl
import time

import paho.mqtt.client as mqtt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# A worktree has no work/ of its own; the forensic assets live in the main repo.
CRED_PATH = os.path.join(ROOT, "work/live/mqtt.json")
if not os.path.exists(CRED_PATH):
    CRED_PATH = os.path.abspath(os.path.join(ROOT, "..", "..", "work/live/mqtt.json"))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="JSONL output path, put it under work/")
    ap.add_argument("--cred", default=CRED_PATH, help="MQTT credentials JSON, one per account")
    ap.add_argument("--seconds", type=int, default=0, help="0 keeps running until Ctrl-C")
    ap.add_argument("--uid", help="override the uid used in topics (e.g. owner account)")
    args = ap.parse_args()

    cred = json.load(open(args.cred, encoding="utf-8"))
    parts = cred["clientId"].split(":")
    uid, device_id = args.uid or parts[2], parts[3]
    host, port = cred["serverSsl"].split(":")

    topics = [
        f"Xmart/Send/User/{uid}",
        f"Xmart/Msg/User/{uid}",
        f"Mona/Send/User/{uid}",
        f"Mona/Msg/User/{uid}",
        f"Xp/Msg/Push/{device_id}",
    ]

    out = open(args.out, "a", encoding="utf-8")

    def on_connect(client, userdata, flags, reason_code, properties):
        print(f"[connect] rc={reason_code}", flush=True)
        client.subscribe([(t, 1) for t in topics])

    def on_subscribe(client, userdata, mid, reason_codes, properties):
        for topic, rc in zip(topics, reason_codes):
            print(f"[suback] {topic} -> {rc}", flush=True)

    def on_message(client, userdata, msg):
        row = {
            "ts": time.time(),
            "topic": msg.topic,
            "qos": msg.qos,
            "payload": msg.payload.decode("utf-8", "replace"),
        }
        out.write(json.dumps(row, ensure_ascii=False) + "\n")
        out.flush()
        print(f"[{time.strftime('%H:%M:%S')}] {msg.topic} {len(msg.payload)}B", flush=True)

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"xmart:app:{uid}:sniff{int(time.time())}",
        protocol=mqtt.MQTTv311,
    )
    client.username_pw_set(cred["username"], cred["password"])
    client.tls_set(cert_reqs=ssl.CERT_NONE)
    client.tls_insecure_set(True)
    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_message = on_message
    client.connect(host, int(port), 30)
    client.loop_start()
    print(f"[ready] topics={len(topics)} out={args.out}", flush=True)
    try:
        if args.seconds:
            time.sleep(args.seconds)
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()
        out.close()


if __name__ == "__main__":
    main()
