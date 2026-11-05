"""Pure Python protocol core for --strict-test with public fixtures only.

This validates createAuthKey independently, but deliberately does not derive a
real session key: the third-handshake cipher and all commands must be injected.
The wrapper must call reset() for every connection and notify handle() replies.
"""

import hashlib
import hmac
from collections.abc import Mapping


TEST_MAC = "00:60:37:85:B9:D0"
TEST_CAR_NONCE = bytes.fromhex("ffdba7e0")
AUTH_OK = bytes.fromhex("08000144463030482e32")
CIPHER_OK = bytes.fromhex("02810000000000000000")


class ProtocolError(ValueError):
    """An incoming frame violates the strict test protocol."""


def _crc32_init0(data: bytes) -> int:
    crc = 0
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ (0xedb88320 if crc & 1 else 0)
    return crc


def _parse_tbox(frame: bytes) -> tuple[int, bytes]:
    if len(frame) < 10 or frame[:2] != b"\xed\x11":
        raise ProtocolError("expected an ed11 TBox frame")
    payload = frame[10:]
    if frame[2] != len(frame) - 3:
        raise ProtocolError("TBox chunk length mismatch")
    if int.from_bytes(frame[3:5], "big") != len(payload):
        raise ProtocolError("TBox payload length mismatch")
    if int.from_bytes(frame[5:9], "big") != _crc32_init0(payload):
        raise ProtocolError("TBox CRC mismatch (requires init=0, no final xor)")
    return frame[9], payload


def _parse_command(frame: bytes) -> int:
    frame_type, payload = _parse_tbox(frame)
    # Six magic bytes plus version/flag/random/sequence occupy sixteen bytes.
    if len(payload) < 17 or payload[:6] != b"XPBKTH":
        raise ProtocolError("expected XPBKTH command with a complete sequence header")
    command = payload[-1]
    if frame_type != command:
        raise ProtocolError("TBox type must match the final command byte")
    end = len(payload) - 1
    offset = 16
    fields = {}
    while offset < end:
        if offset + 4 > end:
            raise ProtocolError("incomplete command TLV header")
        tag = payload[offset:offset + 2]
        length = int.from_bytes(payload[offset + 2:offset + 4], "big")
        offset += 4
        if tag not in (b"KI", b"ED", b"SN") or tag in fields:
            raise ProtocolError("unknown or duplicate command TLV")
        if offset + length > end:
            raise ProtocolError("command TLV exceeds payload")
        fields[tag] = payload[offset:offset + length]
        offset += length
    if any(tag not in fields for tag in (b"KI", b"ED", b"SN")):
        raise ProtocolError("command requires KI, ED and SN TLVs")
    if len(fields[b"KI"]) != 16 or len(fields[b"ED"]) != 16 or not fields[b"SN"]:
        raise ProtocolError("command requires KI16, ED16 and a nonempty SN")
    return command


class StrictTestProtocol:
    """One connection's state machine; injected fixtures are never decrypted."""

    def __init__(self, *, expected_auth_cipher: bytes, expected_commands: Mapping[bytes, int]):
        if len(expected_auth_cipher) != 16:
            raise ProtocolError("strict test auth cipher must be sixteen bytes")
        self.expected_auth_cipher = bytes(expected_auth_cipher)
        self.expected_commands = dict(expected_commands)
        if any(not frame or not 0 <= command <= 255
               for frame, command in self.expected_commands.items()):
            raise ProtocolError("expected commands require nonempty bytes and one-byte codes")
        self.reset()

    def reset(self) -> None:
        self.phase = "awaiting_nonce"
        self.app_nonce = None
        self.car_nonce = None

    def handle(self, frame: bytes) -> bytes | None:
        if self.phase == "awaiting_nonce":
            if len(frame) != 7 or frame[:3] != b"\xef\x01\x04":
                raise ProtocolError("expected ef0104 followed by a four-byte app nonce")
            self.app_nonce = frame[3:]
            self.car_nonce = TEST_CAR_NONCE
            self.phase = "awaiting_auth"
            return self.car_nonce

        if self.phase == "awaiting_auth":
            if len(frame) != 19 or frame[:3] != b"\xef\x01\x10":
                raise ProtocolError("expected ef0110 followed by sixteen auth bytes")
            source = TEST_MAC.replace(":", "")[-10:][:8]
            seed = bytes.fromhex("".join(format((int(nibble, 16) + 1) & 15, "x")
                                         for nibble in source))
            key = hashlib.md5(seed).digest()
            expected = hmac.new(key, self.app_nonce + self.car_nonce, hashlib.md5).digest()
            if not hmac.compare_digest(frame[3:], expected):
                raise ProtocolError("createAuthKey verification failed")
            self.phase = "awaiting_cipher"
            return AUTH_OK

        if self.phase == "awaiting_cipher":
            frame_type, payload = _parse_tbox(frame)
            if frame_type != 0 or len(payload) != 17 or payload[-1] != 0xe0:
                raise ProtocolError("expected type00 and cipher16 followed by e0")
            if not hmac.compare_digest(payload[:16], self.expected_auth_cipher):
                raise ProtocolError("auth cipher does not match the public test fixture")
            self.phase = "authenticated"
            return CIPHER_OK

        command = _parse_command(frame)
        if frame not in self.expected_commands:
            raise ProtocolError("command does not match an explicitly injected test fixture")
        if self.expected_commands[frame] != command:
            raise ProtocolError("injected ACK command must match the command payload")
        return b"\x00\x70" + bytes([command]) + b"\x00\x00\x00\xc8\x00\x00\x00"
