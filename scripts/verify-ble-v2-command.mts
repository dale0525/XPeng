import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildV2Command } from '../packages/protocol/src/ble-v2-command.ts';
import { fromHex, toHex } from '../packages/protocol/src/bytes.ts';

// Captured LOCK frame, teardown §6.15: CRC was independently checked on 99 captures.
const lock = 'ed118a0083938fa0ec025850424b5448010000826ae9f3d100544b49001012a774ba5b82bddb8bae973e35bed8e845440010fa505edb64d340d979be62b26cdbd5d9534e004630440220374e1b84242466e6f48bc2c283ee3ffd1cb79388362dbf2f8c2f74e8f12f04b30220505c22fc883f6368c59c802353b23762f515c1492dd0701ffbfd77797fdc22e302';

test('V2 preserves signed raw bytes and reproduces historical CRC and lengths', () => {
  const raw = fromHex(lock).slice(10, -1);
  const original = raw.slice();
  assert.equal(toHex(buildV2Command(raw, 2, 2)), lock);
  // messageId is not commandCode and is excluded from the CRC.
  assert.equal(toHex(buildV2Command(raw, 2, 1)), `${lock.slice(0, 18)}01${lock.slice(20)}`);
  assert.deepEqual(raw, original);
});

test('V2 rejects command codes and message IDs that cannot be represented as uint8', () => {
  for (const invalid of [-1, 256, 258, 1.5, NaN, Infinity]) {
    assert.throws(() => buildV2Command(new Uint8Array([1]), invalid, 1), /commandCode/);
    assert.throws(() => buildV2Command(new Uint8Array([1]), 2, invalid), /messageId/);
  }
});

test('V2 accepts opaque material without an XPBKTH parser', () => {
  // Standard CRC-32/ISO-HDLC check value for ASCII 123456789 is cbf43926.
  // With init=0 and xorout=0 the independently tabulated value is 2dfd2d88.
  const raw = fromHex('3132333435363738');
  assert.equal(toHex(buildV2Command(raw, 0x39, 0x7b)),
    'ed111000092dfd2d887b313233343536373839');
});
