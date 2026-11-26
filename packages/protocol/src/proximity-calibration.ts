/**
 * 靠近解闭锁的「就地标定」：在用户希望自动解锁的那个距离静置几秒，采几次 RSSI
 * 取平均，作为该手机该环境下的解锁阈值。
 *
 * 为什么必须有这一步：车端广播的 RSSI 受手机型号、壳体、握持、环境反射影响，绝对值
 * 跨设备能差十几个 dB。2026-11-12 真车实测同一位置读到 -83…-90，而先前拍脑袋定的
 * -65 会让「近在眼前」被判成「很远」。只有让用户在真实位置采一次，阈值才站得住。
 *
 * 纯函数，不碰蓝牙与存储，便于单测；采样动作本身在 ble.ts 里做。
 */
export interface ProximityCalibration {
  /**
   * 唯一的判距阈值：采样中位数，不做任何漂移补偿。
   *
   * 解闭锁共用它（见 proximity.ts 的 push）：比它强就解锁方向、比它弱就闭锁方向。
   * 从前这里还有一个 `farRssi`（解锁值减滞回带），2026-11-26 起取消——闭锁阈值不是
   * 用户能表达的东西，派生出来的那个数只会让两处判定渐渐对不上。
   */
  nearRssi: number;
  /** 采样到的有效条数。 */
  sampleCount: number;
  /** 标定时间（ISO 字符串），仅用于展示与判断新旧。 */
  calibratedAt: string;
}

/** 至少要有几条有效样本才算数，一条太容易被单次抖动带偏。 */
export const MIN_CALIBRATION_SAMPLES = 2;

export function aggregateRssi(samples: ReadonlyArray<number | null | undefined>): {
  mean: number | null; median: number | null; count: number; used: number[];
} {
  // Android 在拿不到有效强度时会回 0 或正值，这类不是真实 dBm，必须剔除，
  // 否则会把平均值往 0 拉、阈值被抬得过松。
  const used = samples.filter((v): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v < 0 && v >= -120);
  if (used.length === 0) return { mean: null, median: null, count: 0, used: [] };
  const sum = used.reduce((a, b) => a + b, 0);
  const sorted = [...used].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { mean: sum / used.length, median, count: used.length, used };
}

export type CalibrationResult =
  | { ok: true; calibration: ProximityCalibration }
  | { ok: false; reason: 'no-samples' | 'too-few-samples'; count: number };

/** 用采样结果构造标定值；不足样本数直接判失败，不拿一两条凑数。 */
export function buildCalibration(
  samples: ReadonlyArray<number | null | undefined>,
  now: Date = new Date(),
): CalibrationResult {
  const { mean, count } = aggregateRssi(samples);
  if (count === 0 || mean === null) return { ok: false, reason: 'no-samples', count };
  if (count < MIN_CALIBRATION_SAMPLES) return { ok: false, reason: 'too-few-samples', count };
  const nearRssi = Math.round(mean);
  return {
    ok: true,
    calibration: {
      nearRssi,
      sampleCount: count,
      calibratedAt: now.toISOString(),
    },
  };
}

export function isValidCalibration(value: unknown): value is ProximityCalibration {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.nearRssi === 'number' && Number.isFinite(c.nearRssi)
    && c.nearRssi < 0 && c.nearRssi >= -120
    && typeof c.sampleCount === 'number' && c.sampleCount > 0
    && typeof c.calibratedAt === 'string';
}

export function parseCalibration(raw: string | null | undefined): ProximityCalibration | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidCalibration(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeCalibration(calibration: ProximityCalibration): string {
  return JSON.stringify(calibration);
}

/**
 * 标定：阈值取**中位数**，解闭锁共用这一个值。
 *
 * 2026-11-12 实机暴露上一版（窗口内取最大值）的两个问题：
 * 1. 采样窗口只 12 秒 / 7 个样本，max 系统性偏高——实得 -61，而门边 149 个样本的
 *    p90 才 -62、中位 -71。拿 12 秒的最强值当"贴脸强度"，阈值会定得过松。
 * 2. 早期闭锁线只比解锁线弱 7 dB，而门边信号 p10 已到 -85：人站着不动，信号一抖
 *    就被判"走远"而锁车。（现在两侧共用一个阈值，抖动由停留时间与窗口计数挡住。）
 *
 * 中位数的好处：抗多径弱值（不像均值被 -96 拉低），也抗单次强值（不像 max 被
 * -57 带飞）。门边实测中位 -71，与实际体感最接近。
 */
export function buildCalibrationFromMedian(
  samples: ReadonlyArray<number | null | undefined>,
  now: Date = new Date(),
): CalibrationResult {
  const { median, count } = aggregateRssi(samples);
  if (count === 0 || median === null) return { ok: false, reason: 'no-samples', count };
  if (count < MIN_CALIBRATION_SAMPLES) return { ok: false, reason: 'too-few-samples', count };
  // 不做漂移补偿：采到哪个值就用哪个。站位语义已经是「你希望解锁的位置」，
  // 再减一个补偿量等于重复扣减（2026-11-19 归零、2026-11-26 连常量一起删掉）。
  const nearRssi = Math.round(median);
  return {
    ok: true,
    calibration: {
      nearRssi,
      sampleCount: count,
      calibratedAt: now.toISOString(),
    },
  };
}

/**
 * 手动修改解锁阈值：只需填一个正数（如 75），界面上不出现负号也不出现 dB。
 *
 * 只填一个数：解闭锁共用它，用户不必再想闭锁值该填多少。
 * 允许带前导负号只是为了让"粘回来的旧值"仍能解析；正常输入是纯数字。
 */
export function parseManualThresholds(
  nearText: string,
  now: Date = new Date(),
): CalibrationResult | { ok: false; reason: 'invalid' } {
  const n = Number(nearText.trim().replace(/^-/, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 120) return { ok: false, reason: 'invalid' };
  const near = -Math.round(n);
  return {
    ok: true,
    calibration: {
      nearRssi: near,
      sampleCount: 0,
      calibratedAt: now.toISOString(),
    },
  };
}
