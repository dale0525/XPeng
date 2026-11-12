import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProximity, type ProximityConfig } from '../packages/protocol/src/proximity.ts';

const cfg: ProximityConfig = { nearRssi: -88, farRssi: -95, enterMs: 3000, leaveMs: 8000, enterSamples: 3, leaveSamples: 3 };
const rssi = [-96, -82, -96, -82, null, null, -96, -96, -82, -82, null, null, -96, -82, -96, -82, -82, null, null, -96, -82, -96, -95, -82];
const samples = rssi.map((r, i) => ({ t: i * 5000, rssi: r }));

test('isolated single -96 round must not trigger lock: 静态时 5s 窗口偶尔漏扫，不能当"车走了"', () => {
  const acts = evaluateProximity(samples, cfg);
  const locks = acts.filter(a => a === 'lock').length;
  assert.equal(locks, 0, `静态未移动却锁了 ${locks} 次：${acts.join(',')}`);
});

test('alternating -82/-96 must not unlock: 单轮最强 RSSI 在两个值间跳，不能算"靠近"', () => {
  const acts = evaluateProximity(samples, cfg);
  const unlocks = acts.filter(a => a === 'unlock').length;
  assert.equal(unlocks, 0, `未真正靠近却解了 ${unlocks} 次：${acts.join(',')}`);
});

// ── 提速档（2026-11-12 用户选定 4.5 s 检测）：窗口 1.5 s，其余判据不变 ──
//
// 决策延迟 = (样本数-1) × 窗口 + 停留时间。窗口是唯一可压的项：
// 5 s × 2 + 3 s = 13 s（实测约 15 s）；1.5 s × 2 + 1.5 s = 4.5 s。
// 硬约束不变：真机静态序列里连续够强最长只有 2 轮，所以必须仍是 3 轮连跑。
const fast: ProximityConfig = { nearRssi: -88, farRssi: -95, enterMs: 1500, leaveMs: 8000, enterSamples: 3, leaveSamples: 3 };

test('4.5 s 档：同样的真机抖动序列仍不误解锁', () => {
  const acts = evaluateProximity(samples.map(s => ({ ...s, t: samples.indexOf(s) * 1500 })), fast);
  assert.equal(acts.filter(a => a === 'unlock').length, 0, `误解锁：${acts.join(',')}`);
});

test('4.5 s 档：同样的真机抖动序列仍不误锁', () => {
  const acts = evaluateProximity(samples.map((s, i) => ({ ...s, t: i * 1500 })), fast);
  assert.equal(acts.filter(a => a === 'lock').length, 0, `误上锁：${acts.join(',')}`);
});

test('4.5 s 档：真正靠近在 4.5 s 内触发，且连续 3 轮仍误判不了抖动', () => {
  // 真实靠近：先空后连续够强。
  const approach = [null, -96, -82, -82, -82, -82];
  const acts = evaluateProximity(approach.map((r, i) => ({ t: i * 1500, rssi: r })), fast);
  assert.deepEqual(acts, ['unlock']);
  const at = 2 * 1500 + 1500;  // 第 3 个够强样本 + 停留窗 = 4.5 s
  assert.ok(at <= 4500, `期望 4.5 s 内触发，实际 ${at} ms`);
});

// ── 2026-11-12 真机走位实测定案：进 -70 / 锁 -92 ──
//
// 用用户实走数据（门边静置7分钟、5米、30米、往返）离线回放：这组参数全程只产生
// 2 次动作（门边解锁、走远闭锁），无反复切换。
// 关键前提：**扫不到不推进任何计时**。若把"扫不到"当"远离"，同一份数据会触发
// 27 次解锁/上锁来回切——门边未扫到比例高达 55~72%，人站着不动也会被判走远。
const walkCfg: ProximityConfig = { nearRssi: -70, farRssi: -92, enterMs: 1500, leaveMs: 8000, enterSamples: 3, leaveSamples: 3 };

