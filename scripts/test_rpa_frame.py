#!/usr/bin/env python3
import unittest

import rpa_frame


class HeartbeatFrameTest(unittest.TestCase):
    def test_forward_and_backward_frames(self):
        self.assertEqual(rpa_frame.heartbeat(0x01, 0x30), bytes.fromhex("ef03020130"))
        self.assertEqual(rpa_frame.heartbeat(0x02, 0x7F), bytes.fromhex("ef0302027f"))

    def test_idle_and_exit_frames(self):
        self.assertEqual(rpa_frame.heartbeat(0x00, 0x00), bytes.fromhex("ef03020000"))
        self.assertEqual(rpa_frame.heartbeat(0x07, 0x61), bytes.fromhex("ef03020761"))

    def test_counter_wraps_after_7f(self):
        self.assertEqual(rpa_frame.next_counter(0x7F), 0x00)

    def test_direction_burst_uses_one_counter_per_frame(self):
        frames = rpa_frame.direction_burst(0x01, 0x7E, 3)
        self.assertEqual(frames, [
            bytes.fromhex("ef0302017e"),
            bytes.fromhex("ef0302017f"),
            bytes.fromhex("ef03020100"),
        ])


if __name__ == "__main__":
    unittest.main()
