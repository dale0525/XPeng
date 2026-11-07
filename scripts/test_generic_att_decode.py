#!/usr/bin/env python3
from __future__ import annotations

import json
import struct
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generic_att_decode as m

RECORD = struct.Struct(">IIIIQ")
BASE_TS = 63962238613442330
PILE_HANDLE = 0x200D
OTHER_HANDLE = 0x200E
SCRIPT = Path(__file__).resolve().with_name("generic_att_decode.py")
CHAR_UUID = "8ac32d3f-5cb9-4d44-bec2-ee689169f626"
SERVICE_UUID = "1b7e8251-2877-41c3-b46e-cf057c562023"
SERVICE_UUID_WIRE = "2320567c05cf6eb4c341772851827e1b"
FAKE_ADDR = "94:70:6C:44:E3:3F"
FAKE_ADDR_HEX = "94706c44e33f"


def acl_packet(payload: bytes, cid: int = 0x0004, hci_handle: int = PILE_HANDLE) -> bytes:
    l2cap = struct.pack("<HH", len(payload), cid) + payload
    return b"\x02" + struct.pack("<HH", hci_handle, len(l2cap)) + l2cap


def hci_event_packet() -> bytes:
    addr = bytes.fromhex(FAKE_ADDR_HEX)
    return b"\x04\x3e" + bytes([len(addr) + 2]) + b"\x00" + addr + b"\x00\x00"


def snoop(packets: list[bytes], start_ts: int = BASE_TS) -> bytes:
    out = bytearray(b"btsnoop\x00" + struct.pack(">II", 1, 1002))
    for index, packet in enumerate(packets):
        out += RECORD.pack(len(packet), len(packet), 0, 0, start_ts + index)
        out += packet
    return bytes(out)


def att(opcode: int, body: bytes) -> bytes:
    return bytes([opcode]) + body


def write_pdu(value: bytes, handle: int = 0x0006) -> bytes:
    return att(0x12, struct.pack("<H", handle) + value)


def notify_pdu(value: bytes, handle: int = 0x0003) -> bytes:
    return att(0x1B, struct.pack("<H", handle) + value)


def group_rsp_16() -> bytes:
    return att(0x11, bytes([0x06]) + struct.pack("<HH", 0x0001, 0x0005) + struct.pack("<H", 0x1800))


def group_rsp_128() -> bytes:
    entry = struct.pack("<HH", 0x0001, 0xFFFF) + bytes.fromhex(SERVICE_UUID_WIRE)
    return att(0x11, bytes([len(entry)]) + entry)


def type_rsp_128() -> bytes:
    value = bytes([0x12]) + struct.pack("<H", 0x0003) + uuid.UUID(CHAR_UUID).bytes[::-1]
    entry = struct.pack("<H", 0x0002) + value
    return att(0x09, bytes([len(entry)]) + entry)


def find_info_16() -> bytes:
    return att(0x05, bytes([0x01]) + struct.pack("<H", 0x0004) + struct.pack("<H", 0x2902))


def find_info_128() -> bytes:
    return att(0x05, bytes([0x02]) + struct.pack("<H", 0x0007) + bytes.fromhex(SERVICE_UUID_WIRE))


def error_rsp() -> bytes:
    return att(0x01, bytes([0x0A]) + struct.pack("<H", 0x0004) + bytes([0x0A]))


def events(data: bytes, **kwargs) -> list[dict]:
    return m.decode(data, **kwargs)["events"]


