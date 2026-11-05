import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { crc32Init0, deriveAuth1Payload } from '../packages/protocol/src/ble.ts';
import { BleSession, type BleTransport } from '../packages/protocol/src/ble-session.ts';
import { buildV2Command } from '../packages/protocol/src/ble-v2-command.ts';
import { BleV2MaterialService } from '../packages/protocol/src/ble-v2-material.ts';

const phoneKey = '00112233445566778899aabbccddeeff';
const appN = Buffer.from('d4e5fee5', 'hex');
const carN = Buffer.from('ffdba7e0', 'hex');
const mac = 'AA:BB:CC:DD:EE:FF';
const keyMac = '00:60:37:85:B9:D0';
const vin = 'OFFLINE-FIXTURE-VIN';

class Vehicle implements BleTransport {
  writes: Buffer[] = [];
  data = new Set<(data: Uint8Array) => void>();
  lost = new Set<(reason: string) => void>();
  closed = 0;
  commandAllowed = false;

  readonly raw: Buffer;
  readonly commandCode: number;
  readonly messageId: number;
  readonly random: number;
  readonly badReply: boolean;

  constructor(raw: Buffer, commandCode: number, messageId: number, random: number, badReply: boolean) {
    this.raw = raw;
    this.commandCode = commandCode;
    this.messageId = messageId;
    this.random = random;
    this.badReply = badReply;
  }

  async connect(address: string) {
    assert.equal(address, mac);
    assert.equal(this.data.size, 1);
    assert.equal(this.lost.size, 1);
  }
  async disconnect() { this.closed++; }
  onData(cb: (data: Uint8Array) => void) { this.data.add(cb); return () => { this.data.delete(cb); }; }
  onDisconnect(cb: (reason: string) => void) { this.lost.add(cb); return () => { this.lost.delete(cb); }; }
  emit(data: Uint8Array) { for (const cb of this.data) cb(data); }

  async write(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    this.writes.push(frame);
    switch (this.writes.length) {
      case 1:
        assert.deepEqual(frame, Buffer.concat([Buffer.from('ef0104', 'hex'), appN]));
        this.emit(carN);
        return;
      case 2:
        assert.deepEqual(frame, Buffer.concat([Buffer.from('ef0110', 'hex'),
          Buffer.from(deriveAuth1Payload(appN, carN, keyMac))]));
        this.emit(Buffer.from('08000144463030482e32', 'hex'));
        return;
      case 3: {
        assert.equal(frame.length, 27);
        assert.equal(frame.subarray(0, 5).toString('hex'), 'ed11180011');
        assert.equal(frame[9], 0);
        assert.equal(frame[26], 0xe0);
        assert.equal(frame.readUInt32BE(5), crc32Init0(frame.subarray(10)));
        const decipher = createDecipheriv('aes-128-cbc', Buffer.from(phoneKey, 'hex'), Buffer.alloc(16));
        decipher.setAutoPadding(false);
        const plain = Buffer.concat([decipher.update(frame.subarray(10, 26)), decipher.final()]);
        assert.equal(plain.readUInt32LE(), this.random);
        assert.deepEqual(plain.subarray(4), Buffer.alloc(12));
        assert.notEqual(this.random, appN.readUInt32LE());
        assert.notEqual(this.random, carN.readUInt32LE());

        const reply = Buffer.alloc(16);
        reply.writeUInt32LE((this.random + (this.badReply ? 0 : 1)) >>> 0);
        const cipher = createCipheriv('aes-128-cbc', Buffer.from(phoneKey, 'hex'), Buffer.alloc(16));
        cipher.setAutoPadding(false);
        const encrypted = Buffer.concat([cipher.update(reply), cipher.final()]);
        const records = [0, 1, 2].map(index => {
          const record = Buffer.alloc(10);
          record.set([0, 0x82, 2, 0x31 + index]);
          encrypted.subarray(index * 6, index * 6 + 6).copy(record, 4);
          return record;
        });
        this.emit(Buffer.from('02810000000000000000', 'hex'));
        this.emit(records[1]);
        this.emit(records[0]);
        assert.equal(this.writes.length, 3, 'partial reply must not authorize a command');
        this.commandAllowed = !this.badReply;
        this.emit(records[2]);
        return;
      }
      case 4:
        assert.ok(this.commandAllowed, 'unverified reply must never authorize a command');
        assert.deepEqual(frame.subarray(0, 2), Buffer.from([0xed, 0x11]));
        assert.equal(frame[2], frame.length - 3);
        assert.equal(frame.readUInt16BE(3), this.raw.length + 1);
        assert.equal(frame[9], this.messageId);
        assert.deepEqual(frame.subarray(10), Buffer.concat([this.raw, Buffer.from([this.commandCode])]));
        assert.equal(frame.readUInt32BE(5), crc32Init0(frame.subarray(10)));
        const ack = Buffer.alloc(10);
        ack.set([0, 0x70, this.commandCode]);
        ack.writeUInt16LE(200, 6);
        this.emit(ack);
        return;
      default:
        assert.fail('unexpected extra BLE write');
    }
  }
}

