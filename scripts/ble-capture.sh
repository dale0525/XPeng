#!/usr/bin/env bash
# Prepare and collect XPeng BLE HCI captures on the USB-connected Pixel 4a.
# User performs the App taps; this script only handles device-side capture.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${XPENG_ADB:-/Applications/QtScrcpy.app/Contents/MacOS/adb}"
SERIAL="${XPENG_ADB_SERIAL:-0B181JEC210197}"
export ANDROID_SERIAL="$SERIAL"
OUT="$ROOT/work/ble-capture"
STATE="$OUT/.device-state"
mkdir -p "$OUT"

adb_sh() { "$ADB" -s "$SERIAL" shell "$@"; }
root_sh() { "$ADB" -s "$SERIAL" shell "su -c '$1'"; }
now() { date +%Y%m%d-%H%M%S; }

check() {
  "$ADB" devices | grep -q "^$SERIAL[[:space:]]" || { echo "USB device $SERIAL is offline" >&2; exit 1; }
  adb_sh 'su -c id' | grep -q 'uid=0' || { echo "root unavailable" >&2; exit 1; }
  adb_sh 'pm path com.xiaopeng.mycarinfo' | grep -q package: || { echo "official app missing" >&2; exit 1; }
  echo "device=$SERIAL app=$(adb_sh 'dumpsys package com.xiaopeng.mycarinfo' | grep -m1 versionName | tr -d '\r' | sed 's/.*versionName=//' | awk '{print $1}')"
  echo "snoop=$(adb_sh 'settings get global bluetooth_btsnoop_log_mode' | tr -d '\r')"
}

prepare() {
  check
  {
    echo "wifi_on=$(adb_sh 'settings get global wifi_on' | tr -d '\r')"
    echo "mobile_data=$(adb_sh 'settings get global mobile_data' | tr -d '\r')"
    echo "airplane_mode_on=$(adb_sh 'settings get global airplane_mode_on' | tr -d '\r')"
    echo "bluetooth_on=$(adb_sh 'settings get global bluetooth_on' | tr -d '\r')"
  } > "$STATE"
  adb_sh 'settings put global bluetooth_btsnoop_log_mode full'
  adb_sh 'cmd bluetooth_manager disable' >/dev/null
  adb_sh 'cmd bluetooth_manager enable' >/dev/null
  for _ in $(seq 1 20); do
    [ "$(adb_sh 'settings get global bluetooth_on' | tr -d '\r')" = 1 ] && break
    sleep 1
  done
  echo "prepared: bluetooth ON, HCI snoop full; saved prior network state to $STATE"
  echo "next: $0 arm <action-label>   (then you tap the App)"
}

arm() {
  local label="${1:?usage: arm <action-label>}"
  local id; id="$(now)-$(printf '%s' "$label" | tr -c 'A-Za-z0-9_-' '_')"
  local run="$OUT/$id"
  mkdir -p "$run"
  check
  adb_sh 'logcat -c'
  root_sh 'cp /data/misc/bluetooth/logs/btsnoop_hci.log /data/local/tmp/btsnoop_arm.log'
  root_sh 'chmod 644 /data/local/tmp/btsnoop_arm.log'
  "$ADB" -s "$SERIAL" pull /data/local/tmp/btsnoop_arm.log "$run/arm.btsnoop.log" >/dev/null
  python3 "$ROOT/scripts/btsnoop_decode.py" --last-ts "$run/arm.btsnoop.log" > "$run/since_ts"
  {
    echo "# $label"
    echo
    echo "- run_id: $id"
    echo "- since_ts: $(cat "$run/since_ts")"
    echo "- action: $label"
    echo "- iv_top_icon_bounds: "
    echo "- network: airplane_mode=$(adb_sh 'settings get global airplane_mode_on' | tr -d '\r') wifi_on=$(adb_sh 'settings get global wifi_on' | tr -d '\r') bluetooth_on=$(adb_sh 'settings get global bluetooth_on' | tr -d '\r')"
    echo "- physical_result: "
    echo "- command_frames: see summary.json"
    echo "- notes: "
  } > "$run/notes.md"
  printf '%s\n' "$id" > "$OUT/.current-run"
  echo "armed=$run"
  echo "since_ts=$(cat "$run/since_ts")"
  echo "Tap the App action now, then run: $0 collect $id"
}

