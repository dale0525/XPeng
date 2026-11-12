import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BleLink, type BleLinkAuthMaterial, type BleLinkState } from '../packages/protocol/src/ble-link.ts';
import type { BleCommandOptions, BleTransport } from '../packages/protocol/src/ble-session.ts';
import { fromHex, toHex } from '../packages/protocol/src/bytes.ts';

class FakeTransport implements BleTransport {
  connected = false;
  connects: string[] = [];
  writes: string[] = [];
  closed = 0;
  refuseConnect = false;
  data = new Set<(data: Uint8Array) => void>();
  lost = new Set<(reason: string) => void>();

  async connect(mac: string) {
    this.connects.push(mac);
    if (this.refuseConnect) throw new Error('GATT_CONN_FAILED_ESTABLISHMENT');
    this.connected = true;
  }
  async disconnect() { this.closed++; this.connected = false; }
  onData(cb: (data: Uint8Array) => void) { this.data.add(cb); return () => this.data.delete(cb); }
  onDisconnect(cb: (reason: string) => void) { this.lost.add(cb); return () => this.lost.delete(cb); }
  emit(hex: string) { for (const cb of this.data) cb(fromHex(hex)); }
  drop(reason: string) { this.connected = false; for (const cb of this.lost) cb(reason); }
  async write(data: Uint8Array) {
    const hex = toHex(data);
    this.writes.push(hex);
    if (hex.startsWith('ef0104')) this.emit('ffdba7e0');
    else if (hex.startsWith('ef0110')) this.emit('08000144463030482e32');
    else if (hex.startsWith('ed1118')) this.emit('0281000000000000000002fc9800000000000000');
    else this.emit('007002000000c8000000');
  }
}

const options = {
  mac: '00:60:37:85:B9:D0',
  keyMac: '00:60:37:85:B9:D0',
  appN: fromHex('d4e5fee5'),
  createAuthCipher: async () => fromHex('db61b5b113d0870e6482ace4772c27e2'),
  frame: fromHex('ed1109000200000000020102'),
  commandCode: 2,
  timeoutMs: 50,
} as unknown as BleCommandOptions;

// 假车用非 V2（createAuthCipher）握手，与 FakeTransport 的回包匹配。
const authMaterial = async (mac: string): Promise<BleLinkAuthMaterial> => ({
  appN: fromHex('d4e5fee5'),
  keyMac: mac,
  createAuthCipher: async () => fromHex('db61b5b113d0870e6482ace4772c27e2'),
});

function settle(ms = 40) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('hold authenticates immediately after connecting and keeps the link open', async () => {
  const io = new FakeTransport();
  const link = new BleLink(io, authMaterial);
  await link.hold('00:60:37:85:B9:D0');
  assert.equal(io.connects.length, 1);
  assert.equal(link.connected, true);
  assert.ok(io.writes.some((w) => w.startsWith('ef0104')), 'must start the handshake right after connecting');
  assert.ok(io.writes.some((w) => w.startsWith('ed1118')), 'must finish the three-step handshake');
  assert.equal(io.closed, 0, 'authenticate must not disconnect the held link');
});

test('hold keeps the link open after the operation and reuses it', async () => {
  const io = new FakeTransport();
  const link = new BleLink(io, authMaterial);
  await link.hold('00:60:37:85:B9:D0');
  assert.equal(io.connects.length, 1);
  assert.equal(link.connected, true);

  const ack = await link.execute(options);
  assert.equal(ack.code, 200);
  assert.equal(io.closed, 0, 'a held link must not disconnect after an operation');
  assert.equal(io.connects.length, 1, 'a held link must not reconnect for an operation');
  await link.release();
  assert.equal(io.closed, 1);
  assert.equal(link.connected, false);
});

test('re-authenticates on the configured interval using fresh material', async () => {
  const io = new FakeTransport();
  let takes = 0;
  const link = new BleLink(io, async (mac) => {
    takes += 1;
    return { appN: fromHex('d4e5fee5'), keyMac: mac,
      createAuthCipher: async () => fromHex('db61b5b113d0870e6482ace4772c27e2') };
  }, { reauthIntervalMs: 15, baseDelayMs: 5 });
  await link.hold('00:60:37:85:B9:D0');
  assert.equal(takes, 1, 'connect must consume exactly one material');
  await settle(60);
  assert.ok(takes >= 2, 'the link must re-authenticate on the interval to stay connected');
  assert.equal(io.closed, 0, 're-authentication must not drop the link');
  await link.release();
});

test('a held link reconnects and re-authenticates after the vehicle drops it', async () => {
  const io = new FakeTransport();
  const states: BleLinkState[] = [];
  let takes = 0;
  const link = new BleLink(io, async (mac) => {
    takes += 1;
    return { appN: fromHex('d4e5fee5'), keyMac: mac,
      createAuthCipher: async () => fromHex('db61b5b113d0870e6482ace4772c27e2') };
  }, { baseDelayMs: 5, onStateChange: (s) => states.push(s) });
  await link.hold('00:60:37:85:B9:D0');
  io.drop('GATT disconnected: 19');
  await settle();
  assert.equal(io.connects.length, 2, 'the link must reconnect without a user request');
  assert.equal(link.connected, true);
  assert.equal(takes, 2, 'reconnect must authenticate again with fresh material');
  assert.ok(states.some((s) => s.kind === 'backoff'), 'the drop must surface as a backoff state');
  await link.release();
});

