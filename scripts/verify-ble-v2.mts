import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { createV2AuthCipher } from '../packages/protocol/src/ble-v2-verify.ts';
import { BleSession, type BleTransport } from '../packages/protocol/src/ble-session.ts';
import { fromHex, toHex } from '../packages/protocol/src/bytes.ts';
import { parseTbox } from '../packages/protocol/src/ble.ts';

const key = '00112233445566778899aabbccddeeff';

function oracle(keyHex: string, random: number): Buffer {
  const plain = Buffer.alloc(16);
  plain.writeUInt32LE(random);
  const cipher = createCipheriv(`aes-${keyHex.length * 4}-cbc`, Buffer.from(keyHex, 'hex'), Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

for (const keyBytes of [16, 24, 32]) {
  for (const random of [0, 0x12345678, 0x80000000, 0xffffffff]) {
    test(`V2 AES-${keyBytes * 8} uint32 ${random} matches independent Node oracle`, () => {
      const keyHex = 'ab'.repeat(keyBytes);
      const actual = createV2AuthCipher(keyHex, random);
      assert.equal(actual.length, 16);
      assert.equal(toHex(actual), oracle(keyHex, random).toString('hex'));
      const decipher = createDecipheriv(`aes-${keyBytes * 8}-cbc`, Buffer.from(keyHex, 'hex'), Buffer.alloc(16));
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(actual), decipher.final()]);
      assert.equal(plain.readUInt32LE(), random);
      assert.equal(plain.subarray(4).toString('hex'), '00'.repeat(12));
      // The next challenge wraps at uint32; it must not be substituted for the sent rand.
      assert.notEqual(toHex(actual), oracle(keyHex, (random + 1) >>> 0).toString('hex'));
    });
  }
}

test('V2 rejects malformed external key hex and non-uint32 random values', () => {
  for (const badKey of ['', 'ab', 'ab'.repeat(15), 'ab'.repeat(17), 'z0'.repeat(16), `${key}0`]) {
    assert.throws(() => createV2AuthCipher(badKey, 0));
  }
  for (const random of [-1, 0x100000000, 1.5, NaN, Infinity]) {
    assert.throws(() => createV2AuthCipher(key, random), /uint32/);
  }
});

class StatusOnlyVehicle implements BleTransport {
  writes: Uint8Array[] = [];
  listeners = new Set<(data: Uint8Array) => void>();
  closed = 0;
  connections = 0;
  connect = async (_mac: string) => { this.connections++; };
  disconnect = async () => { this.closed++; };
  onData(cb: (data: Uint8Array) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  onDisconnect(_cb: (reason: string) => void) { return () => {}; }
  async write(data: Uint8Array) {
    this.writes.push(data);
    const response = this.writes.length === 1 ? 'ffdba7e0'
      : this.writes.length === 2 ? '08000144463030482e32'
      : '02fc980000000000000002810000000000000000';
    for (const cb of this.listeners) cb(fromHex(response));
  }
}

test('invalid V2 material rejects before connecting', async () => {
  for (const material of [{ verifyKey: '', verifyRandom: 0 }, { verifyKey: key, verifyRandom: -1 }]) {
    const vehicle = new StatusOnlyVehicle();
    await assert.rejects(new BleSession(vehicle).execute({
      mac: '00:60:37:85:B9:D0', keyMac: '00:60:37:85:B9:D0', appN: fromHex('d4e5fee5'),
      ...material, frame: new Uint8Array(), commandCode: 2,
    }));
    assert.equal(vehicle.connections, 0);
    assert.equal(vehicle.writes.length, 0);
  }
});

test('execute sends real V2 cipher independently of app nonce, then refuses status-only authentication', async () => {
  const vehicle = new StatusOnlyVehicle();
  await assert.rejects(new BleSession(vehicle).execute({
    mac: '00:60:37:85:B9:D0', keyMac: '00:60:37:85:B9:D0', appN: fromHex('d4e5fee5'),
    verifyKey: key, verifyRandom: 0xffffffff,
    frame: fromHex('ed1109000200000000020102'), commandCode: 2, timeoutMs: 50,
  }), /BLE response timeout/i);
  assert.equal(vehicle.writes.length, 3, 'status records must never authorize a command');
  const auth = parseTbox(vehicle.writes[2]);
  assert.equal(auth.channel, 0xed);
  assert.equal(auth.flag, 0x11);
  assert.equal(auth.type, 0);
  assert.equal(toHex(auth.payload), `${oracle(key, 0xffffffff).toString('hex')}e0`);
  assert.equal(vehicle.closed, 1);
  assert.equal(vehicle.listeners.size, 0);
});
