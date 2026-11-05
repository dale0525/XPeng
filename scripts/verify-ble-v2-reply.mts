import assert from 'node:assert/strict';
import { test } from 'node:test';
import { V2VerifyReplyReceiver } from '../packages/protocol/src/ble-v2-reply.ts';
import { concat, fromHex, toHex } from '../packages/protocol/src/bytes.ts';

const records = ['00820231a503cca8cf0e', '008202325251838b3e83', '00820233422827d90000'].map(fromHex);
const expected = 'a503cca8cf0e5251838b3e83422827d9';

test('historical three-record notification produces the 16-byte cipher', () => {
  assert.equal(toHex(new V2VerifyReplyReceiver().accept(concat(...records))!), expected);
});

test('fragments survive notifications and accept every index order', () => {
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const receiver = new V2VerifyReplyReceiver();
    assert.equal(receiver.accept(records[order[0]]), null);
    assert.equal(receiver.accept(records[order[1]]), null);
    assert.equal(toHex(receiver.accept(records[order[2]])!), expected);
  }
});

test('short notification tails are discarded without joining across notifications', () => {
  const receiver = new V2VerifyReplyReceiver();
  assert.equal(receiver.accept(concat(records[0], records[1].subarray(0, 5))), null);
  assert.equal(receiver.accept(records[1].subarray(5)), null);
  assert.equal(receiver.accept(concat(records[2], fromHex('008202'))), null);
  assert.equal(toHex(receiver.accept(records[1])!), expected);
});

test('unknown msgId and payload type are ignored', () => {
  const receiver = new V2VerifyReplyReceiver();
  const unknownId = records[0].slice(); unknownId[0] = 0x82; unknownId[1] = 0;
  const unknownType = records[0].slice(); unknownType[2] = 1; unknownType[3] = 0;
  assert.equal(receiver.accept(concat(unknownId, unknownType)), null);
  assert.equal(toHex(receiver.accept(concat(...records))!), expected);
});

test('identical duplicates are accepted and received bytes are owned by the receiver', () => {
  const receiver = new V2VerifyReplyReceiver();
  const first = records[0].slice();
  assert.equal(receiver.accept(first), null);
  first[4] ^= 0xff;
  assert.equal(receiver.accept(records[0]), null);
  assert.equal(toHex(receiver.accept(concat(records[1], records[2]))!), expected);
});

test('conflicting duplicate rejects the transaction until reset', () => {
  const receiver = new V2VerifyReplyReceiver();
  receiver.accept(records[0]);
  const conflict = records[0].slice(); conflict[4] ^= 0xff;
  assert.throws(() => receiver.accept(conflict), /duplicate/i);
  assert.throws(() => receiver.accept(concat(...records)), /reset/i);
  receiver.reset();
  assert.equal(toHex(receiver.accept(concat(...records))!), expected);
});

test('invalid total or index rejects before assembling any cipher', () => {
  for (const header of [0x21, 0x41, 0x01, 0x30, 0x34, 0x3f]) {
    const receiver = new V2VerifyReplyReceiver();
    const invalid = records[0].slice(); invalid[3] = header;
    assert.throws(() => receiver.accept(invalid), /fragment/i);
    assert.throws(() => receiver.accept(concat(...records)), /reset/i);
  }
});

test('reset discards partial fragments', () => {
  const receiver = new V2VerifyReplyReceiver();
  receiver.accept(records[0]);
  receiver.reset();
  assert.equal(receiver.accept(concat(records[1], records[2])), null);
  assert.equal(toHex(receiver.accept(records[0])!), expected);
});

test('first completion ends reception until reset and ignores remaining records', () => {
  const receiver = new V2VerifyReplyReceiver();
  const invalid = records[0].slice(); invalid[3] = 0x21;
  assert.equal(toHex(receiver.accept(concat(...records, invalid))!), expected);
  assert.equal(receiver.accept(concat(...records)), null);
  receiver.reset();
  assert.equal(toHex(receiver.accept(concat(...records))!), expected);
});
