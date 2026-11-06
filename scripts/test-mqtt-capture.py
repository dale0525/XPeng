#!/usr/bin/env python3
"""Offline contract tests for mqtt_capture.find_credential.

Uses a temporary heap-sample directory; never touches the device or broker.
"""
import importlib.util
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mqtt_capture", os.path.join(ROOT, "mqtt-capture.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

DI = "00000000000000000000000000000000"
CID = f"xmart:app:{m.OWNER_UID}:{DI}:2.0:V5.19.0"
PW = "AbCdEf0123456789+/abCdEf"
SERVER = "iot-app.xiaopeng.com:8883"


def with_samples(text):
    tmp = tempfile.mkdtemp(prefix="mqtt-capture-test-")
    with open(os.path.join(tmp, "sample.txt"), "w") as f:
        f.write(text)
    old = m.HEAP_DIR
    m.HEAP_DIR = tmp
    try:
        return m.find_credential()
    finally:
        m.HEAP_DIR = old


def check(name, cond):
    print(f"{'PASS' if cond else 'FAIL'} {name}")
    if not cond:
        sys.exit(1)


# 1) A complete createMqttAccount JSON response is accepted verbatim.
cred_obj = {"clientId": CID, "username": CID, "password": PW,
            "serverSsl": SERVER, "expireTime": 1793968484000}
cred, has_partial = with_samples("noise\n" + json.dumps(cred_obj) + "\nnoise\n")
check("JSON response parsed", cred == cred_obj and has_partial is False)

# 1b) HPROF can cut off the leading `{"client`; the remaining fragment still
# holds all five values contiguously and must be accepted.
truncated = ('{"vin":"TESTVIN00000000001"}'
             + json.dumps(cred_obj, separators=(",", ":"))[len('{"client'):])
cred, has_partial = with_samples("noise\n" + truncated + "\nnoise\n")
check("truncated response fragment parsed", cred == cred_obj and has_partial is False)

# 2) A Kotlin toString is partial evidence only: no reconstructed credential.
text = (
    "MqttAccountRes{clientId='" + CID + "\n"
    "username='" + CID + "\n"
    "password='" + PW + "\n"
    "serverSsL='" + SERVER + "\n"
    "expireTime=1793968484000\n"
)
cred, has_partial = with_samples(text)
check("toString yields no credential", cred is None and has_partial is True)

# 3) No explicit password= field means no partial marker either.
cred, has_partial = with_samples("xmart:app:" + m.OWNER_UID + ":" + DI +
                                 "\nssl://" + SERVER + "\n" + "bare24characters000000000\n")
check("bare token is not a candidate", cred is None and has_partial is False)

# 4) A sub-account JSON must not be accepted as an owner credential.
sub = json.dumps(dict(cred_obj, clientId=CID.replace(m.OWNER_UID, "2000002"),
                      username=CID.replace(m.OWNER_UID, "2000002")))
cred, has_partial = with_samples(sub)
check("sub-account JSON rejected on owner uid", cred is None and has_partial is False)