collect() {
  local id="${1:-$(cat "$OUT/.current-run" 2>/dev/null || true)}"
  [ -n "$id" ] || { echo "missing run id" >&2; exit 1; }
  local run="$OUT/$id"
  [ -d "$run" ] || { echo "missing run dir: $run" >&2; exit 1; }
  check
  root_sh 'cp /data/misc/bluetooth/logs/btsnoop_hci.log /data/local/tmp/btsnoop_capture.log'
  root_sh 'cp /data/misc/bluetooth/logs/btsnoop_hci.log.last /data/local/tmp/btsnoop_capture.last 2>/dev/null || true'
  root_sh 'chmod 644 /data/local/tmp/btsnoop_capture*.log* /data/local/tmp/btsnoop_capture.last 2>/dev/null || true'
  "$ADB" -s "$SERIAL" pull /data/local/tmp/btsnoop_capture.log "$run/btsnoop_hci.log" >/dev/null
  "$ADB" -s "$SERIAL" pull /data/local/tmp/btsnoop_capture.last "$run/btsnoop_hci.log.last" >/dev/null 2>&1 || true
  "$ADB" -s "$SERIAL" logcat -d -v time > "$run/logcat.txt"
  root_sh 'cp /data/data/com.xiaopeng.mycarinfo/databases/XpVehicle.db /data/local/tmp/XpVehicle_capture.db'
  root_sh 'chmod 644 /data/local/tmp/XpVehicle_capture.db'
  "$ADB" -s "$SERIAL" pull /data/local/tmp/XpVehicle_capture.db "$run/XpVehicle.db" >/dev/null
  local since; since="$(cat "$run/since_ts")"
  local logs=("$run/btsnoop_hci.log")
  [ -s "$run/btsnoop_hci.log.last" ] && logs+=("$run/btsnoop_hci.log.last")
  python3 "$ROOT/scripts/btsnoop_decode.py" "${logs[@]}" --since-ts "$since" --json "$run/summary.json"
  echo "run_dir=$run"
  echo "hci_bytes=$(stat -f%z "$run/btsnoop_hci.log") logcat_lines=$(wc -l < "$run/logcat.txt" | tr -d ' ')"
  echo "record your action + physical result in $run/notes.md"
}

restore() {
  check
  [ -f "$STATE" ] || { echo "no saved network state: $STATE" >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$STATE"
  adb_sh 'cmd connectivity airplane-mode disable' >/dev/null
  if [ "$bluetooth_on" = 1 ]; then adb_sh 'cmd bluetooth_manager enable' >/dev/null; fi
  echo "restored airplane_mode=0 wifi_on=$(adb_sh 'settings get global wifi_on' | tr -d '\r') bluetooth_on=$(adb_sh 'settings get global bluetooth_on' | tr -d '\r')"
}

offline() {
  check
  [ -f "$STATE" ] || prepare
  # Airplane mode removes the active network while USB adb stays connected.
  adb_sh 'cmd connectivity airplane-mode enable' >/dev/null
  sleep 2
  adb_sh 'cmd bluetooth_manager enable' >/dev/null
  sleep 2
  echo "offline: airplane_mode=$(adb_sh 'settings get global airplane_mode_on' | tr -d '\r') active_networks=$(adb_sh 'dumpsys connectivity' | grep -c 'NetworkAgentInfo{network' || true) bluetooth_on=$(adb_sh 'settings get global bluetooth_on' | tr -d '\r')"
}

case "${1:-}" in
  check) check ;;
  prepare) prepare ;;
  arm) shift; arm "$@" ;;
  collect) shift; collect "$@" ;;
  offline) offline ;;
  restore) restore ;;
  *) echo "usage: $0 {check|prepare|offline|arm <label>|collect [run-id]|restore}" >&2; exit 2 ;;
esac
