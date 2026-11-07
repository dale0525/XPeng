#!/usr/bin/env python3
"""Decode btsnoop HCI logs into generic ATT and L2CAP events, offline only."""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from uuid import UUID

BTSNOOP_MAGIC = b"btsnoop\x00"
RECORD_HEADER = struct.Struct(">IIIIQ")
BTSNOOP_EPOCH_OFFSET_US = 62_135_596_800_000_000
HCI_ACL = 0x02
ATT_CID = 0x0004

ATT_KINDS = {
    0x01: "error_rsp",
    0x02: "exchange_mtu_req",
    0x03: "exchange_mtu_rsp",
    0x04: "find_info_req",
    0x05: "find_info_rsp",
    0x06: "find_by_type_value_req",
    0x07: "find_by_type_value_rsp",
    0x08: "read_by_type_req",
    0x09: "read_by_type_rsp",
    0x0A: "read_req",
    0x0B: "read_rsp",
    0x0C: "read_blob_req",
    0x0D: "read_blob_rsp",
    0x0E: "read_multiple_req",
    0x0F: "read_multiple_rsp",
    0x10: "read_by_group_type_req",
    0x11: "read_by_group_type_rsp",
    0x12: "write",
    0x13: "write_rsp",
    0x16: "prepare_write_req",
    0x17: "prepare_write_rsp",
    0x18: "execute_write_req",
    0x19: "execute_write_rsp",
    0x1B: "notification",
    0x1D: "indication",
    0x1E: "handle_value_confirmation",
    0x20: "read_multiple_variable_req",
    0x21: "read_multiple_variable_rsp",
    0x23: "multiple_handle_value_notification",
    0x52: "write",
    0xD2: "signed_write_command",
}
HANDLE_PREFIX_OPCODES = {0x0A, 0x0C, 0x12, 0x16, 0x1B, 0x1D, 0x52, 0xD2}
UUID_REQUEST_OPCODES = {0x08, 0x10}
START_END_REQUEST_OPCODES = {0x04, 0x06, 0x08, 0x10}


def iter_packets(data: bytes):
    if data[:8] != BTSNOOP_MAGIC:
        raise ValueError("not a btsnoop file")
    version, datalink = struct.unpack_from(">II", data, 8)
    if version != 1 or datalink != 1002:
        raise ValueError(f"unsupported btsnoop version/datalink: {version}/{datalink}")
    offset = 16
    while offset + RECORD_HEADER.size <= len(data):
        original_length, included_length, flags, direction, timestamp = RECORD_HEADER.unpack_from(data, offset)
        offset += RECORD_HEADER.size
        packet = data[offset : offset + included_length]
        offset += len(packet)
        yield {
            "original_length": original_length,
            "included_length": included_length,
            "flags": flags,
            "direction": direction,
            "timestamp": timestamp,
            "packet": packet,
            "truncated": len(packet) < included_length,
        }
        if len(packet) < included_length:
            break


def _auto_int(value: str) -> int:
    return int(value, 0)


def _uuid_text(raw: bytes) -> str | None:
    if len(raw) == 2:
        return f"{struct.unpack_from('<H', raw)[0]:04x}"
    if len(raw) == 16:
        # ATT transmits a 128-bit UUID as the reverse of its canonical big-endian bytes.
        return str(UUID(bytes=raw[::-1]))
    return None


def _uuid_from_tail(value: bytes) -> str | None:
    if len(value) in (2, 16):
        return _uuid_text(value)
    if len(value) > 16:
        return _uuid_text(value[-16:])
    if len(value) > 2:
        return _uuid_text(value[-2:])
    return None


def _chunks(data: bytes, size: int):
    if size <= 0:
        return
    for offset in range(0, len(data) - size + 1, size):
        yield data[offset : offset + size]


def _base_event(record: dict, hci_handle: int | None = None, handle: int | None = None) -> dict:
    timestamp = record["timestamp"]
    return {
        "kind": "hci",
        "opcode": None,
        "handle": handle,
        "att_handle": None,
        "value_hex": "",
        "timestamp": timestamp,
        "hci_handle": hci_handle,
        "wall_ms": (timestamp - BTSNOOP_EPOCH_OFFSET_US) // 1_000,
        "flags": record["flags"],
        "direction": record["direction"],
        "original_length": record["original_length"],
        "included_length": record["included_length"],
    }


