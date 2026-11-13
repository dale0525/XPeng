import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PileTransport } from '../packages/protocol/src/pile-session.ts';
import {
  PileSession,
  PileSessionError,
  START_CHARGE_FRAME,
  STATUS_ACK_FRAME,
  STOP_CHARGE_FRAME,
} from '../packages/protocol/src/pile-session.ts';
import { fromHex, toHex } from '../packages/protocol/src/bytes.ts';
import { buildPileCommandFrame } from '../packages/protocol/src/pile-frame.ts';
import { parsePileFrame as parse } from '../packages/protocol/src/pile-frame.ts';

/** Frames captured from the real pile in two independent sessions. */
const SESSION_A = {
  write1: '6829ff8b38ebf07e01ee6a6393',
  notify1: '692922a756036c7e01ee6a96ea',
  write2: '68503f881ae1eed841eb87ff898b1b70ae8438fc',
  notify2: '694a000a010200160f00eeee1711',
} as const;

const SESSION_B = {
  write1: '6829ff36cf1fb2121eef6a3003',
  notify1: '6929223fd47734121eef6a9dbe',
  write2: '68503bb8f9938b7219ff971008ee052602841a98',
  notify2: '694a0008010200160f00eeeed176',
} as const;

/** Captured 2026-11-13 from official App 5.19.0, one continuous session. */
const START_ACK = '7f03050052afa29bb27d';
const STOP_ACK = '7f040500ffffffff72c6';
/** Command-3 ack with verdict byte 01 (rejected), CRC valid. */
function rejectionAck(): string {
  return toHex(buildPileCommandFrame(3, Uint8Array.from([0x01, 0x52, 0xaf, 0xa2, 0x9b]), true));
}
const STATUS_1 = '68a51ab054710088dd';
const STATUS_2 = '68a53eb0547100096f';

/** Replays scripted notifications and records every write. */
class ScriptedTransport implements PileTransport {
  readonly writes: string[] = [];
  private readonly queue: string[];

  constructor(notifications: string[]) {
    this.queue = [...notifications];
  }

  async write(frame: Uint8Array): Promise<void> {
    this.writes.push(toHex(frame));
  }

  async nextNotification(): Promise<Uint8Array> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('no scripted notification left');
    return fromHex(next);
  }
}

test('handshake follows write1 -> notify1 -> write2 -> notify2', async () => {
  const transport = new ScriptedTransport([SESSION_A.notify1, SESSION_A.notify2]);
  const session = new PileSession(transport);
  const { notify1, notify2 } = await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });

  assert.deepEqual(transport.writes, [SESSION_A.write1, SESSION_A.write2]);
  assert.equal(notify1.class, 1);
  assert.equal(notify2.class, 2);
});

test('the second session is accepted with its own material', async () => {
  const transport = new ScriptedTransport([SESSION_B.notify1, SESSION_B.notify2]);
  const session = new PileSession(transport);

  await session.connect({
    connectWrite1: fromHex(SESSION_B.write1),
    connectWrite2: fromHex(SESSION_B.write2),
  });

  assert.deepEqual(transport.writes, [SESSION_B.write1, SESSION_B.write2]);
});

test('start charging writes the constant frame and acks each status', async () => {
  const transport = new ScriptedTransport([
    SESSION_A.notify1,
    SESSION_A.notify2,
    START_ACK,
    STATUS_1,
    STATUS_2,
  ]);
  const session = new PileSession(transport);
  await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });

  const status = await session.startCharging();

  assert.deepEqual(transport.writes, [
    SESSION_A.write1,
    SESSION_A.write2,
    toHex(START_CHARGE_FRAME),
    toHex(STATUS_ACK_FRAME),
    toHex(STATUS_ACK_FRAME),
  ]);
  assert.equal(status.length, 2);
  assert.equal(status[0]!.class, 5);
});

test('a single status frame is enough', async () => {
  const transport = new ScriptedTransport([SESSION_A.notify1, SESSION_A.notify2, START_ACK, STATUS_1]);
  const session = new PileSession(transport);
  await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });

  const status = await session.startCharging();
  assert.equal(status.length, 1);
});

test('start charging is refused before the handshake', async () => {
  const transport = new ScriptedTransport([]);
  const session = new PileSession(transport);
  await assert.rejects(() => session.startCharging(), /requires a completed handshake/);
});

test('wrong notify class is rejected rather than accepted blindly', async () => {
  const transport = new ScriptedTransport(['694a000a010200160f00eeee1711']);
  const session = new PileSession(transport);
  await assert.rejects(
    () =>
      session.connect({
        connectWrite1: fromHex(SESSION_A.write1),
        connectWrite2: fromHex(SESSION_A.write2),
      }),
    /expected class 1, got 2/,
  );
});

