import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateProximity, ProximityTracker, decideScanAction, decideScanDuringAction, DEFAULT_PROXIMITY_CONFIG, type ProximityConfig,
} from '../packages/protocol/src/proximity.ts';

const cfg: ProximityConfig = { nearRssi: -65, farRssi: -80, enterMs: 3000, leaveMs: 8000 };

test('a single strong sample does not unlock before the enter dwell time', () => {
  const t = 0;
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 1000, rssi: -50 },
    { t: t + 2000, rssi: -50 },
  ], cfg), []);
});

test('unlocks once RSSI stays above nearRssi for the enter dwell', () => {
  const t = 0;
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 3000, rssi: -55 },
  ], cfg), ['unlock']);
});

test('a brief pass-by never unlocks, and does not lock on the way out', () => {
  const t = 0;
  // 靠近 1.5s 又离开：不满足 3s 进入停留，也不产生 lock（从未进入 nearby）。
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 1500, rssi: -50 },
    { t: t + 3000, rssi: -90 },
    { t: t + 20000, rssi: -95 },
  ], cfg), []);
});

test('locks only after being nearby then far for the leave dwell', () => {
  const t = 0;
  const samples = [
    { t, rssi: -50 },
    { t: t + 3000, rssi: -50 },        // unlock
    { t: t + 4000, rssi: -90 },
    { t: t + 12000, rssi: -90 },       // 8s 后 lock
  ];
  assert.deepEqual(evaluateProximity(samples, cfg), ['unlock', 'lock']);
});

test('does not lock when the car is merely out of scan range for less than leaveMs', () => {
  const t = 0;
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 3000, rssi: -50 },        // unlock
    { t: t + 4000, rssi: null },       // 短暂扫不到
    { t: t + 9000, rssi: -55 },        // 又回来了（间隔 5s < leaveMs 8s）
  ], cfg), ['unlock']);
});

test('hysteresis: RSSI between the two thresholds does not flap state', () => {
  const t = 0;
  // 进入后 RSSI 落在 (-80, -65) 之间，既不算离开也不算重新进入，不产生额外动作。
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 3000, rssi: -50 },        // unlock
    { t: t + 4000, rssi: -70 },
    { t: t + 20000, rssi: -72 },
  ], cfg), ['unlock']);
});

test('tracker emits exactly one action per transition across many samples', () => {
  const tr = new ProximityTracker(cfg);
  const t = 0;
  const seq: Array<{ dt: number; rssi: number | null }> = [
    { dt: 0, rssi: -50 }, { dt: 1000, rssi: -50 }, { dt: 3000, rssi: -50 }, // unlock at 3000
    { dt: 4000, rssi: -60 }, { dt: 5000, rssi: -60 }, // still nearby, no action
    { dt: 7000, rssi: -90 }, { dt: 15000, rssi: -90 }, // lock at 7000+8000
    { dt: 30000, rssi: -90 },
  ];
  const actions: string[] = [];
  for (const s of seq) {
    const a = tr.push(t + s.dt, s.rssi);
    if (a) actions.push(a);
  }
  assert.deepEqual(actions, ['unlock', 'lock']);
});

test('default config has near stronger than far', () => {
  assert.ok(DEFAULT_PROXIMITY_CONFIG.nearRssi > DEFAULT_PROXIMITY_CONFIG.farRssi);
  assert.ok(DEFAULT_PROXIMITY_CONFIG.leaveMs > DEFAULT_PROXIMITY_CONFIG.enterMs);
});

const bg = { enabled: true, scanRunning: false, hasTarget: true, foreground: false };

test('enabling in background starts a scan even when the switch flag was already on', () => {
  // 缺陷版：按「开关没变」早退 → 这里返回 none，扫描永不启动。
  assert.equal(decideScanAction(bg), 'start');
});

test('enabling twice does not start two scans', () => {
  assert.equal(decideScanAction({ ...bg, scanRunning: true }), 'none');
});

test('disabling stops a running scan, and is a no-op when nothing runs', () => {
  assert.equal(decideScanAction({ ...bg, enabled: false, scanRunning: true }), 'stop');
  assert.equal(decideScanAction({ ...bg, enabled: false, hasTarget: false }), 'none');
});

test('enabled without a vehicle target waits instead of starting', () => {
  assert.equal(decideScanAction({ ...bg, hasTarget: false }), 'none');
});

test('foreground never scans: the car stops advertising while connected', () => {
  // 实测：持有 GATT 连接时连续 20 轮 results=0，释放连接后立刻扫到。
  assert.equal(decideScanAction({ ...bg, foreground: true }), 'none');
  assert.equal(decideScanAction({ ...bg, foreground: true, scanRunning: true }), 'stop');
});

test('scan resumes after the action only when it should still be running', () => {
  const base = { enabled: true, foreground: false, hasMac: true };
  assert.equal(decideScanDuringAction(base), 'resume');
  // 动作期间用户把开关关了 / 回到前台 / 没有车 MAC，都不该再起扫描。
  assert.equal(decideScanDuringAction({ ...base, enabled: false }), 'stay-stopped');
  assert.equal(decideScanDuringAction({ ...base, foreground: true }), 'stay-stopped');
  assert.equal(decideScanDuringAction({ ...base, hasMac: false }), 'stay-stopped');
});