def _hci_event(record: dict, packet: bytes) -> dict:
    event = _base_event(record)
    event["hci_type"] = packet[0] if packet else None
    if len(packet) >= 2:
        event["event_code"] = packet[1]
    if len(packet) >= 3:
        event["parameter_length"] = packet[2]
    return event


def _group_attributes(body: bytes) -> list[dict]:
    if not body or body[0] < 4:
        return []
    attributes = []
    for entry in _chunks(body[1:], body[0]):
        start_handle, end_handle = struct.unpack_from("<HH", entry)
        attributes.append({
            "start_handle": start_handle,
            "end_handle": end_handle,
            "uuid": _uuid_from_tail(entry[4:]),
        })
    return attributes


def _type_attributes(body: bytes) -> list[dict]:
    if not body or body[0] < 2:
        return []
    attributes = []
    for entry in _chunks(body[1:], body[0]):
        handle = struct.unpack_from("<H", entry)[0]
        value = entry[2:]
        attribute = {"handle": handle}
        if len(value) in (5, 19):
            attribute["properties"] = value[0]
            attribute["value_handle"] = struct.unpack_from("<H", value, 1)[0]
            attribute["uuid"] = _uuid_text(value[3:])
        else:
            attribute["uuid"] = _uuid_from_tail(value)
        attributes.append(attribute)
    return attributes


def _find_info_attributes(body: bytes) -> tuple[int | None, list[dict]]:
    if not body:
        return None, []
    fmt = body[0]
    uuid_size = {0x01: 2, 0x02: 16}.get(fmt)
    if uuid_size is None:
        return fmt, []
    attributes = []
    for entry in _chunks(body[1:], 2 + uuid_size):
        handle = struct.unpack_from("<H", entry)[0]
        attributes.append({"handle": handle, "uuid": _uuid_text(entry[2:])})
    return fmt, attributes


def _set_discovery_fields(fields: dict, attributes: list[dict], handle_key: str, uuids: list[str]) -> None:
    fields["attributes"] = attributes
    fields["uuids"] = uuids
    fields["start_handle"] = attributes[0][handle_key] if attributes else None
    fields["end_handle"] = attributes[-1][handle_key] if attributes else None
    fields["att_handle"] = fields["start_handle"]


def _att_fields(pdu: bytes) -> dict:
    opcode = pdu[0]
    body = pdu[1:]
    fields = {
        "kind": ATT_KINDS.get(opcode, f"att_0x{opcode:02x}"),
        "opcode": opcode,
        "att_handle": None,
        "value_hex": body.hex(),
    }
    if opcode == 0x01:
        fields["request_opcode"] = body[0] if body else None
        fields["error_handle"] = struct.unpack_from("<H", body, 1)[0] if len(body) >= 3 else None
        fields["error_code"] = body[3] if len(body) >= 4 else None
        fields["att_handle"] = fields["error_handle"]
        return fields
    if opcode == 0x11:
        attributes = _group_attributes(body)
        uuids = [attribute["uuid"] for attribute in attributes if attribute["uuid"] is not None]
        _set_discovery_fields(fields, attributes, "start_handle", uuids)
        fields["end_handle"] = attributes[-1]["end_handle"] if attributes else None
        return fields
    if opcode == 0x09:
        attributes = _type_attributes(body)
        uuids = [attribute["uuid"] for attribute in attributes if attribute["uuid"] is not None]
        _set_discovery_fields(fields, attributes, "handle", uuids)
        return fields
    if opcode == 0x05:
        fmt, attributes = _find_info_attributes(body)
        fields["format"] = fmt
        uuids = [attribute["uuid"] for attribute in attributes if attribute["uuid"] is not None]
        _set_discovery_fields(fields, attributes, "handle", uuids)
        return fields
    if opcode == 0x07:
        attributes = []
        for entry in _chunks(body, 4):
            start_handle, end_handle = struct.unpack_from("<HH", entry)
            attributes.append({"start_handle": start_handle, "end_handle": end_handle})
        fields["attributes"] = attributes
        fields["start_handle"] = attributes[0]["start_handle"] if attributes else None
        fields["end_handle"] = attributes[-1]["end_handle"] if attributes else None
        fields["att_handle"] = fields["start_handle"]
        return fields
    if opcode in HANDLE_PREFIX_OPCODES and len(body) >= 2:
        fields["att_handle"] = struct.unpack_from("<H", body)[0]
        fields["value_hex"] = body[2:].hex()
        return fields
    if opcode in (0x02, 0x03) and len(body) >= 2:
        fields["mtu"] = struct.unpack_from("<H", body)[0]
    if opcode in START_END_REQUEST_OPCODES and len(body) >= 4:
        start_handle, end_handle = struct.unpack_from("<HH", body)
        fields["start_handle"] = start_handle
        fields["end_handle"] = end_handle
        fields["att_handle"] = start_handle
        if opcode in UUID_REQUEST_OPCODES:
            uuid = _uuid_from_tail(body[4:])
            if uuid is not None:
                fields["uuid"] = uuid
                fields["uuids"] = [uuid]
        elif opcode == 0x06 and len(body) >= 6:
            uuid = _uuid_text(body[4:6])
            if uuid is not None:
                fields["uuid"] = uuid
                fields["uuids"] = [uuid]
    return fields