test('a corrupted notification is rejected', async () => {
  const broken = fromHex(SESSION_A.notify1);
  broken[broken.length - 1] = (broken[broken.length - 1]! ^ 0xff) & 0xff;
  const transport = new ScriptedTransport([toHex(broken)]);
  const session = new PileSession(transport);
  await assert.rejects(
    () =>
      session.connect({
        connectWrite1: fromHex(SESSION_A.write1),
        connectWrite2: fromHex(SESSION_A.write2),
      }),
    /undecodable frame/,
  );
});

test('a command ack with an unknown payload byte is rejected', async () => {
  // Real ack for command 3 is 7f03050052…; flip the status byte to 0x07.
  const transport = new ScriptedTransport([
    SESSION_A.notify1,
    SESSION_A.notify2,
    '7f03050752afa29bd5a9',
    STATUS_1,
  ]);
  const session = new PileSession(transport);
  await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });
  await assert.rejects(() => session.startCharging(), /unexpected command ack payload/);
});

test('an accepted command with no status report still counts as success', async () => {
  // Real pile, 2026-11-14: ack 02 with verdict 00 arrived, charging started, but
  // no status report came within the window. This must NOT be reported as a
  // failure -- the 0x7f verdict is the success criterion, status is async.
  const transport = new ScriptedTransport([SESSION_A.notify1, SESSION_A.notify2, START_ACK]);
  const session = new PileSession(transport);
  await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });
  const status = await session.startCharging(600);
  assert.deepEqual(status, []);
});

test('a rejection (verdict 01) reports the refusal, not a timeout', async () => {
  const transport = new ScriptedTransport([
    SESSION_A.notify1,
    SESSION_A.notify2,
    // Same ack shape, first data byte 01 instead of 00.
    rejectionAck(),
  ]);
  const session = new PileSession(transport);
  await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });
  await assert.rejects(() => session.startCharging(), /桩拒绝了命令/);
});

test('stop charging sends command 4 and answers the status report', async () => {
  const transport = new ScriptedTransport([SESSION_A.notify1, SESSION_A.notify2, STOP_ACK, STATUS_2]);
  const session = new PileSession(transport);
  await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });
  const status = await session.stopCharging();
  assert.deepEqual(transport.writes, [
    SESSION_A.write1,
    SESSION_A.write2,
    toHex(STOP_CHARGE_FRAME),
    toHex(STATUS_ACK_FRAME),
  ]);
  assert.equal(status.length, 1);
});

test('connect cannot run twice', async () => {
  const transport = new ScriptedTransport([SESSION_A.notify1, SESSION_A.notify2]);
  const session = new PileSession(transport);
  await session.connect({
    connectWrite1: fromHex(SESSION_A.write1),
    connectWrite2: fromHex(SESSION_A.write2),
  });
  await assert.rejects(
    () =>
      session.connect({
        connectWrite1: fromHex(SESSION_A.write1),
        connectWrite2: fromHex(SESSION_A.write2),
      }),
    /already completed/,
  );
});

test('a transport that never notifies surfaces the timeout path', async () => {
  const transport: PileTransport = {
    async write() {},
    async nextNotification() {
      throw new PileSessionError('timeout');
    },
  };
  const session = new PileSession(transport);
  await assert.rejects(
    () => session.connect({ connectWrite1: fromHex(SESSION_A.write1), connectWrite2: fromHex(SESSION_A.write2) }),
    /timeout/,
  );
});
test('generated handshake frames are well-formed and pile-shaped', async () => {
  const { generateHandshakeMaterial } = await import('../packages/protocol/src/pile-session.ts');
  const material = generateHandshakeMaterial();
  const w1 = parse(material.connectWrite1);
  const w2 = parse(material.connectWrite2);
  assert.equal(w1.class, 1);
  assert.equal(w1.payload.length, 9);
  assert.equal(w1.payload[0], 0xff);
  assert.equal(w2.class, 2);
  assert.equal(w2.payload.length, 16);
  assert.equal(w2.payload[15], 0x84);
});

test('two generated handshakes differ (random payloads)', async () => {
  const { generateHandshakeMaterial } = await import('../packages/protocol/src/pile-session.ts');
  const a = generateHandshakeMaterial();
  const b = generateHandshakeMaterial();
  assert.notDeepEqual([...a.connectWrite1], [...b.connectWrite1]);
  assert.notDeepEqual([...a.connectWrite2], [...b.connectWrite2]);
});

test('a generated handshake drives the state machine end to end', async () => {
  const { generateHandshakeMaterial } = await import('../packages/protocol/src/pile-session.ts');
  const transport = new ScriptedTransport([SESSION_A.notify1, SESSION_A.notify2]);
  const session = new PileSession(transport);
  await session.connect(generateHandshakeMaterial());
  assert.equal(transport.writes.length, 2);
});
