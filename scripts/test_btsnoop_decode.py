#!/usr/bin/env python3
import struct
import unittest
from pathlib import Path

import btsnoop_decode as m

RECORD = struct.Struct(">IIIIQ")
BASE_TS = 63961829306664464


def acl_packet(att_pdu: bytes) -> bytes:
    l2cap = struct.pack("<HH", len(att_pdu), 4) + att_pdu
    return b"\x02" + struct.pack("<HH", 0x0041, len(l2cap)) + l2cap


def snoop(packets: list[bytes], start_ts: int = BASE_TS) -> bytes:
    out = bytearray(m.BTSNOOP_MAGIC + struct.pack(">II", 1, 1002))
    for index, packet in enumerate(packets):
        out += RECORD.pack(len(packet), len(packet), 0, 0, start_ts + index)
        out += packet
    return bytes(out)


def write_value(value: bytes, handle: int = m.COMMAND_HANDLE) -> bytes:
    return acl_packet(b"\x12" + struct.pack("<H", handle) + value)


def indication(value: bytes) -> bytes:
    return acl_packet(b"\x1d" + struct.pack("<H", m.NOTIFY_HANDLE) + value)


def command(cmd: int) -> bytes:
    return bytes([0xED, 0x11, 0x8B]) + bytes(7) + bytes(120) + bytes([cmd])


class DecodeTest(unittest.TestCase):
    def test_command_write_and_control_indication(self):
        ack = bytes.fromhex("007001000000c8000000")
        result = m.decode_from_bytes(snoop([write_value(command(0x01)), indication(ack)]))
        self.assertEqual(result["write_count"], 1)
        self.assertEqual(result["command_count"], 1)
        self.assertEqual(result["command_cmds"], ["0x01"])
        self.assertEqual(result["events"][0]["channel"], "0xed")
        self.assertEqual(result["events"][1]["records"], [{"msg_id": "0x0070", "result": 200}])

    def test_wall_ms_converts_microsecond_timestamp(self):
        result = m.decode_from_bytes(snoop([write_value(command(0x01))]))
        self.assertEqual(
            result["events"][0]["wall_ms"],
            (BASE_TS - m.BTSNOOP_EPOCH_OFFSET_US) // 1_000,
        )

    def test_defective_command_handle_loses_commands(self):
        original = m.COMMAND_HANDLE
        m.COMMAND_HANDLE = 0x000D
        try:
            result = m.decode_from_bytes(snoop([write_value(command(0x01))]))
        finally:
            m.COMMAND_HANDLE = original
        self.assertEqual(result["command_count"], 0)


class WindowTest(unittest.TestCase):
    def test_since_timestamp_excludes_prior_commands(self):
        old = snoop([write_value(command(0x01))], BASE_TS)
        new = snoop([write_value(command(0x26))], BASE_TS + 10)
        joined = old + new[16:]
        result = m.decode_from_bytes(joined, m.last_record_ts(old))
        self.assertEqual(result["command_cmds"], ["0x26"])

    def test_rotated_log_combines_previous_tail_and_current(self):
        before = snoop([write_value(command(0x01))], BASE_TS)
        previous = snoop([write_value(command(0x26))], BASE_TS + 10)
        current = snoop([write_value(command(0x02))], BASE_TS + 20)
        result = m.decode_with_bytes(current, previous, m.last_record_ts(before))
        self.assertEqual(result["command_cmds"], ["0x26", "0x02"])


class HistoricalLogTest(unittest.TestCase):
    def test_known_capture(self):
        path = Path("/Volumes/LogicExt/Git/XPeng/work/ble_capture/br2/FS/data/misc/bluetooth/logs/btsnoop_hci_261101_224622.log")
        if not path.exists():
            self.skipTest("historical capture not present")
        result = m.decode([path])
        self.assertEqual(result["write_count"], 14)
        self.assertEqual(result["command_count"], 5)
        self.assertEqual(result["command_cmds"], ["0x04", "0x04", "0x26", "0x0c", "0x0d"])


if __name__ == "__main__":
    unittest.main()
