"""Offline contract tests for the strict, public-fixture-only fake car."""

import hashlib
import hmac
import unittest
import zlib

from strict_protocol import ProtocolError, StrictTestProtocol, TEST_CAR_NONCE, TEST_MAC


APP_NONCE = bytes.fromhex("01020304")
CIPHER = bytes.fromhex("00112233445566778899aabbccddeeff")
COMMAND_RAW = (b"XPBKTH" + bytes.fromhex("01000054010203041234")
               + b"KI\x00\x10" + bytes(16)
               + b"ED\x00\x10" + b"\x11" * 16
               + b"SN\x00\x47" + b"\x22" * 71)


def auth_frame(app_nonce=APP_NONCE):
    # The public MAC's incremented seed is fixed independently of the core.
    key = hashlib.md5(bytes.fromhex("714896ca")).digest()
    return b"\xef\x01\x10" + hmac.new(key, app_nonce + TEST_CAR_NONCE, hashlib.md5).digest()


def tbox(payload=CIPHER + b"\xe0", frame_type=0):
    # zlib uses different initial/final XORs; adapt it as an independent oracle.
    crc = zlib.crc32(payload, 0xffffffff) ^ 0xffffffff
    body = len(payload).to_bytes(2, "big") + crc.to_bytes(4, "big") + bytes([frame_type]) + payload
    return b"\xed\x11" + bytes([len(body)]) + body


COMMAND = tbox(COMMAND_RAW + b"\x02", 2)


