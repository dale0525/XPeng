#!/usr/bin/env python3
"""Impersonate the car's digital-key BLE peripheral inside the Android emulator.

Why this exists
---------------
The official app derives two session keys through `hkdfSha256V2` (a JNI bridge
whose Java caller sits inside the 360-hardened dex segment). Static analysis
recovered every algorithm around them but not the two arguments, and guessing
them is exhausted (teardown §6.26j).

The emulator ships a virtual BLE stack: netsimd exposes
`EmulatedBluetoothService.registerGattDevice`, and the registered profile is
presented to the guest as a real peripheral. So we can stand up a fake car, let
the app connect and run its full handshake against it, then hook
`hkdfSha256V2` on the emulator (which is rootable) to read the arguments as
they are computed.

This file is the fake car. It advertises the same name and the same service /
characteristic UUIDs as the real module (teardown §6.25b), answers the
handshake, and logs every byte so the transcript can be diffed against the
real capture.

Run:
    python scripts/fakecar/fake_car.py --grpc localhost:8554

The emulator must have been started with `-grpc <port>`.
"""

import argparse
import logging
import queue
import sys
import threading
from concurrent import futures

import grpc
from google.protobuf import empty_pb2

import emulated_bluetooth_pb2 as eb
import emulated_bluetooth_pb2_grpc as eb_grpc
import emulated_bluetooth_device_pb2 as dev
import emulated_bluetooth_device_pb2_grpc as dev_grpc
import grpc_endpoint_description_pb2 as ep

# --- The real module's identity, from a live GATT dump (teardown §6.25a/b) ---
DEVICE_NAME = "XPED-DC0D30B094C4"
# 128-bit UUID = msb(64) || lsb(64), i.e. the first and last 16 hex digits.
#   0000ED28-ABAB-406D-832D-7AD799B479F7
#     msb = 0000ED28ABAB406D   lsb = 832D7AD799B479F7
SERVICE_UUID = (0x832D7AD799B479F7, 0x0000ED28ABAB406D)  # (lsb, msb)
WRITE_UUID = (0x2801B1A015E46D6C, 0x0000ED28ABAB9C8C)
RECV_UUID = (0x2802D3DF573FF530, 0x0000ED28ABAB9C8C)

# Handshake transcript from btsnoop_hci_261101_224622.log (teardown §6.25c).
# The car answers frame 1 with a fresh 4-byte challenge and reports an auth
# result in msgId 0x0800. We mirror the shape so the app walks the same path.
# The real module returns a fresh 4-byte challenge on every ef0104.
import os as _os
FIXED_CHALLENGE = _os.environ.get("FAKECAR_CHALLENGE")
def car_challenge():
    if FIXED_CHALLENGE:
        return bytes.fromhex(FIXED_CHALLENGE)
    return _os.urandom(4)
AUTH_OK = bytes.fromhex("08000144463030482e32")   # msgId 0x0800, result 0x01, "DF00.2"

class BridgeClient:
    """Forward every frame to the real car and relay its indications back.

    The real module accepts exactly one handshake per connection and closes it
    afterwards, so this client reconnects on demand and hands the bytes through
    untouched: the app keeps doing its own crypto, the real car keeps doing its
    own verification. Nothing here needs the session key.
    """

    def __init__(self, addr):
        self.host, self.port = addr.split(":")
        self.sock = None
        self.lock = threading.Lock()
        self.buf = b""
        self.on_frame = None

    def connect(self):
        import socket
        s = socket.create_connection((self.host, int(self.port)), timeout=5)
        s.settimeout(None)
        self.sock = s
        log.info("[bridge] connected to %s:%s", self.host, self.port)
        threading.Thread(target=self._read_loop, args=(s,), daemon=True).start()
        return s

    def _read_loop(self, s):
        while True:
            try:
                chunk = s.recv(4096)
            except OSError:
                break
            if not chunk:
                break
            self.buf += chunk
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                frame = bytes.fromhex(line.decode().strip())
                log.info("[bridge] car -> app %s", frame.hex())
                if self.on_frame:
                    self.on_frame(frame)
        log.info("[bridge] car side closed")

    def send(self, frame):
        with self.lock:
            if not self.sock:
                self.connect()
            try:
                self.sock.sendall(frame.hex().encode() + b"\n")
                log.info("[bridge] app -> car %s", frame.hex())
            except OSError as e:
                log.warning("[bridge] send failed: %s", e)
                self.sock = None