test('retry delay grows with consecutive failures and stays bounded', async () => {
  const io = new FakeTransport();
  const delays: number[] = [];
  const link = new BleLink(io, authMaterial, {
    baseDelayMs: 5, maxDelayMs: 20,
    onStateChange: (s) => { if (s.kind === 'backoff') delays.push(s.retryInMs); },
  });
  io.refuseConnect = true;
  await link.hold('00:60:37:85:B9:D0');
  await settle(200);
  assert.deepEqual(delays.slice(0, 4), [5, 10, 20, 20]);
  await link.release();
});

test('release stops further reconnection attempts', async () => {
  const io = new FakeTransport();
  const link = new BleLink(io, authMaterial, { baseDelayMs: 5 });
  await link.hold('00:60:37:85:B9:D0');
  await link.release();
  io.drop('GATT disconnected: 8');
  await settle();
  assert.equal(io.connects.length, 1, 'a released link must stay down');
});

test('without hold an operation still connects and disconnects on its own', async () => {
  const io = new FakeTransport();
  const link = new BleLink(io, authMaterial);
  await link.execute(options);
  assert.equal(io.connects.length, 1);
  assert.equal(io.closed, 1);
});

test('a permanent error stops retrying instead of looping forever', async () => {
  const io = new FakeTransport();
  const states: BleLinkState[] = [];
  const link = new BleLink(io, authMaterial, {
    baseDelayMs: 5,
    isPermanentError: (error) => (error as Error).message === 'Bluetooth is switched off',
    onStateChange: (s) => states.push(s),
  });
  io.refuseConnect = true;
  io.connect = async () => { throw new Error('Bluetooth is switched off'); };
  await link.hold('00:60:37:85:B9:D0');
  await settle(60);
  assert.equal(io.connects.length, 0);
  assert.deepEqual(states.map((s) => s.kind), ['connecting', 'idle']);
  assert.equal(link.held, false, 'a permanent error must not leave the link holding on');
});

test('an operation during backoff connects immediately instead of failing', async () => {
  const io = new FakeTransport();
  const link = new BleLink(io, authMaterial, { baseDelayMs: 5000 });
  await link.hold('00:60:37:85:B9:D0');
  io.drop('GATT disconnected: 19');
  await settle(10);
  assert.equal(link.connected, false);
  const ack = await link.execute(options);
  assert.equal(ack.code, 200);
  assert.equal(io.connects.length, 2, 'the operation must trigger the reconnect rather than wait out the backoff');
  await link.release();
});

test('holding a different vehicle releases the previous link', async () => {
  const io = new FakeTransport();
  const link = new BleLink(io, authMaterial, { baseDelayMs: 5 });
  await link.hold('00:60:37:85:B9:D0');
  await link.hold('AA:BB:CC:DD:EE:FF');
  assert.deepEqual(io.connects, ['00:60:37:85:B9:D0', 'AA:BB:CC:DD:EE:FF']);
  assert.equal(io.closed, 1, 'the old vehicle must not stay connected');
  await link.release();
});

test('an operation on another vehicle re-holds the link on that vehicle', async () => {
  const io = new FakeTransport();
  const link = new BleLink(io, authMaterial, { baseDelayMs: 5 });
  await link.hold('00:60:37:85:B9:D0');
  const ack = await link.execute({ ...options, mac: 'aa:bb:cc:dd:ee:ff' } as unknown as BleCommandOptions);
  assert.equal(ack.code, 200);
  assert.deepEqual(io.connects, ['00:60:37:85:B9:D0', 'AA:BB:CC:DD:EE:FF']);
  await link.release();
});

test('retry and reauth run through the injected timer, not JS setTimeout', async () => {
  const io = new FakeTransport();
  let retryRun: (() => void) | undefined;
  let reauthRun: (() => void) | undefined;
  let retryDelay = -1;
  let reauthDelay = -1;
  const timers = {
    retry(mac: string, delayMs: number, run: () => void) { retryDelay = delayMs; retryRun = run; },
    reauth(mac: string, delayMs: number, run: () => void) { reauthDelay = delayMs; reauthRun = run; },
    cancelRetry() { retryRun = undefined; },
    cancelReauth() { reauthRun = undefined; },
  };
  let takes = 0;
  const link = new BleLink(io, async (mac) => {
    takes += 1;
    return { appN: fromHex('d4e5fee5'), keyMac: mac,
      createAuthCipher: async () => fromHex('db61b5b113d0870e6482ace4772c27e2') };
  }, { timers, baseDelayMs: 5, reauthIntervalMs: 120_000 });
  await link.hold('00:60:37:85:B9:D0');
  // 连上即认证，并排了一次 120s 重鉴权（走注入计时器，不依赖 JS setTimeout）。
  assert.equal(takes, 1);
  assert.equal(reauthDelay, 120_000);
  assert.ok(reauthRun, 'reauth must be scheduled through the injected timer');
  // 车端踢掉 → 退避重试也走注入计时器；手动触发才重连，证明后台不靠 JS 定时器。
  io.drop('GATT disconnected: 19');
  assert.equal(io.connects.length, 1, 'no reconnect until the injected retry fires');
  assert.ok(retryRun, 'retry must be scheduled through the injected timer');
  const fireRetry = retryRun!;
  fireRetry();
  await settle(20);
  assert.equal(io.connects.length, 2, 'firing the injected retry must reconnect');
  assert.equal(takes, 2, 'reconnect re-authenticates');
  // 手动触发重鉴权也要真的再握一次手。
  const fireReauth = reauthRun!;
  fireReauth();
  await settle(20);
  assert.equal(takes, 3, 'firing the injected reauth must re-authenticate without dropping the link');
  assert.equal(io.closed, 0);
  await link.release();
});
