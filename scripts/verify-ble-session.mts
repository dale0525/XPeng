import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { test } from 'node:test';
import { BleSession, type BleTransport } from '../packages/protocol/src/ble-session.ts';
import * as verify from '../packages/protocol/src/ble-v2-verify.ts';
import { concat, fromHex, toHex } from '../packages/protocol/src/bytes.ts';

const key = '00112233445566778899aabbccddeeff';
const random = 0x12345678;
const frame = fromHex('ed1109000200000000020102');
const status = fromHex('02810000000000000000');
const options = { mac: '00:60:37:85:B9:D0', keyMac: '00:60:37:85:B9:D0',
  appN: fromHex('d4e5fee5'), verifyKey: key, verifyRandom: random,
  frame, commandCode: 2, timeoutMs: 50 };

function encrypt(plain: Uint8Array, keyHex = key): Uint8Array {
  const cipher = createCipheriv(`aes-${keyHex.length * 4}-cbc`, Buffer.from(keyHex, 'hex'), Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
function challenge(value: number): Uint8Array {
  const plain = Buffer.alloc(16);
  plain.writeUInt32LE(value);
  return plain;
}
function records(cipher: Uint8Array): Uint8Array[] {
  return [0, 1, 2].map((index) => {
    const record = fromHex(`008202${(0x31 + index).toString(16)}000000000000`);
    record.set(cipher.subarray(index * 6, index * 6 + 6), 4);
    return record;
  });
}
const valid = () => records(encrypt(challenge(random + 1)));

class Vehicle implements BleTransport {
  writes: Uint8Array[] = [];
  data = new Set<(data: Uint8Array) => void>();
  lost = new Set<(reason: string) => void>();
  closed = 0;
  commandAllowed = false;
  third: (vehicle: Vehicle) => void = () => {};
  connect = async (_mac: string) => {};
  disconnect = async () => { this.closed++; };
  onData(cb: (data: Uint8Array) => void) { this.data.add(cb); return () => { this.data.delete(cb); }; }
  onDisconnect(cb: (reason: string) => void) { this.lost.add(cb); return () => { this.lost.delete(cb); }; }
  emit(data: Uint8Array) { for (const cb of this.data) cb(data); }
  async write(data: Uint8Array) {
    this.writes.push(data.slice());
    if (this.writes.length === 1) this.emit(fromHex('ffdba7e0'));
    else if (this.writes.length === 2) this.emit(fromHex('08000144463030482e32'));
    else if (this.writes.length === 3) this.third(this);
    else {
      assert.ok(this.commandAllowed, 'command was transmitted before a complete verified reply');
      assert.equal(toHex(data), toHex(frame));
      this.emit(fromHex('007002000000c8000000'));
    }
  }
}
function cleaned(vehicle: Vehicle) {
  assert.equal(vehicle.closed, 1);
  assert.equal(vehicle.data.size, 0);
  assert.equal(vehicle.lost.size, 0);
}

for (const keyBytes of [16, 24, 32]) {
  test(`V2 decrypts AES-${keyBytes * 8} CBC zero-IV NoPadding replies and checks full challenge`, () => {
    const keyHex = 'ab'.repeat(keyBytes);
    for (const value of [0, random, 0xffffffff]) {
      const plain = challenge((value + 1) >>> 0);
      const cipher = encrypt(plain, keyHex);
      assert.doesNotThrow(() => verify.verifyV2AuthReply(keyHex, value, cipher));
      assert.throws(() => verify.verifyV2AuthReply(keyHex, value, encrypt(challenge(value), keyHex)), /challenge/i);
      const badTail = plain.slice(); badTail[15] = 1;
      assert.throws(() => verify.verifyV2AuthReply(keyHex, value, encrypt(badTail, keyHex)), /challenge/i);
    }
    for (const length of [0, 15, 17, 32]) {
      assert.throws(() => verify.verifyV2AuthReply(keyHex, random, new Uint8Array(length)), /sixteen|16/i);
    }
  });
}

for (const arrangement of ['same notification', 'status then async fragments', 'fragments without status', 'fragments before status']) {
  test(`verified V2 reply authorizes exactly one command: ${arrangement}`, async () => {
    const vehicle = new Vehicle();
    vehicle.third = (io) => {
      const chunks = valid();
      if (arrangement === 'same notification') {
        io.commandAllowed = true; io.emit(concat(status, ...chunks));
      } else {
        if (arrangement === 'status then async fragments') io.emit(status);
        setImmediate(() => {
          io.emit(chunks[1]); io.emit(chunks[0]);
          assert.equal(io.writes.length, 3, 'partial ciphertext cannot authorize commands');
          io.commandAllowed = true; io.emit(chunks[2]);
          if (arrangement === 'fragments before status') io.emit(status);
        });
      }
    };
    assert.deepEqual(await new BleSession(vehicle).execute(options), { commandCode: 2, code: 200 });
    assert.equal(vehicle.writes.length, 4);
    cleaned(vehicle);
  });
}

for (const failure of ['status only', 'missing fragment', 'wrong random', 'nonzero tail', 'wrong key', 'conflicting duplicate', 'invalid header']) {
  test(`V2 fails closed without command: ${failure}`, async () => {
    const vehicle = new Vehicle();
    vehicle.third = (io) => {
      io.emit(status);
      setImmediate(() => {
        let chunks = valid();
        if (failure === 'status only') return;
        if (failure === 'missing fragment') { io.emit(concat(chunks[0], chunks[2])); return; }
        if (failure === 'wrong random') chunks = records(encrypt(challenge(random)));
        if (failure === 'nonzero tail') {
          const plain = challenge(random + 1); plain[4] = 1; chunks = records(encrypt(plain));
        }
        if (failure === 'wrong key') chunks = records(encrypt(challenge(random + 1), 'cd'.repeat(16)));
        if (failure === 'conflicting duplicate') {
          io.emit(chunks[0]); const conflict = chunks[0].slice(); conflict[4] ^= 0xff;
          io.emit(conflict); return;
        }
        if (failure === 'invalid header') chunks[0][3] = 0x21;
        io.emit(concat(...chunks));
      });
    };
    const expected = failure === 'status only' || failure === 'missing fragment' ? /timeout/i
      : failure === 'conflicting duplicate' ? /duplicate/i
      : failure === 'invalid header' ? /fragment/i : /challenge/i;
    await assert.rejects(new BleSession(vehicle).execute(options), expected);
    assert.equal(vehicle.writes.length, 3);
    cleaned(vehicle);
  });
}

for (const stage of [1, 2, 3]) {
  test(`abort during handshake write ${stage} prevents commands and permits session reuse`, async () => {
    const controller = new AbortController();
    const vehicle = new Vehicle();
    const emit = vehicle.emit.bind(vehicle);
    vehicle.emit = (data) => {
      if (vehicle.writes.length === stage) controller.abort(new Error('account changed'));
      else emit(data);
    };
    vehicle.third = (io) => io.emit(concat(...valid()));
    const session = new BleSession(vehicle);
    await assert.rejects(session.execute({ ...options, signal: controller.signal }), /account changed/);
    assert.equal(vehicle.writes.length, stage);
    cleaned(vehicle);
    vehicle.emit = emit; vehicle.writes = []; vehicle.closed = 0; vehicle.commandAllowed = true;
    assert.deepEqual(await session.execute(options), { commandCode: 2, code: 200 });
    assert.equal(vehicle.writes.length, 4); cleaned(vehicle);
  });
}

test('abort after verified reply but before command write wins the race', async () => {
  const controller = new AbortController();
  const vehicle = new Vehicle();
  vehicle.third = (io) => {
    io.emit(concat(...valid()));
    controller.abort(new Error('account changed'));
  };
  await assert.rejects(new BleSession(vehicle).execute({ ...options, signal: controller.signal }), /account changed/);
  assert.equal(vehicle.writes.length, 3); cleaned(vehicle);
});

test('already aborted operation never connects or writes', async () => {
  const controller = new AbortController(); controller.abort(new Error('account changed'));
  const vehicle = new Vehicle();
  vehicle.connect = async () => { assert.fail('aborted operation must not connect'); };
  await assert.rejects(new BleSession(vehicle).execute({ ...options, signal: controller.signal }), /account changed/);
  assert.equal(vehicle.writes.length, 0);
});

test('disconnect during V2 reply rejects and discards partial state before session reuse', async () => {
  const vehicle = new Vehicle();
  vehicle.third = (io) => {
    io.emit(valid()[0]);
    setImmediate(() => { for (const cb of io.lost) cb('link lost'); });
  };
  const session = new BleSession(vehicle);
  await assert.rejects(session.execute(options), /disconnected: link lost/i);
  assert.equal(vehicle.writes.length, 3); cleaned(vehicle);
  vehicle.writes = []; vehicle.closed = 0;
  vehicle.third = (io) => { io.emit(concat(valid()[1], valid()[2])); };
  await assert.rejects(session.execute(options), /timeout/i);
  assert.equal(vehicle.writes.length, 3); cleaned(vehicle);
});
