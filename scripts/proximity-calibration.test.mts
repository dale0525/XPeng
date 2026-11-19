import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAR_HYSTERESIS_DB, MIN_CALIBRATION_SAMPLES, aggregateRssi, buildCalibration, buildCalibrationFromMedian, isValidCalibration, parseCalibration, parseManualThresholds, serializeCalibration, type ProximityCalibration } from '../packages/protocol/src/proximity-calibration.ts';

test('android sometimes reports 0 or positive as "no reading"; those are excluded', () => {
  const { mean, count } = aggregateRssi([-80, 0, 12, -90, null, undefined, -85]);
  assert.equal(count, 3);
  assert.equal(mean, (-80 - 90 - 85) / 3);
});

test('mean of a steady reading set is the calibration target', () => {
  const { mean } = aggregateRssi([-80, -82, -84]);
  assert.equal(mean, -82);
});

test('buildCalibration rounds the mean and derives a weaker far threshold', () => {
  const r = buildCalibration([-81, -84], new Date('2026-11-12T09:00:00Z'));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.calibration.nearRssi, -82);          // (-81 + -84) / 2 = -82.5 → Math.round → -82
  assert.equal(r.calibration.farRssi, -82 - FAR_HYSTERESIS_DB);
  assert.equal(r.calibration.sampleCount, 2);
  assert.equal(r.calibration.calibratedAt, '2026-11-12T09:00:00.000Z');
});

test('no valid samples fails instead of producing a bogus threshold', () => {
  assert.deepEqual(buildCalibration([0, 5, null]), { ok: false, reason: 'no-samples', count: 0 });
});

test('a single sample is rejected as too few to be trustworthy', () => {
  const r = buildCalibration([-80]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'too-few-samples');
  assert.equal(r.count, 1);
  assert.ok(MIN_CALIBRATION_SAMPLES > 1);
});

test('roundtrip survives serialize/parse', () => {
  const cal: ProximityCalibration = { nearRssi: -83, farRssi: -90, sampleCount: 5, calibratedAt: '2026-11-12T09:00:00.000Z' };
  assert.deepEqual(parseCalibration(serializeCalibration(cal)), cal);
});

test('garbage or inconsistent stored values are rejected, not silently used', () => {
  assert.equal(parseCalibration('not json'), null);
  assert.equal(parseCalibration('null'), null);
  assert.equal(parseCalibration(null), null);
  // farRssi 必须比 nearRssi 更弱；写反了就是坏数据。
  assert.equal(isValidCalibration({ nearRssi: -90, farRssi: -80, sampleCount: 3, calibratedAt: 'x' }), false);
  // nearRssi 正值（Android 无读数）不是合法阈值。
  assert.equal(isValidCalibration({ nearRssi: 0, farRssi: -7, sampleCount: 3, calibratedAt: 'x' }), false);
});

// ── 2026-11-12 改口径：用"最强值"而不是"平均值"作基准 ──
//
// 真机实测（门边静置 75 个有效样本）：均值 -68.5，但**最强 -57**、中位 -67。
// 均值会被多径反射的弱样本拉低；最强值才是"手机贴在车门上"这个物理状态的近似。
// 用户 2026-11-12 明确要求：标定时只计算最强信号值，再据此推导参数。

// ── 2026-11-12 定案：中位数 + 15 dB 滞回 ──
//
// 上一版用"采样窗口内取最大值"，实机暴露两个问题：
// 1) 采样只 12 秒 / 7 个样本，max 系统性偏高（得 -61，而门边 149 样本的 p90 才 -62）；
// 2) 闭锁只减 7 dB（-68），而门边信号 p10 已到 -85，站着不动也会被误判"走远"而锁车。
// 改为：进入阈值取中位数（抗多径、抗单次强值），闭锁 = 进入 - 15 dB。

// ── 现行口径（2026-11-19 定案）：解锁 = 采样中位数，闭锁 = 解锁 - 15 ──
//
// 偏移量演进：-12（初版）→ -5（按体感调）→ -20（2026-11-15）→ 0（2026-11-19）。
// 归零的原因：站位语义改成「站到你希望解锁的那个位置」，采样点就是期望触发点，
// 中位数本身即阈值。若仍减 20，站 3 米采到 -75 会算出 -95，要走到 20 米外才解锁。

test('解锁 = 采样中位数本身，闭锁 = 解锁 - 15（中位 -56 → -56/-71）', () => {
  // 用户第二次标定的真实 30 秒样本（-56/-57 为主，中位数 -56）
  const samples = [-56, -56, -56, -57, -57, -58, -56, -57, -56];
  const r = buildCalibrationFromMedian(samples);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.calibration.nearRssi, -56, '解锁应等于中位数');
    assert.equal(r.calibration.farRssi, -71, '闭锁应为 解锁-15');
  }
});

test('站位不同得到不同阈值（正是「站到你希望解锁的位置」的意义）', () => {
  const samples = [-71, -72, -70, -71, -73];
  const r = buildCalibrationFromMedian(samples);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.calibration.nearRssi, -71);
    assert.equal(r.calibration.farRssi, -86);
  }
});

test('中位数标定对异常值免疫', () => {
  const r = buildCalibrationFromMedian([-70, -72, -20, -71, -69]);
  assert.equal(r.ok, true);
  // 中位 -70（-20 被中位数天然忽略）
  if (r.ok) assert.equal(r.calibration.nearRssi, -70, '单条 -20 不应影响中位数');
});

test('中位数标定样本不足时拒绝', () => {
  assert.equal(buildCalibrationFromMedian([-60]).ok, false);
  assert.equal(buildCalibrationFromMedian([]).ok, false);
});

// ── 手动修改阈值（2026-11-19 起只填解锁值，闭锁值自动减 15）──

test('手动输入只填解锁值：填 75 得 -75，闭锁自动 -90', () => {
  const r = parseManualThresholds('75');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.calibration.nearRssi, -75);
    assert.equal(r.calibration.farRssi, -90);
  }
});

test('手动输入容忍前导负号与空白', () => {
  const r = parseManualThresholds(' -69 ');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.calibration.nearRssi, -69);
    assert.equal(r.calibration.farRssi, -84);
  }
});

test('手动输入拒绝空值与越界', () => {
  assert.equal(parseManualThresholds('').ok, false);
  assert.equal(parseManualThresholds('0').ok, false);
  assert.equal(parseManualThresholds('200').ok, false);
});
