#!/usr/bin/env python3
"""Construct the five-byte XPeng RPA heartbeat frames observed in HCI logs.

This module only produces bytes. It does not open a BLE connection and does not
send a frame to a vehicle.
"""

HEARTBEAT_PREFIX = bytes.fromhex("ef0302")


def heartbeat(mode: int, counter: int) -> bytes:
    return HEARTBEAT_PREFIX + bytes((mode, counter))


def next_counter(counter: int) -> int:
    """Advance the 7-bit counter observed to wrap from 0x7f to 0x00."""
    return (counter + 1) & 0x7F


def direction_burst(mode: int, counter: int, count: int) -> list[bytes]:
    frames = []
    for _ in range(count):
        frames.append(heartbeat(mode, counter))
        counter = next_counter(counter)
    return frames