log = logging.getLogger("fakecar")


def uuid_msg(pair):
    lsb, msb = pair
    return dev.Uuid(lsb=lsb, msb=msb)


class Device(dev_grpc.GattDeviceServiceServicer):
    """One emulated peripheral. Every callback is logged with raw hex."""

    def __init__(self, name, bridge=None, strict_protocol=None):
        self.strict_protocol = strict_protocol
        self.name = name
        self.identity = ""
        self.bridge = bridge
        if bridge is not None:
            bridge.on_frame = self._push
        # Subscribers waiting on OnCharacteristicObserveRequest streams.
        self.subscribers = []
        self.lock = threading.Lock()
        self.frames = 0

    def _hex(self, b):
        return b.hex() if b else ""

    def OnCharacteristicWriteRequest(self, request, context):
        data = request.data
        self.frames += 1
        log.info("<- WRITE #%d (%dB) %s", self.frames, len(data), self._hex(data))

        # Answer by frame content, not by ordinal: the app retries ef0104 on
        # its own schedule, so a counter drifts out of step with what the app
        # actually sent.
        if self.bridge is not None:
            self.bridge.send(data)
            return dev.CharacteristicValueResponse(
                status=dev.CharacteristicValueResponse.GATT_STATUS_SUCCESS,
                data=b"",
            )

        reply = None
        if self.strict_protocol is not None:
            from strict_protocol import ProtocolError
            try:
                reply = self.strict_protocol.handle(data)
            except ProtocolError as error:
                log.error("strict test rejected frame: %s", error)
                return dev.CharacteristicValueResponse(status=dev.CharacteristicValueResponse.GATT_STATUS_FAILURE, data=b"")
        elif data[:3] == b"\xef\x01\x04":
            reply = car_challenge()
        elif data[:3] == b"\xef\x01\x10":
            reply = AUTH_OK
        elif data[:3] == b"\xed\x11\x18":
            reply = None
        if reply is not None:
            log.info("-> INDICATE (%dB) %s", len(reply), self._hex(reply))
            self._push(reply)

        return dev.CharacteristicValueResponse(
            status=dev.CharacteristicValueResponse.GATT_STATUS_SUCCESS,
            data=b"",
        )

    def OnCharacteristicReadRequest(self, request, context):
        log.info("<- READ %s", self._hex(request.data))
        return dev.CharacteristicValueResponse(
            status=dev.CharacteristicValueResponse.GATT_STATUS_SUCCESS,
            data=b"",
        )

    def OnCharacteristicObserveRequest(self, request, context):
        """Long-lived stream: the app subscribes here for indications."""
        log.info("[+] app subscribed to indications")
        q = queue.Queue()
        with self.lock:
            self.subscribers.append(q)
        try:
            while context.is_active():
                try:
                    item = q.get(timeout=1.0)
                except queue.Empty:
                    continue
                yield dev.CharacteristicValueResponse(
                    status=dev.CharacteristicValueResponse.GATT_STATUS_SUCCESS,
                    data=item,
                )
        finally:
            with self.lock:
                if q in self.subscribers:
                    self.subscribers.remove(q)
            log.info("[-] app unsubscribed")

    def _push(self, payload):
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            q.put(payload)

    def OnConnectionStateChange(self, request, context):
        state = request.new_state
        # Each new connection starts a fresh handshake, so the frame counter
        # must not carry over from the previous client.
        if state == dev.ConnectionStateChange.CONNECTION_STATE_CONNECTED:
            self.frames = 0
            if self.strict_protocol is not None:
                self.strict_protocol.reset()
        who = request.from_device.address if request.from_device else "?"
        log.info("[conn] %s -> %s", who, dev.ConnectionStateChange.ConnectionState.Name(state))
        return empty_pb2.Empty()


