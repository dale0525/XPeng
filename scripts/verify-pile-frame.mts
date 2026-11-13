import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPileFrame, crc16Xmodem, parsePileFrame } from '../packages/protocol/src/pile-frame.ts';
import { fromHex, toHex } from '../packages/protocol/src/bytes.ts';

/** The nine frames captured from the real pile, verbatim. */
const CAPTURED = {
  connectWrite1: '6829ff8b38ebf07e01ee6a6393',
  connectNotify1: '692922a756036c7e01ee6a96ea',
  connectWrite2: '68503f881ae1eed841eb87ff898b1b70ae8438fc',
  connectNotify2: '694a000a010200160f00eeee1711',
  // Class-3 server-family reports seen in the 2026-11-07 window. NOT the start
  // command: that is the command-family 7e03… frame (see pile-session.mts).
  class3Write: '68620000291a',
  class3Reply: '6961003de1',
  status1: '68a51abf3170001f99',
  ack: '69a1002bb5',
  status2: '68a53ebf3170009e2b',
} as const;

test('all nine captured frames round-trip byte for byte', () => {
  for (const [name, hex] of Object.entries(CAPTURED)) {
    const parsed = parsePileFrame(fromHex(hex));
    const rebuilt = buildPileFrame(!parsed.responder, parsed.class, parsed.payload);
    assert.equal(toHex(rebuilt), hex, name);
  }
});

test('b1 low five bits equal the payload length and high three bits carry the class', () => {
  const expected: Array<[keyof typeof CAPTURED, number, number]> = [
    ['connectWrite1', 1, 9],
    ['connectNotify1', 1, 9],
    ['connectWrite2', 2, 16],
    ['connectNotify2', 2, 10],
    ['class3Write', 3, 2],
    ['class3Reply', 3, 1],
    ['status1', 5, 5],
    ['ack', 5, 1],
    ['status2', 5, 5],
  ];
  for (const [name, cls, len] of expected) {
    const frame = parsePileFrame(fromHex(CAPTURED[name]));
    assert.equal(frame.class, cls, `${name} class`);
    assert.equal(frame.payload.length, len, `${name} payload length`);
  }
});

test('role bit separates request from response, not transport direction', () => {
  assert.equal(parsePileFrame(fromHex(CAPTURED.connectWrite1)).responder, false);
  assert.equal(parsePileFrame(fromHex(CAPTURED.connectNotify1)).responder, true);
  // The pile's own status reports use the initiator-style 0x68 while the phone
  // answers with 0x69, so the bit cannot mean write-vs-notify.
  assert.equal(parsePileFrame(fromHex(CAPTURED.status1)).responder, false);
  assert.equal(parsePileFrame(fromHex(CAPTURED.ack)).responder, true);
});

test('start-charging sequence carries no session-derived bytes', () => {
  for (const name of ['class3Write', 'class3Reply', 'ack'] as const) {
    const { payload } = parsePileFrame(fromHex(CAPTURED[name]));
    assert.ok(payload.length > 0, name);
    assert.ok(payload.every((byte) => byte === 0), `${name} must be all zero`);
  }
});

test('class-1 payload has a fixed first byte per direction and a fixed last byte', () => {
  const w1 = parsePileFrame(fromHex(CAPTURED.connectWrite1)).payload;
  const n1 = parsePileFrame(fromHex(CAPTURED.connectNotify1)).payload;
  assert.equal(w1[0], 0xff);
  assert.equal(n1[0], 0x22);
  assert.equal(w1.at(-1), 0x6a);
  assert.equal(n1.at(-1), 0x6a);
});

test('class-5 status frames carry a four-byte tail constant within one session', () => {
  // Single sample only: this is NOT established as a cross-session constant,
  // because the same inference failed for class 1 once a second session existed.
  const s1 = parsePileFrame(fromHex(CAPTURED.status1)).payload;
  const s2 = parsePileFrame(fromHex(CAPTURED.status2)).payload;
  assert.equal(toHex(s1.subarray(-4)), 'bf317000');
  assert.equal(toHex(s2.subarray(-4)), 'bf317000');
  assert.notEqual(toHex(s1.subarray(0, 1)), toHex(s2.subarray(0, 1)));
});

test('a second real connect session keeps only byte 0 and byte 8 of class 1', () => {
  const sessionA = ['6829ff8b38ebf07e01ee6a6393', '692922a756036c7e01ee6a96ea'];
  const sessionB = ['6829ff36cf1fb2121eef6a3003', '6929223fd47734121eef6a9dbe'];
  for (let i = 0; i < 2; i += 1) {
    const a = parsePileFrame(fromHex(sessionA[i]!)).payload;
    const b = parsePileFrame(fromHex(sessionB[i]!)).payload;
    const same = [...a].map((byte, index) => byte === b[index]).flatMap((eq, index) => (eq ? [index] : []));
    assert.deepEqual(same, [0, 8]);
  }
});

test('W2 keeps its length across sessions but only its last byte', () => {
  const a = parsePileFrame(fromHex('68503f881ae1eed841eb87ff898b1b70ae8438fc')).payload;
  const b = parsePileFrame(fromHex('68503bb8f9938b7219ff971008ee052602841a98')).payload;
  assert.equal(a.length, 16);
  assert.equal(b.length, 16);
  const same = [...a].map((byte, index) => byte === b[index]).flatMap((eq, index) => (eq ? [index] : []));
  assert.deepEqual(same, [15]);
  assert.equal(a[15], 0x84);
});

test('N2 differs across sessions only at byte 1', () => {
  const n2a = parsePileFrame(fromHex('694a000a010200160f00eeee1711')).payload;
  const n2b = parsePileFrame(fromHex('694a0008010200160f00eeeed176')).payload;
  const same = [...n2a].map((byte, index) => byte === n2b[index]).flatMap((eq, index) => (eq ? [index] : []));
  assert.deepEqual(same, [0, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(n2a[1], 0x0a);
  assert.equal(n2b[1], 0x08);
  // Both N2 payloads are 10 bytes, so byte 1 is not N2's own length; W2's
  // payload length is 16 in both sessions, so it does not track W2's length
  // either. The meaning stays unknown.
  assert.equal(n2a.length, 10);
  assert.equal(n2b.length, 10);
  assert.equal(toHex(n2a.subarray(3)), '0200160f00eeee');
});

test('crc16 matches the captured trailing checksums', () => {
  assert.equal(crc16Xmodem(fromHex('6829ff8b38ebf07e01ee6a')), 0x6393);
  assert.equal(crc16Xmodem(fromHex('68620000')), 0x291a);
  assert.equal(crc16Xmodem(fromHex('69a100')), 0x2bb5);
});

test('a corrupted checksum is rejected', () => {
  const broken = fromHex(CAPTURED.class3Write);
  broken[broken.length - 1] = (broken[broken.length - 1]! ^ 0xff) & 0xff;
  assert.throws(() => parsePileFrame(broken), /CRC mismatch/);
});

test('a wrong payload-length field is rejected', () => {
  const broken = fromHex(CAPTURED.connectNotify2);
  broken[1] = (broken[1]! & 0xe0) | 9; // b1 claims 9 instead of 10
  assert.throws(() => parsePileFrame(broken), /length mismatch/);
});

test('a non-pile b0 is rejected', () => {
  assert.throws(() => parsePileFrame(fromHex('ed1109000200000000020102')), /not a pile frame/);
});

test('build refuses values outside the encodable range', () => {
  assert.throws(() => buildPileFrame(true, 8, new Uint8Array()), /class out of range/);
  assert.throws(() => buildPileFrame(true, 1, new Uint8Array(32)), /payload too long/);
});