#!/usr/bin/env python3
"""Offline contract tests for analyze_frames.summarize."""
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("af", os.path.join(ROOT, "analyze-frames.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def frame(topic, payload):
    return {"ts": 1.0, "topic": topic, "qos": 1,
            "payload": json.dumps(payload, separators=(",", ":"), ensure_ascii=False)}


rows = [
    frame("Xmart/Send/User/1000001",
          {"service_type": 9, "msg_content": {"cmd_type": 3}}),
    frame("Xmart/Msg/User/1000001",
          {"service_type": 9, "msg_content": {"cmd_type": 3, "code": 200}}),
    frame("Mona/Send/User/1000001",
          {"service_type": 11, "msg_content": {"cmd_type": 2, "cmd_value": 2,
           "pushType": 1, "protocolType": 2, "camera_status": -2, "camera_type": 9}}),
    frame("Xmart/Msg/User/1000001",
          {"service_type": 11, "msg_content": {"cmd_type": 2, "cmd_value": 11,
           "camera_type": 1, "camera_live_url": "<URL>"}}),
    frame("Xmart/Send/User/1000001",
          {"service_type": 9, "msg_content": {"cmd_type": 6, "token": "FAKEHEXTOKEN"}}),
    frame("Xmart/Msg/User/1000001",
          {"service_type": 19, "msg_content": {"instant": {"power":
           {"remote_start_status": 1}}}}),
    frame("Xmart/Msg/User/1000001", {"service_type": 9, "msg_content": {
        "code": 10905, "msg": "车辆已下电，临停不可用"}}),
    frame("Xmart/Msg/User/1000001", {"service_type": 8, "code": 200}),
]
out = m.summarize(rows)


def check(name, cond):
    print(f"{'PASS' if cond else 'FAIL'} {name}")
    if not cond:
        sys.exit(1)


check("frame count", out["frames"] == 8)
check("service_type counts", out["by_service_type"]["9"] == 4 and
      out["by_service_type"]["11"] == 2 and out["by_service_type"]["19"] == 1)
check("directions", out["directions"]["up"] == 3 and out["directions"]["down"] == 5)
check("temporary parking hits request and 10905 response", len(out["targets"]["temporary_parking"]) == 3)
check("remote view hit with camera fields", len(out["targets"]["remote_view"]) == 2 and
      out["camera_fields"]["camera_status"] == -2)
check("camera command alignment", [(c["cmd_value"], c["angle"], c["camera_live_url"])
      for c in out["camera_commands"]] == [(2, "front", False)])
check("camera angle map", m.CAMERA_ANGLES == {2: ("front", 1), 3: ("back", 3),
      4: ("left", 5), 5: ("right", 7)})
check("camera angle map in summary", out["camera_angle_map"] ==
      {1: "front", 3: "back", 5: "left", 7: "right"})
check("current camera angle annotated", out["camera_fields"].get("angle") == "front")
camera_rows = [frame("Xmart/Msg/User/1000001", {
    "service_type": 11, "msg_content": {"cmd_type": 2, "cmd_value": cv,
    "camera_type": expected, "camera_live_url": "<URL>"}})
    for cv, (_, expected) in m.CAMERA_ANGLES.items()]
camera_out = m.summarize(camera_rows)["camera_commands"]
check("four camera angles paired", [(c["cmd_value"], c["angle"], c["camera_type"])
      for c in camera_out] == [(2, "front", 1), (3, "back", 3),
      (4, "left", 5), (5, "right", 7)])
check("stream open excluded from angle matrix", m.summarize([
    frame("Xmart/Msg/User/1000001", {"service_type": 11, "msg_content": {
        "cmd_type": 2, "cmd_value": 11, "camera_type": 1}})])["camera_commands"] == [])
check("remote start hits request and state frame", len(out["targets"]["remote_start"]) == 2)
check("token never echoed in summary", "FAKEHEXTOKEN" not in json.dumps(out)
      and "<URL>" not in json.dumps(out))
check("neutral frame not tagged", out["targets"]["remote_view"][0]["service_type"] == 11)
