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
  /** 解锁阈值：采样平均值。 */
  nearRssi: number;
  /** 闭锁阈值：比 nearRssi 更弱，留出滞回带避免临界抖动。 */
  farRssi: number;
  /** 采样到的有效条数。 */
  sampleCount: number;
  /** 标定时间（ISO 字符串），仅用于展示与判断新旧。 */
  calibratedAt: string;
}

/** 进入/离开两个阈值之间留出的滞回带宽（dB）。 */
export const FAR_HYSTERESIS_DB = 7;
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
      farRssi: nearRssi - FAR_HYSTERESIS_DB,
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
    && typeof c.farRssi === 'number' && Number.isFinite(c.farRssi)
    && c.farRssi < c.nearRssi
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
 * 标定：进入阈值取**中位数**，闭锁 = 进入 - `CALIBRATION_HYSTERESIS_DB`。
 *
 * 2026-11-12 实机暴露上一版（窗口内取最大值）的两个问题：
 * 1. 采样窗口只 12 秒 / 7 个样本，max 系统性偏高——实得 -61，而门边 149 个样本的
 *    p90 才 -62、中位 -71。拿 12 秒的最强值当"贴脸强度"，阈值会定得过松。
 * 2. 闭锁只减 7 dB（-68），而门边信号 p10 已到 -85：人站着不动，信号一抖就被判
 *    "走远"而锁车。
 *
 * 中位数的好处：抗多径弱值（不像均值被 -96 拉低），也抗单次强值（不像 max 被
 * -57 带飞）。门边实测中位 -71，与实际体感最接近。
 */
export const CALIBRATION_HYSTERESIS_DB = 15;

/**
 * 解锁阈值相对采样中位数的偏移。
 *
 * 用户 2026-11-12 最终定案：标定时把手机放在**主驾门把手旁**，解锁值取中位数 -5 dB。
 * 演进：先定 -12（中位 -57 → -69），后按实际体感改为 -5（中位 -57 → -62）。
 *
 * 为什么需要偏移而不是直接用中位数：门把手旁是采样时最强的位置，而用户希望
 * "走到车边就解锁"，比贴门把手稍远一点。偏移量由用户按实际体感微调。
 */
export const CALIBRATION_NEAR_OFFSET_DB = 5;

export function buildCalibrationFromMedian(
  samples: ReadonlyArray<number | null | undefined>,
  now: Date = new Date(),
): CalibrationResult {
  const { median, count } = aggregateRssi(samples);
  if (count === 0 || median === null) return { ok: false, reason: 'no-samples', count };
  if (count < MIN_CALIBRATION_SAMPLES) return { ok: false, reason: 'too-few-samples', count };
  const nearRssi = Math.round(median) - CALIBRATION_NEAR_OFFSET_DB;
  return {
    ok: true,
    calibration: {
      nearRssi,
      farRssi: nearRssi - CALIBRATION_HYSTERESIS_DB,
      sampleCount: count,
      calibratedAt: now.toISOString(),
    },
  };
}

/**
 * 手动修改阈值：用户直接填两个正数（如 69、84），界面上不出现负号也不出现 dB。
 *
 * 允许带前导负号只是为了让"粘回来的旧值"仍能解析；正常输入是纯数字。
 * 拒绝解锁不弱于闭锁的组合——那样滞回带为负，状态机会在两条线之间来回跳。
 */
export function parseManualThresholds(
  nearText: string,
  farText: string,
  now: Date = new Date(),
): CalibrationResult | { ok: false; reason: 'invalid' } {
  const parse = (t: string): number | null => {
    const n = Number(t.trim().replace(/^-/, ''));
    if (!Number.isFinite(n) || n <= 0 || n > 120) return null;
    return -Math.round(n);
  };
  const near = parse(nearText);
  const far = parse(farText);
  if (near === null || far === null) return { ok: false, reason: 'invalid' };
  // 解锁必须比闭锁更强（数值更大，因为都是负数）。
  if (near <= far) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    calibration: {
      nearRssi: near,
      farRssi: far,
      sampleCount: 0,
      calibratedAt: now.toISOString(),
    },
  };
}
