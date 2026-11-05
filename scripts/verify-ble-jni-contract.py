"""Inspect the archived arm64 library without loading it or accessing a device.

Run: pixi run -e rev python scripts/verify-ble-jni-contract.py
This proves JNI types and register transfers, not real session-key inputs.
"""
import argparse
import hashlib
from pathlib import Path

from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
from elftools.elf.elffile import ELFFile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("library", nargs="?", default="work/lib/lib/arm64-v8a/libbledata.so")
args = parser.parse_args()
path = Path(args.library)
expected_hash = "e8aa224cc6c061df2c584fed25182f0e861460423112a338bf4e01a6aef7d860"
actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
if actual_hash != expected_hash:
    raise SystemExit("Different native-library revision; inspect its contract independently")

instructions = {}
with path.open("rb") as stream:
    elf = ELFFile(stream)
    for start, size in [(0xa2150, 0xd4), (0xa0344, 0x80), (0xa36ac, 0x28)]:
        segment = next(s for s in elf.iter_segments()
                       if s["p_type"] == "PT_LOAD"
                       and s["p_vaddr"] <= start < s["p_vaddr"] + s["p_filesz"])
        offset = start - segment["p_vaddr"]
        for instruction in Cs(CS_ARCH_ARM64, CS_MODE_ARM).disasm(
                segment.data()[offset:offset + size], start):
            instructions[instruction.address] = (instruction.mnemonic, instruction.op_str)

# These are ABI evidence checkpoints, not a reimplementation of the key algorithm.
checkpoints = {
    0xa2188: ("ldr", "x8, [x8, #0x5c0]"),
    0xa21a8: ("ldr", "x8, [x8, #0x558]"),
    0xa21c4: ("ldr", "x8, [x8, #0x5c0]"),
    0xa21dc: ("ldr", "x8, [x8, #0x558]"),
    0xa2214: ("mov", "x4, x22"),
    0xa2218: ("mov", "x6, x23"),
    0xa03a4: ("stp", "w24, w23, [x0]"),
    0xa03a8: ("mov", "x0, x20"),
    0xa03ac: ("mov", "x2, x22"),
    0xa36b4: ("mov", "x3, x24"),
    0xa36c0: ("mov", "x4, x26"),
    0xa36c8: ("mov", "x5, x27"),
}
for address, expected in checkpoints.items():
    if instructions.get(address) != expected:
        raise SystemExit(f"Contract checkpoint mismatch at {address:#x}")
print("PASS: archived native library SHA-256 and 12 ABI checkpoints")
print("JNI: two byte arrays and two integers; 0x5c0=GetByteArrayElements, 0x558=GetArrayLength")
print("getSessionKey: x4=p1, x6=p2; packed integers are little endian")
print("Java HKDF callback array order: packed integers, p1, p2")
print("UNPROVEN: Java callback semantics, real array values/sources, val/data and vehicle acceptance")
