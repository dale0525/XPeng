#!/usr/bin/env python3
"""Inspect only the captured BLE VDEX; emit structural counts and target names."""
import hashlib
import json
from pathlib import Path
import struct
import zlib

CAPTURE = Path("work/ble-process-20261104/base-vdex-full.bin")
TARGETS = {
    "native_generateSessionKey", "generateSessionKey",
    "native_generateAuth1DataV3", "generateAuth1DataV3",
    "hkdfSha256", "hkdfSha256V2",
}


class InvalidDex(ValueError):
    pass


class Dex:
    def __init__(self, data):
        self.data = data
        self.size = len(data)

    def bounded(self, offset, size):
        if offset < 0 or size < 0 or offset + size > self.size:
            raise InvalidDex("out_of_bounds")

    def u32(self, offset):
        self.bounded(offset, 4)
        return struct.unpack_from("<I", self.data, offset)[0]

    def leb(self, offset, signed=False):
        value = 0
        for i in range(5):
            self.bounded(offset, 1)
            byte = self.data[offset]
            offset += 1
            value |= (byte & 127) << (7 * i)
            if byte < 128:
                if signed and byte & 64:
                    value -= 1 << (7 * (i + 1))
                if (not signed and value > 0xffffffff) or (signed and not -(1 << 31) <= value < (1 << 31)):
                    raise InvalidDex("invalid_leb")
                return value, offset
        raise InvalidDex("invalid_leb")

    def code(self, offset, type_count):
        if offset % 4:
            raise InvalidDex("unaligned_code")
        self.bounded(offset, 16)
        registers, ins, _, tries, debug, insns = struct.unpack_from("<HHHHII", self.data, offset)
        if ins > registers or (debug and debug >= self.size):
            raise InvalidDex("invalid_code_header")
        cursor = offset + 16
        self.bounded(cursor, insns * 2)
        cursor += insns * 2
        if not tries:
            return
        cursor += 2 * (insns % 2)
        self.bounded(cursor, tries * 8)
        try_offset = cursor
        cursor += tries * 8
        handlers_base = cursor
        count, cursor = self.leb(cursor)
        handler_offsets = set()
        for _ in range(count):
            handler_offsets.add(cursor - handlers_base)
            size, cursor = self.leb(cursor, signed=True)
            for _ in range(abs(size)):
                type_idx, cursor = self.leb(cursor)
                address, cursor = self.leb(cursor)
                if type_idx >= type_count or address >= insns:
                    raise InvalidDex("invalid_catch_handler")
            if size <= 0:
                address, cursor = self.leb(cursor)
                if address >= insns:
                    raise InvalidDex("invalid_catch_all")
        for i in range(tries):
            start, length, handler = struct.unpack_from("<IHH", self.data, try_offset + i * 8)
            if start + length > insns or handler not in handler_offsets:
                raise InvalidDex("invalid_try_item")

    def inspect(self, targets):
        if self.u32(36) != 112 or self.u32(40) != 0x12345678:
            raise InvalidDex("unsupported_dex_header")
        strings, strings_off = self.u32(56), self.u32(60)
        types, types_off = self.u32(64), self.u32(68)
        protos, protos_off = self.u32(72), self.u32(76)
        fields, fields_off = self.u32(80), self.u32(84)
        methods, methods_off = self.u32(88), self.u32(92)
        classes, classes_off = self.u32(96), self.u32(100)
        for count, offset, width in ((strings, strings_off, 4), (types, types_off, 4),
                                     (protos, protos_off, 12), (fields, fields_off, 8),
                                     (methods, methods_off, 8), (classes, classes_off, 32)):
            self.bounded(offset, count * width)
        counts = dict(encoded_static_fields=0, encoded_instance_fields=0,
                      direct_methods=0, virtual_methods=0, valid_code_items=0,
                      zero_code_native_or_abstract_methods=0, invalid_code_offsets_or_items=0,
                      invalid_class_data_items=0, invalid_method_references=0,
                      code_access_flag_mismatches=0)
        # Compare bytes only against the allowlist; never decode arbitrary pool text.
        target_bytes = {name.encode("ascii"): name for name in targets}
        target_ids = {}
        for method_idx in range(methods):
            name_idx = self.u32(methods_off + method_idx * 8 + 4)
            if name_idx >= strings:
                counts["invalid_method_references"] += 1
                continue
            start = self.u32(strings_off + name_idx * 4)
            _, start = self.leb(start)
            for raw, name in target_bytes.items():
                end = start + len(raw)
                if end < self.size and self.data[start:end] == raw and self.data[end] == 0:
                    target_ids[method_idx] = name
                    break
        defined_targets = set()
        for i in range(classes):
            cursor = self.u32(classes_off + i * 32 + 24)
            if not cursor:
                continue
            try:
                sizes = []
                for _ in range(4):
                    size, cursor = self.leb(cursor)
                    sizes.append(size)
                sf, inf, dm, vm = sizes
                counts["encoded_static_fields"] += sf
                counts["encoded_instance_fields"] += inf
                # encoded_field is (field_idx_diff, access_flags), before any methods.
                for size in (sf, inf):
                    index = 0
                    for _ in range(size):
                        diff, cursor = self.leb(cursor)
                        _, cursor = self.leb(cursor)
                        index += diff
                        if index >= fields:
                            raise InvalidDex("invalid_field_index")
                for key, size in (("direct_methods", dm), ("virtual_methods", vm)):
                    method_idx = 0
                    for _ in range(size):
                        diff, cursor = self.leb(cursor)
                        flags, cursor = self.leb(cursor)
                        code_off, cursor = self.leb(cursor)
                        method_idx += diff
                        counts[key] += 1
                        if method_idx >= methods:
                            counts["invalid_method_references"] += 1
                        elif method_idx in target_ids:
                            defined_targets.add(target_ids[method_idx])
                        no_code = bool(flags & (0x100 | 0x400))
                        if not code_off:
                            if no_code:
                                counts["zero_code_native_or_abstract_methods"] += 1
                            else:
                                counts["code_access_flag_mismatches"] += 1
                        else:
                            if no_code:
                                counts["code_access_flag_mismatches"] += 1
                            try:
                                self.code(code_off, types)
                            except InvalidDex:
                                counts["invalid_code_offsets_or_items"] += 1
                            else:
                                counts["valid_code_items"] += 1
            except InvalidDex:
                counts["invalid_class_data_items"] += 1
        return dict(dex_file_size=self.size, dex_string_ids=strings, dex_type_ids=types,
                    dex_field_ids=fields, dex_method_ids=methods, dex_declared_classes=classes,
                    dex_adler32_matches=self.u32(8) == zlib.adler32(self.data[12:]),
                    dex_sha1_matches=self.data[12:32] == hashlib.sha1(self.data[32:]).digest(),
                    target_method_ids=sorted(set(target_ids.values())),
                    target_defined_methods=sorted(defined_targets), **counts)