class DecoderTest(unittest.TestCase):
    def test_write_and_notification_frames(self):
        value = bytes.fromhex("6829ff8b38ebf07e01ee6a6393")
        notification = bytes.fromhex("692922a756036c7e01ee6a96ea")
        result = events(snoop([acl_packet(write_pdu(value)), acl_packet(notify_pdu(notification))]))
        self.assertEqual(len(result), 2)
        write, notify = result
        self.assertEqual(write["kind"], "write")
        self.assertEqual(write["opcode"], 0x12)
        self.assertEqual(write["handle"], 0x000D)
        self.assertEqual(write["hci_handle"], PILE_HANDLE)
        self.assertEqual(write["att_handle"], 0x0006)
        self.assertEqual(write["value_hex"], value.hex())
        self.assertEqual(notify["kind"], "notification")
        self.assertEqual(notify["opcode"], 0x1B)
        self.assertEqual(notify["att_handle"], 0x0003)
        self.assertEqual(notify["value_hex"], notification.hex())

    def test_read_by_group_type_rsp_16bit_uuid(self):
        event = events(snoop([acl_packet(group_rsp_16())]))[0]
        self.assertEqual(event["kind"], "read_by_group_type_rsp")
        self.assertEqual(event["opcode"], 0x11)
        self.assertEqual(event["uuids"], ["1800"])
        self.assertEqual(event["start_handle"], 0x0001)
        self.assertEqual(event["end_handle"], 0x0005)
        self.assertEqual(
            event["attributes"],
            [{"start_handle": 0x0001, "end_handle": 0x0005, "uuid": "1800"}],
        )

    def test_read_by_group_type_rsp_128bit_uuid(self):
        event = events(snoop([acl_packet(group_rsp_128())]))[0]
        self.assertEqual(event["kind"], "read_by_group_type_rsp")
        self.assertEqual(event["uuids"], [SERVICE_UUID])
        self.assertEqual(event["attributes"], [{
            "start_handle": 0x0001,
            "end_handle": 0xFFFF,
            "uuid": SERVICE_UUID,
        }])

    def test_read_by_type_rsp_128bit_uuid(self):
        event = events(snoop([acl_packet(type_rsp_128())]))[0]
        self.assertEqual(event["kind"], "read_by_type_rsp")
        self.assertEqual(event["opcode"], 0x09)
        self.assertEqual(event["uuids"], [CHAR_UUID])
        attr = event["attributes"][0]
        self.assertEqual(attr["handle"], 0x0002)
        self.assertEqual(attr["value_handle"], 0x0003)
        self.assertEqual(attr["properties"], 0x12)
        self.assertEqual(attr["uuid"], CHAR_UUID)

    def test_find_info_rsp_16bit_and_128bit_uuids(self):
        result = events(snoop([acl_packet(find_info_16()), acl_packet(find_info_128())]))
        self.assertEqual(result[0]["kind"], "find_info_rsp")
        self.assertEqual(result[0]["format"], 0x01)
        self.assertEqual(result[0]["uuids"], ["2902"])
        self.assertEqual(result[0]["attributes"], [{"handle": 0x0004, "uuid": "2902"}])
        self.assertEqual(result[1]["format"], 0x02)
        self.assertEqual(result[1]["uuids"], [SERVICE_UUID])
        self.assertEqual(result[1]["attributes"], [{"handle": 0x0007, "uuid": SERVICE_UUID}])

    def test_error_rsp_fields(self):
        event = events(snoop([acl_packet(error_rsp())]))[0]
        self.assertEqual(event["kind"], "error_rsp")
        self.assertEqual(event["opcode"], 0x01)
        self.assertEqual(event["request_opcode"], 0x0A)
        self.assertEqual(event["error_handle"], 0x0004)
        self.assertEqual(event["error_code"], 0x0A)
        self.assertEqual(event["att_handle"], 0x0004)

    def test_read_rsp_opcode_0x0b_is_not_group_discovery(self):
        event = events(snoop([acl_packet(att(0x0B, b"\xde\xad\xbe\xef"))]))[0]
        self.assertEqual(event["kind"], "read_rsp")
        self.assertEqual(event["opcode"], 0x0B)
        self.assertEqual(event["value_hex"], "deadbeef")
        self.assertNotIn("uuids", event)
        self.assertNotIn("attributes", event)

    def test_since_ts_filter(self):
        data = snoop([acl_packet(write_pdu(b"\x01")), acl_packet(write_pdu(b"\x02"))], BASE_TS)
        result = events(data, since_ts=BASE_TS)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["timestamp"], BASE_TS + 1)

    def test_hci_handle_filter_and_cli_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            file1 = tmp / "btsnoop_hci.log"
            file2 = tmp / "btsnoop_hci.log.last"
            file1.write_bytes(
                snoop(
                    [
                        acl_packet(write_pdu(b"\x01")),
                        hci_event_packet(),
                        acl_packet(b"\x02\x00\x02\x00\xf7\x00", cid=0x0001),
                    ],
                    BASE_TS + 1,
                )
            )
            file2.write_bytes(
                snoop(
                    [
                        acl_packet(write_pdu(b"\x02"), hci_handle=OTHER_HANDLE),
                        acl_packet(write_pdu(b"\x03")),
                    ],
                    BASE_TS + 4,
                )
            )
            out = tmp / "decoded.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--since-ts",
                    str(BASE_TS),
                    "--hci-handle",
                    "0x200d",
                    "--json",
                    str(out),
                    str(file1),
                    str(file2),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0)
            text = out.read_text(encoding="utf-8")
            result = json.loads(text)
            self.assertEqual(result["files"], [file1.name, file2.name])
            self.assertEqual(result["event_count"], 3)
            self.assertTrue(all(e["hci_handle"] == PILE_HANDLE for e in result["events"]))
            self.assertTrue(all(e["timestamp"] > BASE_TS for e in result["events"]))
            timestamps = [e["timestamp"] for e in result["events"]]
            self.assertEqual(timestamps, sorted(timestamps))
            self.assertNotIn(FAKE_ADDR, text)
            self.assertNotIn(FAKE_ADDR_HEX, text)

    def test_non_att_cid_preserved(self):
        payload = b"\x02\x00\x02\x00\xf7\x00"
        event = events(snoop([acl_packet(payload, cid=0x0001)]))[0]
        self.assertEqual(event["kind"], "l2cap")
        self.assertEqual(event["cid"], 0x0001)
        self.assertIsNone(event["opcode"])
        self.assertIsNone(event["att_handle"])
        self.assertEqual(event["value_hex"], payload.hex())

    def test_iter_packets_preserves_all_records(self):
        data = snoop([acl_packet(write_pdu(b"\x01")), hci_event_packet()])
        records = list(m.iter_packets(data))
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["packet"][0], 0x02)
        self.assertEqual(records[1]["packet"][0], 0x04)
        self.assertIn(bytes.fromhex(FAKE_ADDR_HEX), records[1]["packet"])
        result = m.decode(data)
        self.assertEqual(result["event_count"], 2)
        self.assertEqual(result["events"][1]["kind"], "hci")
        self.assertEqual(result["events"][1]["value_hex"], "")


if __name__ == "__main__":
    unittest.main()
