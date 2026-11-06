#!/usr/bin/env python3
"""Take ONE filtered heap sample when a target MQTT downlink frame arrives.

Watches a local mqtt-sniff.py JSONL (no broker/network access of its own). On a
new frame matching --service-type, calls mqtt-capture.dump_heap_once once, with
a short cooldown; repeated /proc/pid/mem polling is what broke the captcha.
"""
import argparse
import json
import os
import sys
import time
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mc", os.path.join(HERE, "mqtt-capture.py"))
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)


def last_line_count(path):
    if not os.path.exists(path):
        return 0
    with open(path, "rb") as f:
        return sum(1 for _ in f)


def new_target_frames(path, offset, service_type):
    hits = []
    if not os.path.exists(path):
        return hits, offset
    with open(path, errors="replace") as f:
        for i, line in enumerate(f):
            if i < offset or not line.strip():
                continue
            try:
                row = json.loads(line)
                payload = row.get("payload", "")
                d = json.loads(payload) if isinstance(payload, str) else payload
            except (ValueError, TypeError):
                continue
            if service_type is None or d.get("service_type") == service_type:
                hits.append(d)
    return hits, last_line_count(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--serial", required=True)
    ap.add_argument("--service-type", type=int, default=None)
    ap.add_argument("--seconds", type=int, default=300)
    ap.add_argument("--cooldown", type=float, default=3.0)
    ap.add_argument("--out-dir", default=None)
    args = ap.parse_args()

    out_dir = args.out_dir or mc.HEAP_DIR
    os.makedirs(out_dir, exist_ok=True)
    offset = last_line_count(args.frames)
    deadline = time.time() + args.seconds
    last_dump = 0.0
    taken = 0
    print(f"[watch] frames={args.frames} service_type={args.service_type} "
          f"seconds={args.seconds} cooldown={args.cooldown}", flush=True)
    while time.time() < deadline:
        hits, offset = new_target_frames(args.frames, offset, args.service_type)
        if hits and time.time() - last_dump >= args.cooldown:
            taken += 1
            path = os.path.join(out_dir, f"trigger-{int(time.time()*1000)}.txt")
            ok = mc.dump_heap_once(args.serial, path)
            print(f"[dump] #{taken} frames={len(hits)} ok={ok} path={path}", flush=True)
            last_dump = time.time()
        time.sleep(0.5)
    print(f"[done] dumps={taken}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