def inspect(data, targets):
    if data[:8] != b"vdex027\0":
        raise InvalidDex("unexpected_vdex_magic")
    # VDEX 027 uses a section table; the word at offset 8 is not a DEX count.
    section_count = struct.unpack_from("<I", data, 8)[0]
    if section_count > (len(data) - 12) // 12:
        raise InvalidDex("invalid_vdex_section_table")
    sections = []
    for i in range(section_count):
        kind, offset, size = struct.unpack_from("<III", data, 12 + i * 12)
        if offset + size > len(data):
            raise InvalidDex("invalid_vdex_section_bounds")
        sections.append(dict(kind=kind, offset=offset, size=size))
    dexes = []
    cursor = 0
    while True:
        offset = data.find(b"dex\n", cursor)
        if offset < 0:
            break
        cursor = offset + 4
        if offset + 112 > len(data):
            continue
        if data[offset + 7] != 0 or data[offset + 4:offset + 7] not in (b"035", b"037", b"038", b"039", b"040"):
            continue
        size = struct.unpack_from("<I", data, offset + 32)[0]
        if size < 112 or offset + size > len(data):
            continue
        try:
            result = Dex(data[offset:offset + size]).inspect(targets)
        except InvalidDex:
            continue
        dexes.append(dict(offset=offset, version=data[offset + 4:offset + 7].decode("ascii"), **result))
    return dict(mapping_bytes=len(data), vdex_section_count=section_count,
                vdex_sections=sections, bounded_standard_dex_count=len(dexes), dexes=dexes)


if __name__ == "__main__":
    try:
        result = inspect(CAPTURE.read_bytes(), TARGETS)
    except InvalidDex as error:
        raise SystemExit(str(error)) from None
    print(json.dumps(result, indent=2, sort_keys=True))