class StrictTestProtocolTests(unittest.TestCase):
    def setUp(self):
        self.protocol = StrictTestProtocol(expected_auth_cipher=CIPHER, expected_commands={COMMAND: 2})

    def nonce(self, app_nonce=APP_NONCE):
        return self.protocol.handle(b"\xef\x01\x04" + app_nonce)

    def auth(self):
        self.nonce()
        return self.protocol.handle(auth_frame())

    def authenticate(self):
        self.auth()
        return self.protocol.handle(tbox())

    def test_public_fixture_identity_and_full_handshake(self):
        self.assertEqual(TEST_MAC, "00:60:37:85:B9:D0")
        self.assertEqual(TEST_CAR_NONCE.hex(), "ffdba7e0")
        self.assertEqual(self.nonce(), TEST_CAR_NONCE)
        self.assertEqual(self.protocol.app_nonce, APP_NONCE)
        self.assertEqual(self.protocol.car_nonce, TEST_CAR_NONCE)
        self.assertEqual(self.protocol.phase, "awaiting_auth")
        self.assertEqual(self.protocol.handle(auth_frame()), bytes.fromhex("08000144463030482e32"))
        self.assertEqual(self.protocol.phase, "awaiting_cipher")
        self.assertEqual(self.protocol.handle(tbox()), bytes.fromhex("02810000000000000000"))
        self.assertEqual(self.protocol.phase, "authenticated")
        self.assertEqual(self.protocol.handle(COMMAND), bytes.fromhex("007002000000c8000000"))

    def test_auth_uses_current_app_nonce(self):
        other = bytes.fromhex("aabbccdd")
        self.nonce(other)
        with self.assertRaises(ProtocolError):
            self.protocol.handle(auth_frame())
        self.assertEqual(self.protocol.phase, "awaiting_auth")
        self.assertEqual(self.protocol.handle(auth_frame(other))[:3], b"\x08\x00\x01")

    def test_rejects_arbitrary_auth_and_malformed_nonce(self):
        for frame in (b"", b"\xef\x01\x04", b"\xef\x01\x04" + APP_NONCE + b"\x00"):
            with self.subTest(frame=frame.hex()), self.assertRaises(ProtocolError):
                self.protocol.handle(frame)
        self.assertEqual(self.protocol.phase, "awaiting_nonce")
        self.nonce()
        for frame in (b"\xef\x01\x10", b"\xef\x01\x10" + bytes(16), auth_frame() + b"\x00"):
            with self.subTest(frame=frame.hex()), self.assertRaises(ProtocolError):
                self.protocol.handle(frame)
        self.assertEqual(self.protocol.phase, "awaiting_auth")

    def test_command_and_cipher_require_completed_prior_steps(self):
        for stage in ("initial", "nonce", "auth"):
            with self.subTest(stage=stage), self.assertRaises(ProtocolError):
                self.protocol.handle(COMMAND)
            if stage == "initial":
                with self.assertRaises(ProtocolError):
                    self.protocol.handle(auth_frame())
                with self.assertRaises(ProtocolError):
                    self.protocol.handle(tbox())
                self.nonce()
            elif stage == "nonce":
                with self.assertRaises(ProtocolError):
                    self.protocol.handle(tbox())
                self.protocol.handle(auth_frame())

    def test_rejects_bad_tbox_lengths_crc_type_cipher_and_terminator(self):
        self.auth()
        good = tbox()
        bad_chunk = good[:2] + bytes([good[2] - 1]) + good[3:]
        bad_length = good[:3] + b"\x00\x10" + good[5:]
        bad_crc = good[:5] + bytes([good[5] ^ 1]) + good[6:]
        standard_crc = good[:5] + zlib.crc32(CIPHER + b"\xe0").to_bytes(4, "big") + good[9:]
        for frame in (good[:9], good[:-1], good + b"\x00", bad_chunk, bad_length, bad_crc,
                      standard_crc, tbox(frame_type=1), tbox(CIPHER), tbox(CIPHER + b"\xe1"),
                      tbox(bytes(16) + b"\xe0"), b"\xec" + good[1:], good[:1] + b"\x12" + good[2:]):
            with self.subTest(frame=frame.hex()), self.assertRaises(ProtocolError):
                self.protocol.handle(frame)
            self.assertEqual(self.protocol.phase, "awaiting_cipher")
        self.protocol.handle(good)

    def test_only_exact_injected_commands_are_accepted(self):
        self.authenticate()
        for frame in (COMMAND[:-1], COMMAND + b"\x00", COMMAND[:-1] + b"\x01", b"unknown"):
            with self.subTest(frame=frame.hex()), self.assertRaises(ProtocolError):
                self.protocol.handle(frame)
        self.assertEqual(len(self.protocol.handle(COMMAND)), 10)

    def test_reset_clears_connection_state_and_prevents_replay(self):
        self.authenticate()
        self.protocol.reset()
        self.assertEqual(self.protocol.phase, "awaiting_nonce")
        self.assertIsNone(self.protocol.app_nonce)
        self.assertIsNone(self.protocol.car_nonce)
        for frame in (auth_frame(), tbox(), COMMAND):
            with self.subTest(frame=frame.hex()), self.assertRaises(ProtocolError):
                self.protocol.handle(frame)
        self.assertEqual(self.nonce(), TEST_CAR_NONCE)

    def test_handshake_cannot_restart_without_connection_reset(self):
        self.authenticate()
        for frame in (b"\xef\x01\x04" + APP_NONCE, auth_frame(), tbox()):
            with self.subTest(frame=frame.hex()), self.assertRaises(ProtocolError):
                self.protocol.handle(frame)

    def test_multiple_commands_have_explicit_ack_codes(self):
        second = tbox(COMMAND_RAW + b"\x26", 0x26)
        self.protocol = StrictTestProtocol(expected_auth_cipher=CIPHER,
                                           expected_commands={COMMAND: 2, second: 0x26})
        self.authenticate()
        self.assertEqual(self.protocol.handle(second), bytes.fromhex("007026000000c8000000"))

    def test_even_whitelisted_commands_require_valid_structure(self):
        bad_crc = COMMAND[:5] + bytes([COMMAND[5] ^ 1]) + COMMAND[6:]
        missing_ki = COMMAND_RAW[:16] + COMMAND_RAW[36:]
        missing_ed = COMMAND_RAW[:36] + COMMAND_RAW[56:]
        missing_sn = COMMAND_RAW[:56]
        short_ki = COMMAND_RAW[:16] + b"KI\x00\x0f" + bytes(15) + COMMAND_RAW[36:]
        short_ed = COMMAND_RAW[:36] + b"ED\x00\x0f" + b"\x11" * 15 + COMMAND_RAW[56:]
        malformed_raw = (
            missing_ki, missing_ed, missing_sn, short_ki, short_ed,
            b"YPBKTH" + COMMAND_RAW[6:], COMMAND_RAW[:15],
            COMMAND_RAW + b"X", COMMAND_RAW[:-1],
            COMMAND_RAW[:56] + b"SN\x00\x48" + b"\x22" * 71,
            COMMAND_RAW + b"KI\x00\x10" + bytes(16),
        )
        bad_frames = [bad_crc, COMMAND[:2] + b"\x00" + COMMAND[3:],
                      COMMAND[:3] + b"\x00\x01" + COMMAND[5:],
                      b"\xec" + COMMAND[1:], COMMAND[:1] + b"\x12" + COMMAND[2:],
                      tbox(COMMAND_RAW + b"\x02", 1)]
        bad_frames.extend(tbox(raw + b"\x02", 2) for raw in malformed_raw)
        for frame in bad_frames:
            with self.subTest(frame=frame.hex()):
                self.protocol = StrictTestProtocol(expected_auth_cipher=CIPHER,
                                                   expected_commands={frame: 2})
                self.authenticate()
                with self.assertRaises(ProtocolError):
                    self.protocol.handle(frame)
                self.assertEqual(self.protocol.phase, "authenticated")

    def test_whitelist_ack_code_must_match_command_payload(self):
        self.protocol = StrictTestProtocol(expected_auth_cipher=CIPHER,
                                           expected_commands={COMMAND: 1})
        self.authenticate()
        with self.assertRaises(ProtocolError):
            self.protocol.handle(COMMAND)

    def test_synthetic_command_fixture_has_server_sequence_and_142_bytes(self):
        self.assertEqual(len(COMMAND), 142)
        self.assertEqual(COMMAND[24:26], bytes.fromhex("1234"))


if __name__ == "__main__":
    unittest.main()
