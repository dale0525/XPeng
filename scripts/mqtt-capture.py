#!/usr/bin/env python3
"""Prepare and collect a read-only MQTT credential capture.

arm:     clear logcat and start a background ADB logcat recorder. No heap read
         happens during login: repeated /proc/<pid>/mem reads are known to stall
         the App main thread and break the captcha WebView (grab-ticket.py:4-6).
collect: stop the recorder, take ONE am dumpheap snapshot after login, parse it
         for the createMqttAccount response, and write the credential to a
         gitignored path. Never publishes, never calls createMqttAccount, never
         changes device or login state.
status:  report capture state and whether a credential has been recovered.
"""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time

ADB = "/Volumes/LogicExt/Git/BookReader/.android-sdk/platform-tools/adb"
PKG = "com.xiaopeng.mycarinfo"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# A worktree has no work/ of its own; forensic assets live in the main repo.
WORK = os.path.join(ROOT, "work")
if not os.path.isdir(WORK):
    WORK = os.path.abspath(os.path.join(ROOT, "..", "..", "work"))
LIVE = os.path.join(WORK, "live", "capture")
STATE = os.path.join(LIVE, "state.json")
LOGCAT = os.path.join(LIVE, "logcat.txt")
HEAP_DIR = os.path.join(LIVE, "heap")
CRED = os.path.join(WORK, "live", "mqtt-owner.json")
UID_FILE = os.path.join(WORK, "live", "uid.txt")


def owner_uid():
    if os.path.isfile(CRED):
        try:
            return json.load(open(CRED, encoding="utf-8"))["clientId"].split(":")[2]
        except (OSError, ValueError, KeyError, IndexError):
            pass
    if os.path.isfile(UID_FILE):
        return open(UID_FILE, encoding="utf-8").read().strip()
    return "1000001"


OWNER_UID = owner_uid()


def adb(*args, serial=None, binary=False):
    cmd = [ADB]
    if serial:
        cmd += ["-s", serial]
    cmd += list(args)
    return subprocess.run(cmd, capture_output=True, text=not binary, timeout=180)


def device():
    r = adb("devices")
    for line in r.stdout.splitlines()[1:]:
        cols = line.split()
        if len(cols) >= 2 and cols[1] == "device":
            return cols[0]
    raise RuntimeError("no online adb device")


def app_pid(serial):
    r = adb("shell", "pidof", PKG, serial=serial)
    return r.stdout.strip().split()[0] if r.stdout.strip() else None


