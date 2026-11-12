/**
 * 直线召唤会话状态机的契约（2026-11-06 至 11-07 真车 HCI 抓包驱动）。
 *
 * 故障背景：`summon.ts` 只能写单帧心跳、且把 `activated` 恒置 false，
 * 于是「按住向前」只发出 1 帧、车辆也不会进入召唤态。
 * 抓包结论：进入召唤 = 一条指令码 0x03 的 V2 车控帧；随后持续写
 * `ef 03 02 <mode> <counter>`（待机 00 / 前进 01 / 后退 02 / 退出 07），
 * 节奏约 150 ms；退出是 0x07 连发 5 帧。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RPA_EXIT_FRAME_COUNT,
  RPA_HEARTBEAT_INTERVAL_MS,
  RpaSession,
  type RpaSessionIo,
} from '../apps/mobile/src/core/summon-session.ts';
import { toHex } from '../packages/protocol/src/bytes.ts';

/** 让排队的写真正落进 frames。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeIo implements RpaSessionIo {
  frames: string[] = [];
  activations = 0;
  interval = 0;
  notices: string[] = [];
  activateError: Error | undefined;
  writeError: Error | undefined;
  private tick: (() => void) | null = null;

  activate = async () => {
    this.activations++;
    if (this.activateError) throw this.activateError;
  };

  write = async (frame: Uint8Array) => {
    this.frames.push(toHex(frame));
    if (this.writeError) throw this.writeError;
  };

  delays: number[] = [];

  delay = async (ms: number) => { this.delays.push(ms); };

  startTicker = (everyMs: number, tick: () => void) => {
    this.interval = everyMs;
    this.tick = tick;
    return () => { this.tick = null; };
  };

  onInterrupted = (message: string) => { this.notices.push(message); };

  /** 心跳是串行写的：一次触发只排队一帧，落盘要等微任务。 */
  async beat(times: number) {
    for (let i = 0; i < times; i++) {
      this.tick?.();
      await flush();
    }
  }

  get ticking(): boolean { return this.tick !== null; }
}

test('entering activates the session once and then beats idle frames', async () => {
  const io = new FakeIo();
  const session = new RpaSession(io);

  await session.enter();

  assert.equal(io.activations, 1);
  assert.equal(io.interval, RPA_HEARTBEAT_INTERVAL_MS);
  assert.equal(session.active, true);
  await io.beat(3);
  assert.deepEqual(io.frames, ['ef03020000', 'ef03020001', 'ef03020002']);
});

test('a rejected activation leaves the session inactive and starts no heartbeat', async () => {
  const io = new FakeIo();
  io.activateError = new Error('BLE acknowledgement code: 403');
  const session = new RpaSession(io);

  await assert.rejects(() => session.enter(), /403/);

  assert.equal(session.active, false);
  assert.equal(io.ticking, false);
  assert.deepEqual(io.frames, []);
});

test('holding a direction switches the mode byte without a second activation', async () => {
  const io = new FakeIo();
  const session = new RpaSession(io);
  await session.enter();
  await io.beat(1);

  await session.move('forward');
  await io.beat(2);
  await session.move('backward');
  await io.beat(1);
  await session.halt();
  await io.beat(1);

  assert.equal(io.activations, 1);
  assert.deepEqual(io.frames, [
    'ef03020000',
    'ef03020101', // move 立即写一帧
    'ef03020102',
    'ef03020103',
    'ef03020204', // 后退立即写一帧
    'ef03020205',
    'ef03020006', // halt 立即回到待机
    'ef03020007',
  ]);
});

test('a direction cannot be taken before the session is active', async () => {
  const session = new RpaSession(new FakeIo());
  await assert.rejects(() => session.move('forward'), /未激活/);
});

test('exiting stops the heartbeat and sends the exit burst', async () => {
  const io = new FakeIo();
  const session = new RpaSession(io);
  await session.enter();
  await io.beat(1);

  await session.exit();

  assert.equal(session.active, false);
  assert.equal(io.ticking, false);
  assert.equal(io.frames.length, 1 + RPA_EXIT_FRAME_COUNT);
  // 退出帧不能挤在一次事件里连发：抓包 5 帧跨约 565 ms。
  assert.equal(io.delays.length, RPA_EXIT_FRAME_COUNT - 1);
  assert.deepEqual(io.delays, Array(RPA_EXIT_FRAME_COUNT - 1).fill(RPA_HEARTBEAT_INTERVAL_MS));
  assert.deepEqual(io.frames.slice(1), ['ef03020701', 'ef03020702', 'ef03020703', 'ef03020704', 'ef03020705']);
  assert.equal(io.activations, 1);
});

test('a failed heartbeat write stops the loop and reports the interruption', async () => {
  const io = new FakeIo();
  const session = new RpaSession(io);
  await session.enter();
  io.writeError = new Error('E_NOT_READY BLE not subscribed');

  await io.beat(1);
  await Promise.resolve();

  assert.equal(io.ticking, false);
  assert.deepEqual(io.notices, ['心跳中断：E_NOT_READY BLE not subscribed']);
});

test('the 7-bit counter wraps from 0x7f back to 0x00', async () => {
  const io = new FakeIo();
  const session = new RpaSession(io);
  await session.enter();
  await io.beat(129);
  assert.equal(io.frames[126], 'ef0302007e');
  assert.equal(io.frames[127], 'ef0302007f');
  assert.equal(io.frames[128], 'ef03020000');
});
