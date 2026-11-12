import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BleSession, type BleStage, type BleTransport } from '../packages/protocol/src/ble-session.ts';
import { fromHex, toHex } from '../packages/protocol/src/bytes.ts';

class FakeTransport implements BleTransport {
  writes: string[] = [];
  data = new Set<(data: Uint8Array) => void>();
  lost = new Set<(reason: string) => void>();
  closed = 0;
  failAuth = false;
  reply = true;
  mixed = false;
  ack = '007002000000c8000000';
  connect = async (_mac: string) => {};
  disconnect = async () => { this.closed++; };
  onData(cb: (data: Uint8Array) => void) { this.data.add(cb); return () => this.data.delete(cb); }
  onDisconnect(cb: (reason: string) => void) { this.lost.add(cb); return () => this.lost.delete(cb); }
  emit(hex: string) { for (const cb of this.data) cb(fromHex(hex)); }
  async write(data: Uint8Array) {
    const hex = toHex(data);
    this.writes.push(hex);
    if (!this.reply) return;
    // Responses arrive before the write promise settles, as Android callbacks may do.
    if (hex.startsWith('ef0104')) this.emit('ffdba7e0');
    else if (hex.startsWith('ef0110')) this.emit((this.mixed ? '02fc9800000000000000' : '') + (this.failAuth ? '08000e00000000000000' : '08000144463030482e32'));
    else if (hex.startsWith('ed1118')) this.emit((this.mixed ? '02fc9800000000000000' : '') + '0281000000000000000002fc9800000000000000');
    else this.emit(this.ack);
  }
}

const authCipher = fromHex('db61b5b113d0870e6482ace4772c27e2');
const command = fromHex('ed1109000200000000020102');
const options = { mac: '00:60:37:85:B9:D0', keyMac: '00:60:37:85:B9:D0', appN: fromHex('d4e5fee5'),
  createAuthCipher: async () => authCipher, frame: command, commandCode: 2, timeoutMs: 50 };

test('subscribes before writes, authenticates then waits for matching vehicle ACK', async () => {
  const io = new FakeTransport();
  const result = await new BleSession(io).execute(options);
  assert.equal(result.code, 200);
  assert.equal(io.writes[0], 'ef0104d4e5fee5');
  assert.equal(io.writes[1], 'ef011092b7148348c91f370a898d0ce5855afe');
  assert.ok(io.writes[2].startsWith('ed11180011'));
  assert.equal(io.writes[3], toHex(command));
  assert.equal(io.closed, 1);
  assert.equal(io.data.size, 0);
});

test('vehicle ACK is returned even when its first byte differs from the sent command code', async () => {
  const io = new FakeTransport();
  io.ack = '00700100002aa3000000';
  const result = await new BleSession(io).execute({ ...options, commandCode: 2, timeoutMs: 50 });
  assert.deepEqual(result, { commandCode: 2, code: 163 });
});

test('fire-and-forget command writes the frame without waiting for a 0x0070 ACK', async () => {
  // 直线召唤的激活命令是 0x03：真车整场会话没有 0x0070 控制回执，只有 0318/0225 状态帧。
  // 若默认等 0070，会把已成功写出的激活帧误报成「回执超时」。
  const io = new FakeTransport();
  io.ack = ''; // 保持握手回执，但不回任何 0070 记录
  const result = await new BleSession(io).execute({ ...options, expectCommandAck: false, timeoutMs: 50 });
  assert.deepEqual(result, { commandCode: 2, code: 200 });
  assert.equal(io.writes[3], toHex(command));
  assert.equal(io.closed, 1);
  assert.equal(io.data.size, 0);
});

test('reports operation stages from preparation through disconnection', async () => {
  const io = new FakeTransport();
  const stages: BleStage[] = [];
  await new BleSession(io, stage => stages.push(stage)).execute(options);
  assert.deepEqual(stages, ['connecting', 'authenticating', 'authenticated', 'command', 'disconnected']);
});

test('KDF uses the explicit target-module keyString rather than a transport address', async () => {
  const io = new FakeTransport();
  await new BleSession(io).execute({ ...options, mac: 'AA:BB:CC:DD:EE:FF' });
  assert.equal(io.writes[1], 'ef011092b7148348c91f370a898d0ce5855afe');
});

test('handshake ACKs can follow unrelated ten-byte records', async () => {
  const io = new FakeTransport(); io.mixed = true;
  const result = await new BleSession(io).execute(options);
  assert.equal(result.code, 200);
});

test('rejected authentication never sends third handshake or command', async () => {
  const io = new FakeTransport(); io.failAuth = true;
  await assert.rejects(new BleSession(io).execute(options), /authentication.*0e/i);
  assert.equal(io.writes.length, 2);
  assert.equal(io.closed, 1);
});

test('timeout stops the operation and releases event handlers', async () => {
  const io = new FakeTransport(); io.reply = false;
  await assert.rejects(new BleSession(io).execute({ ...options, timeoutMs: 5 }), /timeout/i);
  assert.equal(io.writes.length, 1);
  assert.equal(io.data.size, 0);
  assert.equal(io.closed, 1);
});

test('disconnect during a pending handshake rejects immediately', async () => {
  const io = new FakeTransport(); io.reply = false;
  const operation = new BleSession(io).execute(options);
  await Promise.resolve();
  for (const cb of io.lost) cb('link lost');
  await assert.rejects(operation, /disconnected: link lost/);
  assert.equal(io.writes.length, 1);
  assert.equal(io.data.size, 0);
});

test('missing key computation fails without transmitting a command', async () => {
  const io = new FakeTransport();
  await assert.rejects(new BleSession(io).execute({ ...options,
    createAuthCipher: async () => { throw new Error('key material unavailable'); },
  }), /key material unavailable/);
  assert.equal(io.writes.length, 2);
  assert.equal(io.closed, 1);
});