test('offline material service → Base64 raw → V2 command → verified BLE session consumes distinct materials', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const service = new BleV2MaterialService(async (path, body) => {
    calls.push({ path, body });
    switch (calls.length) {
      case 1:
        assert.equal(path, '/digital-key/v1/key/ble/getXpKeyAuthData');
        assert.deepEqual(body, { vin, count: 300, autoCreateKey: false });
        return { cardNo: 'fixture-card', authDataList: ['AQIDBA==', 'BQYHCA=='] };
      case 2:
        assert.equal(path, '/digital-key/v1/key/common/getVerifyCode');
        assert.deepEqual(body, { vin, typeList: [1, 2] });
        return { verifyCodes: {
          '1': { code: phoneKey, index: 7 },
          '2': { code: '00112233445566778899aabbccddeeff', index: 8 },
        } };
      default:
        assert.fail('unexpected HTTP-material request; fixtures are the only call implementation');
    }
  });
  const consumed: string[] = [];
  for (const [index, badReply] of [false, true].entries()) {
    const material = await service.take('fixture-account', vin);
    consumed.push(material.message);
    assert.equal(material.cardNo, 'fixture-card');
    assert.deepEqual(material.verifyCode, { code: phoneKey, index: 7 });
    const raw = Buffer.from(material.message, 'base64');
    const expectedRaw = Buffer.from(index === 0 ? '01020304' : '05060708', 'hex');
    assert.deepEqual(raw, expectedRaw);
    const commandCode = index === 0 ? 2 : 1;
    const messageId = 0x41 + index;
    const random = index === 0 ? 0x12345678 : 0x87654321;
    const vehicle = new Vehicle(expectedRaw, commandCode, messageId, random, badReply);
    const operation = new BleSession(vehicle).execute({ mac, keyMac, appN,
      verifyKey: material.verifyCode.code, verifyRandom: random,
      frame: buildV2Command(raw, commandCode, messageId), commandCode, timeoutMs: 100 });
    if (badReply) {
      await assert.rejects(operation, /challenge/i);
      assert.equal(vehicle.writes.length, 3, 'failed verification cannot send the second material');
    } else {
      assert.deepEqual(await operation, { commandCode, code: 200 });
      assert.equal(vehicle.writes.length, 4);
    }
    assert.equal(vehicle.closed, 1);
    assert.equal(vehicle.data.size, 0);
    assert.equal(vehicle.lost.size, 0);
  }
  assert.deepEqual(consumed, ['AQIDBA==', 'BQYHCA==']);
  assert.notEqual(consumed[0], consumed[1]);
  assert.equal(calls.length, 2, 'both flows consume the same fixture queue without extra requests');
});