def _collect_record(record: dict) -> list[dict]:
    packet = record["packet"]
    if not packet or packet[0] != HCI_ACL or len(packet) < 5:
        return [_hci_event(record, packet)]
    raw_handle, acl_length = struct.unpack_from("<HH", packet, 1)
    base = _base_event(record, hci_handle=raw_handle, handle=raw_handle & 0x0FFF)
    l2cap = packet[5 : 5 + acl_length]
    # Android snoop logs use PB=2 in 0x200d for a complete/starting L2CAP PDU; PB=1 alone is continuation.
    if ((raw_handle >> 12) & 0x3) == 1:
        fragment = base.copy()
        fragment.update({"kind": "acl_fragment", "cid": None, "value_hex": l2cap.hex()})
        return [fragment]
    events = []
    offset = 0
    while offset + 4 <= len(l2cap):
        pdu_length, cid = struct.unpack_from("<HH", l2cap, offset)
        offset += 4
        payload = l2cap[offset : offset + pdu_length]
        truncated = len(payload) < pdu_length
        offset += len(payload)
        event = base.copy()
        event["cid"] = cid
        if truncated:
            event.update({
                "kind": "l2cap_fragment",
                "opcode": None,
                "att_handle": None,
                "value_hex": payload.hex(),
                "truncated": True,
            })
        elif cid == ATT_CID and payload:
            event.update(_att_fields(payload))
        else:
            event.update({
                "kind": "l2cap",
                "opcode": None,
                "att_handle": None,
                "value_hex": payload.hex(),
            })
        events.append(event)
        if truncated:
            break
    if not events:
        fragment = base.copy()
        fragment.update({"kind": "acl_fragment", "cid": None, "value_hex": l2cap.hex()})
        events.append(fragment)
    return events


def decode(data: bytes, since_ts: int = 0, hci_handle: int | None = None) -> dict:
    events = []
    for record in iter_packets(data):
        if record["timestamp"] <= since_ts:
            continue
        for event in _collect_record(record):
            if hci_handle is None or event["hci_handle"] == hci_handle:
                events.append(event)
    events.sort(key=lambda event: event["timestamp"])
    return {
        "size": len(data),
        "since_ts": since_ts,
        "hci_handle": hci_handle,
        "event_count": len(events),
        "events": events,
    }


def decode_files(paths, since_ts: int = 0, hci_handle: int | None = None) -> dict:
    events = []
    names = []
    total_size = 0
    for raw_path in paths:
        path = Path(raw_path)
        data = path.read_bytes()
        result = decode(data, since_ts, hci_handle)
        total_size += result["size"]
        names.append(path.name)
        events.extend(result["events"])
    events.sort(key=lambda event: event["timestamp"])
    return {
        "files": names,
        "size": total_size,
        "since_ts": since_ts,
        "hci_handle": hci_handle,
        "event_count": len(events),
        "events": events,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logs", nargs="+", type=Path, help="one or more btsnoop HCI log files")
    parser.add_argument("--since-ts", type=int, default=0, help="drop records at or before this HCI timestamp")
    parser.add_argument("--hci-handle", type=_auto_int, help="keep only this raw HCI ACL handle, e.g. 0x200d")
    parser.add_argument("--json", type=Path, help="write the JSON result here")
    args = parser.parse_args()
    result = decode_files(args.logs, args.since_ts, args.hci_handle)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{args.json}: {result['event_count']} events")
    else:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
