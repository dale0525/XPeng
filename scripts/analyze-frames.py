#!/usr/bin/env python3
"""Summarize mqtt-sniff.py JSONL frames for the three target commands.

Read-only: parses a local capture file, never connects to a broker.
"""
import argparse
import json

TARGETS = {
    # st=9 code=200 成功回执对临停与远程启动是同一形态，不能凭下行帧强行区分。
    "temporary_parking": lambda st, ct, cv, p: st == 9 and (
        ct == 3 or ("10905" in p and "临停不可用" in p)),
    "remote_view": lambda st, ct, cv, p: st == 11,
    "remote_start": lambda st, ct, cv, p: (st == 9 and ct == 6) or
        "remote_start_status" in p or '"action":"remote_start"' in p or
        '"action": "remote_start"' in p,
}
CAMERA_FIELDS = ("camera_status", "camera_degree", "camera_type",
                 "live_push_status", "camera_os_switch", "camera_360")
# cmd_value -> (UI angle, observed downlink camera_type); cmd_value=11 opens the stream.
CAMERA_ANGLES = {2: ("front", 1), 3: ("back", 3), 4: ("left", 5),
                 5: ("right", 7)}
CAMERA_TYPE_ANGLES = {observed: angle for angle, observed in CAMERA_ANGLES.values()}


def parse_payload(row):
    raw = row.get("payload", "")
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return {}


def summarize(rows):
    out = {"frames": 0, "by_service_type": {}, "directions": {},
           "targets": {k: [] for k in TARGETS}, "camera_fields": {},
           "camera_angle_map": dict(CAMERA_TYPE_ANGLES),
           "camera_commands": []}
    for row in rows:
        out["frames"] += 1
        d = parse_payload(row)
        st = d.get("service_type")
        mc = d.get("msg_content") if isinstance(d.get("msg_content"), dict) else {}
        ct, cv = mc.get("cmd_type"), mc.get("cmd_value")
        topic = row.get("topic", "")
        direction = "up" if "/Send/" in topic else "down" if "/Msg/" in topic else "other"
        code = d.get("code", mc.get("code"))
        out["by_service_type"][str(st)] = out["by_service_type"].get(str(st), 0) + 1
        out["directions"][direction] = out["directions"].get(direction, 0) + 1
        raw = row.get("payload", "")
        text = raw if isinstance(raw, str) else json.dumps(raw)
        for name, pred in TARGETS.items():
            if pred(st, ct, cv, text):
                out["targets"][name].append({
                    "ts": row.get("ts"), "topic": topic, "service_type": st,
                    "cmd_type": ct, "cmd_value": cv, "code": code,
                    "remote_start_status": (
                        mc.get("instant", {}).get("power", {}).get("remote_start_status")
                        if isinstance(mc.get("instant"), dict) else None)})
        for k in CAMERA_FIELDS:
            if k in mc:
                out["camera_fields"][k] = mc[k]
        if st == 11 and "camera_type" in mc:
            out["camera_fields"]["angle"] = CAMERA_TYPE_ANGLES.get(
                mc["camera_type"], "unknown")
        if st == 11 and ct == 2 and cv is not None and cv != 11:
            angle, expected_type = CAMERA_ANGLES.get(cv, ("unknown", None))
            out["camera_commands"].append({
                "cmd_value": cv, "camera_type": mc.get("camera_type"),
                "angle": angle, "expected_camera_type": expected_type,
                "camera_live_url": bool(mc.get("camera_live_url")),
                "code": code, "msg_ref": d.get("msg_ref")})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("jsonl")
    args = ap.parse_args()
    rows = [json.loads(line) for line in open(args.jsonl, encoding="utf-8") if line.strip()]
    print(json.dumps(summarize(rows), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