def start_bg(cmd, pid_file, stdout=None):
    p = subprocess.Popen(cmd, stdout=stdout or subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    with open(pid_file, "w") as f:
        f.write(str(p.pid))
    return p.pid


def stop_bg(pid_file):
    if not os.path.exists(pid_file):
        return
    pid = int(open(pid_file).read().strip())
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.remove(pid_file)


def arm(serial):
    os.makedirs(HEAP_DIR, exist_ok=True)
    for f in os.listdir(HEAP_DIR):
        os.remove(os.path.join(HEAP_DIR, f))
    adb("logcat", "-c", serial=serial)
    logcat_out = open(LOGCAT, "wb")
    log_pid = start_bg([ADB, "-s", serial, "exec-out", "logcat", "-v", "time"],
                       os.path.join(LIVE, "logcat.pid"), stdout=logcat_out)
    state = {"serial": serial, "logcat_pid": log_pid, "armed_at": time.time(),
             "sampler": "disabled-am-dumpheap-on-collect"}
    with open(STATE, "w") as f:
        json.dump(state, f)
    print(f"armed serial={serial} logcat_pid={log_pid} heap_sampling=disabled")


def strings_both(data):
    """Extract ASCII and UTF-16 strings from one memory blob."""
    p = subprocess.Popen(["strings", "-a", "-n", "8", "-e", "l"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    u16 = p.communicate(data)[0]
    p = subprocess.Popen(["strings", "-a", "-n", "8"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    asc = p.communicate(data)[0]
    return b"[utf16]\n" + u16 + b"\n[ascii]\n" + asc


def dump_heap_once(serial, path):
    """One heap read AFTER login. No polling: repeated /proc/pid/mem reads are
    known to stall the App and break the captcha WebView (grab-ticket.py:4-6).
    A release App is not debuggable, so fall back to one filtered mem read.
    """
    pid = app_pid(serial)
    if not pid:
        print("App process not found; cannot read heap", file=sys.stderr)
        return False
    remote = f"/data/local/tmp/mqtt-owner-{pid}.hprof"
    r = adb("shell", "am", "dumpheap", pid, remote, serial=serial)
    if r.returncode == 0:
        out = adb("exec-out", f"cat {remote}", serial=serial, binary=True)
        adb("shell", "rm", "-f", remote, serial=serial)
        if out.returncode == 0 and out.stdout:
            with open(path, "wb") as f:
                f.write(strings_both(out.stdout))
            return True
    base = adb("shell", f"su -c \"grep -m1 'anon:dalvik-main space' "
               f"/proc/{pid}/maps | cut -d- -f1\"", serial=serial).stdout.strip()
    if not base:
        print("no Dalvik main-space base; cannot read heap", file=sys.stderr)
        return False
    cmd = (f"su -c 'dd if=/proc/{pid}/mem bs=1048576 iflag=skip_bytes,count_bytes "
           f"skip=0x{base} count=0x08000000 2>/dev/null | strings -n 8 | "
           "grep -a -E -B 3 -A 24 "
           "\"MqttAccountRes|clientId=|username=|password=|serverSsL=|expireTime=|"
           "createMqttAccount|xmart:app:|iot-app.xiaopeng.com|"
           "protocol_ver|msg_id|msg_ref|service_type|cmd_type|cmd_value|"
           "camera_type|camera_degree|tee_id|target_id|>>>publish|"
           "sendVehicleMsgAsync|unLockAndStart|remote_start\" | head -6000'")
    out = adb("exec-out", cmd, serial=serial, binary=True)
    if out.returncode != 0 or not out.stdout:
        print("single filtered heap read failed", file=sys.stderr)
        return False
    with open(path, "wb") as f:
        f.write(out.stdout)
    return True


def find_credential():
    if not os.path.isdir(HEAP_DIR):
        return None, False
    chunks = []
    for name in sorted(os.listdir(HEAP_DIR)):
        chunks.append(open(os.path.join(HEAP_DIR, name), errors="replace").read())
    text = "\n".join(chunks)
    # A createMqttAccount response gives all five fields as one JSON object.
    for m in re.finditer(r"\{[^{}]{0,800}(?:clientId|serverSsl|serverSsL)[^{}]{0,800}\}", text):
        try:
            d = json.loads(m.group(0))
        except ValueError:
            continue
        if (all(k in d for k in ("clientId", "username", "password", "serverSsl"))
                and d["clientId"].split(":")[2] == OWNER_UID):
            return d, False
    # HPROF string boundaries can cut the leading `{"client` off, leaving a
    # fragment that starts at `Id":"...`. The five values are still contiguous;
    # require the owner uid and equal clientId/username before accepting it.
    frag = re.search(
        r"Id\":\"(xmart:app:" + OWNER_UID + r":[^\"]+)\",\"username\":\"([^\"]+)\","
        r"\"password\":\"([^\"]+)\",\"serverSsl\":\"([^\"]+)\",\"expireTime\":(\d{13})",
        text)
    if frag and frag.group(1) == frag.group(2) and frag.group(4).endswith(":8883"):
        return {"clientId": frag.group(1), "username": frag.group(2),
                "password": frag.group(3), "serverSsl": frag.group(4),
                "expireTime": int(frag.group(5))}, False
    # A Kotlin toString only proves fields existed in memory; its password value
    # is not reliably recoverable. Never reconstruct a partial credential or
    # probe the broker with it (repository hard gate: no enumeration).
    has_partial = bool(re.search(r"password=['\"]?[A-Za-z0-9+/=_-]{20,32}", text))
    return None, has_partial


def collect(serial):
    stop_bg(os.path.join(LIVE, "logcat.pid"))
    stop_bg(os.path.join(LIVE, "sampler.pid"))
    if os.path.exists(STATE):
        os.remove(STATE)
    sample = os.path.join(HEAP_DIR, "dumpheap.txt")
    if not dump_heap_once(serial, sample):
        return 1
    cred, has_partial = find_credential()
    if has_partial:
        print("partial credential in heap; refusing to reconstruct or probe broker",
              file=sys.stderr, flush=True)
    if not cred:
        print("no complete owner credential found in dumpheap")
        return 1
    with open(CRED, "w") as f:
        json.dump(cred, f)
    print(f"credential saved: {CRED} uid={cred['clientId'].split(':')[2]} "
          f"keys={sorted(cred)}")
    return 0


def status(serial):
    armed = os.path.exists(STATE)
    samples = len(os.listdir(HEAP_DIR)) if os.path.isdir(HEAP_DIR) else 0
    cred = os.path.exists(CRED)
    print(f"serial={serial} armed={armed} heap_samples={samples} "
          f"credential={cred} logcat_bytes={os.path.getsize(LOGCAT) if os.path.exists(LOGCAT) else 0}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("arm").add_argument("--serial", default=None)
    sub.add_parser("collect").add_argument("--serial", default=None)
    sub.add_parser("status").add_argument("--serial", default=None)
    args = ap.parse_args()
    serial = args.serial or device()
    if args.cmd == "arm":
        arm(serial)
    elif args.cmd == "collect":
        return collect(serial)
    else:
        return status(serial)


if __name__ == "__main__":
    sys.exit(main())