test('走位实测序列在 -70/-92 下只产生 2 次动作，不反复切换', () => {
  // 2026-11-12 17:03–17:20 真实样本全集（656 轮，每轮 1.5 s），null = 该轮没扫到。
  // 对应走位：门边静置约 7 分钟 → 5 米 → 走到 30 米 → 30 米停留 → 走回 5 米。
  // 离线回放：-70 进 / -92 锁 全程只有 2 次动作（第 19 轮解锁 -66、第 583 轮闭锁 -97）。
  const realSeq: (number | null)[] = [-85, -91, -78, null, -71, -72, -87, -81, -65, -67, -70, -70, -71, -73, null, -72, -67, -67, null, -66, -66, -81, -67, -64, -65, -60, -60, -60, -60, -73, null, null, -75, -60, -69, -80, -67, null, -57, -60, -61, -60, -65, -65, -65, null, -62, -63, -67, -63, -66, -65, -60, null, -58, -58, null, -62, -61, -62, -60, null, -62, -63, -66, -62, -62, -67, -66, -67, -67, -70, -77, -67, null, null, -63, -73, null, -68, -73, null, -84, null, null, null, null, -65, null, null, null, null, null, -78, -80, -93, null, -84, null, null, null, null, -79, null, null, null, null, null, -79, null, null, null, null, -81, null, null, null, -81, null, null, null, null, -80, null, null, -80, null, null, null, -78, null, null, -68, null, -70, null, -69, -67, null, -72, -67, null, -71, null, null, -72, -66, -72, -66, null, null, -69, null, null, null, null, null, -67, null, null, -67, null, -66, null, null, null, null, null, -69, null, null, -70, -76, -68, -74, null, null, -71, null, -69, -96, null, -86, -88, null, null, -88, null, -85, null, null, -70, null, null, -72, null, null, -68, -81, null, -71, null, null, null, null, -73, -73, null, -72, -79, null, -71, -65, null, null, -70, null, null, null, null, -78, null, null, null, null, null, -84, null, -76, null, null, -83, null, null, -91, -86, null, null, null, null, -78, -83, null, -94, null, null, -80, null, -82, -86, null, -85, null, null, -84, null, null, -82, null, null, null, null, null, -77, -85, null, null, -92, -77, null, null, null, -91, null, -82, -77, null, -74, null, null, -73, -78, -73, -79, null, -84, -80, null, null, null, null, null, null, null, null, null, -82, null, -82, null, -77, -80, null, -78, -80, -82, null, null, -80, -79, -86, null, -96, -81, -85, -84, null, null, -82, -80, -78, -77, null, -78, -80, null, -67, -72, -87, null, -77, -91, null, -94, -72, -74, null, -73, null, null, null, -73, -77, -77, null, -77, null, -94, -77, -91, null, null, -94, -73, -72, -93, -73, null, -73, -78, -77, -78, null, -77, -94, -93, null, null, -74, -73, -73, -74, -73, -73, null, -73, -73, -77, null, -77, null, null, -77, -77, -92, -97, -71, null, -76, -72, null, -73, -81, -75, -76, -72, -76, null, -76, -76, null, -76, -75, null, null, null, -93, -78, -80, -83, -77, -75, -78, -72, -72, null, -73, null, null, -94, -87, -74, null, -92, -72, -90, -75, -72, -95, -72, -72, -76, -72, -75, -75, -73, -87, -74, -76, -100, null, -90, null, null, -83, -92, -73, -86, -72, -78, -71, null, -72, -74, null, null, -75, -75, -99, -75, null, -100, -71, -98, -97, -72, -72, -72, -72, -76, -76, -74, -75, null, null, -75, -75, -86, null, null, -96, null, -94, null, -72, null, null, -73, -73, -76, null, -76, -76, null, null, -94, -93, null, -76, -94, -94, -72, -94, -93, -73, null, -72, null, null, null, -93, null, -72, -95, -72, null, null, -72, null, null, null, -93, null, null, -94, null, null, -78, -77, -74, null, null, -72, -72, -71, null, -71, -71, -76, -72, -72, -76, null, -76, -76, null, null, -83, -72, null, -72, -84, -75, null, null, -82, null, -91, null, null, -97, null, null, null, null, null, null, null, null, null, null, -100, null, null, null, null, null, null, null, null, null, null, null, -97, null, null, null, null, null, null, -96, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, -99, null, null, null, null, null, -98, -87, null, -92, -91, -85, -91, null, -73, -75, -73, null, null, null, -73, -73, -83, -83, null, -84, -82, null, -82, -87, null, -73, -87, -74, -73, null, null, -74, -75, -82, -75, null, -82, -83, -82, -82, -84, null, -84, -84];
  const acts = evaluateProximity(realSeq.map((r, i) => ({ t: i * 1500, rssi: r })), walkCfg);
  assert.equal(acts.filter(a => a === 'unlock').length, 1, `解锁次数不对: ${acts.join(',')}`);
  assert.equal(acts.filter(a => a === 'lock').length, 1, `闭锁次数不对: ${acts.join(',')}`);
});

test('扫不到不得被当成"远离"：门边站着不动不能上锁', () => {
  // 门边真实片段：强信号中夹杂大量扫不到（实测未扫到 55~72%）
  const seq: (number | null)[] = [-66, null, null, -68, null, null, null, -70, null, null, -67, null, null, -72];
  const acts = evaluateProximity(seq.map((r, i) => ({ t: i * 1500, rssi: r })), walkCfg);
  assert.equal(acts.filter(a => a === 'lock').length, 0, `站着不动被上锁了: ${acts.join(',')}`);
});
