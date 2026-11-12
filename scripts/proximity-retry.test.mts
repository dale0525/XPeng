/**
 * 闭锁失败重试（2026-11-12 真车实测驱动）。
 *
 * 故障：走到 50 m 外触发闭锁，两次都失败（`BLE operation timeout` 10 s、
 * `GATT disconnected: 133`），而状态机已把 nearby 置 false，于是不再重试。
 * 用户看到的现象是"只解锁、从不闭锁"——不是没触发，是失败后放弃了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRetry, RETRY_POLICY } from '../packages/protocol/src/proximity-retry.ts';

test('失败的闭锁必须重试，而不是放弃', () => {
  const d = decideRetry({ action: 'lock', failed: true, attempt: 1 });
  assert.equal(d.retry, true);
  assert.ok(d.delayMs > 0, '要给出等待时长，不能立即猛冲');
});

test('解锁失败也要重试：人站在门边，下一次靠近不该被吞掉', () => {
  assert.equal(decideRetry({ action: 'unlock', failed: true, attempt: 1 }).retry, true);
});

test('重试有上限，不能无限占用蓝牙', () => {
  // attempt 从 1 起算，等于上限时仍是最后一次重试，超过才放弃。
  const last = decideRetry({ action: 'lock', failed: true, attempt: RETRY_POLICY.maxAttempts });
  assert.equal(last.retry, true, '第 maxAttempts 次重试应当执行');
  const over = decideRetry({ action: 'lock', failed: true, attempt: RETRY_POLICY.maxAttempts + 1 });
  assert.equal(over.retry, false);
  assert.equal(over.giveUp, true);
});

test('重试间隔递增（退避），避免连续撞同一个失败窗口', () => {
  const a1 = decideRetry({ action: 'lock', failed: true, attempt: 1 }).delayMs;
  const a2 = decideRetry({ action: 'lock', failed: true, attempt: 2 }).delayMs;
  const a3 = decideRetry({ action: 'lock', failed: true, attempt: 3 }).delayMs;
  assert.ok(a2 > a1 && a3 > a2, `退避不成立: ${a1}, ${a2}, ${a3}`);
});

test('成功就不重试', () => {
  assert.equal(decideRetry({ action: 'lock', failed: false, attempt: 1 }).retry, false);
});

test('重试期间信号已变好（人又回来了）应放弃闭锁，避免人站在车边被锁', () => {
  const d = decideRetry({ action: 'lock', failed: true, attempt: 1, nowNearby: true });
  assert.equal(d.retry, false);
  assert.equal(d.abandonReason, 'now-nearby');
});
