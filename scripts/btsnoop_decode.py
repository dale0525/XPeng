#!/usr/bin/env python3
"""Extract XPeng BLE digital-key ATT frames from btsnoop HCI logs.

Only structural fields are emitted. Payload bytes, keys, signatures and
identifiers never appear in the JSON output.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

BTSNOOP_MAGIC = b"btsnoop\x00"
HCI_ACL = 0x02
ATT_CID = 0x0004
ATT_WRITE_REQ = 0x12
ATT_WRITE_CMD = 0x52
ATT_HANDLE_VALUE_NTF = 0x1B
ATT_HANDLE_VALUE_IND = 0x1D
COMMAND_HANDLE = 0x000C
NOTIFY_HANDLE = 0x000F
CCCD_HANDLE = 0x0010
CHANNELS = {0xEC, 0xED, 0xEF}
HEADER_LENGTH = 3
TBOX_HEADER_LENGTH = 7
RECORD_HEADER = struct.Struct(">IIIIQ")
BTSNOOP_EPOCH_OFFSET_US = 62_135_596_800_000_000


def _iter_packets(data: bytes):
    if data[:8] != BTSNOOP_MAGIC:
        raise ValueError("not a btsnoop file")
    version, datalink = struct.unpack(">II", data[8:16])
    if version != 1 or datalink != 1002:
        raise ValueError(f"unsupported btsnoop version/datalink: {version}/{datalink}")
    offset = 16
    while offset + RECORD_HEADER.size <= len(data):
        original_len, included_len, flags, direction, timestamp = RECORD_HEADER.unpack_from(data, offset)
        offset += RECORD_HEADER.size
        packet = data[offset : offset + included_len]
        offset += included_len
        yield flags, direction, timestamp, packet


def last_record_ts(data: bytes) -> int:
    return max((timestamp for _, _, timestamp, _ in _iter_packets(data)), default=0)


def _collect(data: bytes, since_ts: int = 0) -> list[dict]:
    events: list[dict] = []
    for flags, direction, timestamp, packet in _iter_packets(data):
        if timestamp <= since_ts:
            continue
        wall_ms = (timestamp - BTSNOOP_EPOCH_OFFSET_US) // 1_000
        if len(packet) < 5 or packet[0] != HCI_ACL:
            continue
        hci_handle, acl_len = struct.unpack_from("<HH", packet, 1)
        if (hci_handle >> 12) & 0x3:
            continue
        l2cap = packet[5 : 5 + acl_len]
        if len(l2cap) < 7:
            continue
        pdu_len, cid = struct.unpack_from("<HH", l2cap, 0)
        if cid != ATT_CID or pdu_len + 4 > len(l2cap):
            continue
        opcode = l2cap[4]
        handle = struct.unpack_from("<H", l2cap, 5)[0]
        value = l2cap[7:]
        if opcode == ATT_WRITE_REQ and handle == CCCD_HANDLE:
            events.append({"kind": "cccd", "flags": flags, "ts": timestamp, "wall_ms": wall_ms, "value": value.hex()})
            continue
        if opcode in (ATT_WRITE_REQ, ATT_WRITE_CMD) and handle == COMMAND_HANDLE:
            if not value or value[0] not in CHANNELS:
                continue
            channel = value[0]
            chunk_len = value[2] if len(value) > 2 else None
            tbox = value[HEADER_LENGTH:]
            tbox_len = None
            msg_type = None
            if channel in (0xEC, 0xED) and len(tbox) >= TBOX_HEADER_LENGTH:
                tbox_len = int.from_bytes(tbox[0:2], "big")
                msg_type = tbox[6]
            event = {
                "kind": "write",
                "opcode": opcode,
                "flags": flags,
                "ts": timestamp,
                "wall_ms": wall_ms,
                "channel": f"0x{channel:02x}",
                "second": value[1] if len(value) > 1 else None,
                "chunk_len": chunk_len,
                "value_len": len(value),
                "tbox_len": tbox_len,
                "type": msg_type,
            }
            if channel == 0xED and chunk_len not in (0x18, None) and value:
                event["cmd"] = value[-1]
                event["cmd_hex"] = f"0x{value[-1]:02x}"
            events.append(event)
            continue
        if opcode in (ATT_HANDLE_VALUE_NTF, ATT_HANDLE_VALUE_IND) and handle == NOTIFY_HANDLE:
            records = []
            for pos in range(0, len(value) - 9, 10):
                rec = value[pos : pos + 10]
                msg_id = int.from_bytes(rec[0:2], "big")
                result = int.from_bytes(rec[6:8], "little")
                records.append({"msg_id": f"0x{msg_id:04x}", "result": result})
            events.append(
                {"kind": "indication" if opcode == ATT_HANDLE_VALUE_IND else "notification",
                 "flags": flags, "ts": timestamp, "wall_ms": wall_ms,
                 "value_len": len(value), "records": records},
            )
    return events


def _summarize(events: list[dict]) -> dict:
    writes = [e for e in events if e["kind"] == "write"]
    commands = [e for e in writes if "cmd" in e]
    return {
        "event_count": len(events),
        "write_count": len(writes),
        "command_count": len(commands),
        "command_cmds": [e["cmd_hex"] for e in commands],
        "events": events,
    }


def decode_from_bytes(data: bytes, since_ts: int = 0) -> dict:
    return {"size": len(data), "since_ts": since_ts, **_summarize(_collect(data, since_ts))}


def decode_with_bytes(current: bytes, previous: bytes, since_ts: int = 0) -> dict:
    events = _collect(current, since_ts) + _collect(previous, since_ts)
    events.sort(key=lambda event: event["ts"])
    return {
        "size": len(current) + len(previous),
        "since_ts": since_ts,
        **_summarize(events),
    }


def decode(paths: list[Path], since_ts: int = 0) -> dict:
    events: list[dict] = []
    sizes = 0
    for path in paths:
        data = path.read_bytes()
        sizes += len(data)
        events.extend(_collect(data, since_ts))
    events.sort(key=lambda event: event["ts"])
    return {
        "files": [path.name for path in paths],
        "size": sizes,
        "since_ts": since_ts,
        **_summarize(events),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logs", nargs="+", type=Path, help="btsnoop_hci*.log; pass .log.last too")
    parser.add_argument("--since-ts", type=int, default=0, help="drop records at or before this HCI timestamp")
    parser.add_argument("--last-ts", action="store_true", help="print the last HCI record timestamp and exit")
    parser.add_argument("--json", type=Path, help="write JSON summary here")
    args = parser.parse_args()
    if args.last_ts:
        print(max(last_record_ts(path.read_bytes()) for path in args.logs))
        return 0
    result = decode(args.logs, args.since_ts)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{args.json}: {result['command_count']} command frames, {result['write_count']} writes")
    else:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