def build_profile():
    """The exact GATT tree the real digital-key module exposes."""
    write_chr = dev.GattCharacteristic(
        uuid=uuid_msg(WRITE_UUID),
        properties=(dev.GattCharacteristic.PROPERTY_WRITE
                    | dev.GattCharacteristic.PROPERTY_WRITE_NO_RESPONSE),
        permissions=dev.GattCharacteristic.PERMISSION_WRITE,
    )
    recv_chr = dev.GattCharacteristic(
        uuid=uuid_msg(RECV_UUID),
        # The real module answers ef0104 with ATT Handle Value *Notification*
        # (op 0x1d) at handle 15, so expose NOTIFY, not INDICATE.
        properties=(dev.GattCharacteristic.PROPERTY_NOTIFY
                    | dev.GattCharacteristic.PROPERTY_INDICATE),
        # The CCCD that netsim generates for this characteristic is only
        # writable when the characteristic itself grants write.
        permissions=(dev.GattCharacteristic.PERMISSION_READ
                     | dev.GattCharacteristic.PERMISSION_WRITE),
    )
    service = dev.GattService(
        uuid=uuid_msg(SERVICE_UUID),
        service_type=dev.GattService.SERVICE_TYPE_PRIMARY,
        characteristics=[write_chr, recv_chr],
    )
    return dev.GattProfile(services=[service])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grpc", default="localhost:8554",
                    help="emulator gRPC control endpoint")
    ap.add_argument("--listen", default="localhost:50051",
                    help="address this fake-car gRPC service binds to")
    ap.add_argument("--bridge", default=None,
                    help="host:port of car_bridge; when set, every frame is "
                         "relayed to the real car instead of being answered locally")
    ap.add_argument("--strict-test", action="store_true", help="Validate public test vectors; not real vehicle key verification")
    args = ap.parse_args()
    if args.strict_test and args.bridge:
        ap.error("--strict-test cannot be combined with --bridge")

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)-5s %(message)s",
                        datefmt="%H:%M:%S")

    bridge = None
    if args.bridge:
        bridge = BridgeClient(args.bridge)
        bridge.connect()
    strict_protocol = None
    if args.strict_test:
        from strict_protocol import StrictTestProtocol
        import zlib
        raw = bytes.fromhex("5850424b5448010000540102030412344b490010" + "00" * 16 +
                            "45440010" + "11" * 16 + "534e0047" + "22" * 71)
        payload = raw + b"\x02"
        crc = zlib.crc32(payload, 0xffffffff) ^ 0xffffffff
        command = bytes.fromhex("ed118b0084") + crc.to_bytes(4, "big") + b"\x02" + payload
        strict_protocol = StrictTestProtocol(
            expected_auth_cipher=bytes.fromhex("db61b5b113d0870e6482ace4772c27e2"),
            expected_commands={command: 2},
        )
    device_name = "XPED-STRICT-TEST" if args.strict_test else DEVICE_NAME
    device = Device(device_name, bridge=bridge, strict_protocol=strict_protocol)

    # 1. Serve GattDeviceService ourselves; the emulator will call back here.
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8))
    dev_grpc.add_GattDeviceServiceServicer_to_server(device, server)
    server.add_insecure_port(args.listen)
    server.start()
    log.info("fake car listening on %s", args.listen)

    # 2. Register the peripheral with the emulator.
    channel = grpc.insecure_channel(args.grpc)
    stub = eb_grpc.EmulatedBluetoothServiceStub(channel)
    req = dev.GattDevice(
        endpoint=ep.Endpoint(target=args.listen),
        advertisement=dev.Advertisement(
            device_name=device_name,
            connection_mode=dev.Advertisement.CONNECTION_MODE_UNDIRECTED,
            discovery_mode=dev.Advertisement.DISCOVERY_MODE_GENERAL,
        ),
        profile=build_profile(),
    )
    try:
        status = stub.registerGattDevice(req, timeout=30)
        device.identity = status.callback_device_id.identity
        log.info("registered as %r — the guest should now see %s",
                 device.identity, device_name)
        log.info("DEVICE_IDENTITY_FULL=%s", device.identity)
    except grpc.RpcError as e:
        log.error("registration failed: %s %s", e.code(), e.details())
        server.stop(0)
        return 1

    log.info("waiting for the app to connect; Ctrl-C to stop")
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        log.info("stopping")
        server.stop(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
