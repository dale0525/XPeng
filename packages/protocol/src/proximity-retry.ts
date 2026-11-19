/**
 * 解/闭锁动作失败后的重试决策（纯逻辑）。
 *
 * 2026-11-12 真车实测驱动的修复：用户走到 50 m 外触发闭锁，两次都失败
 * （`BLE operation timeout` 等了 10 s、`GATT disconnected: 133`），而状态机
 * 已把 `nearby` 置 false，于是**不再重试**。用户看到的现象是「只解锁、从不闭锁」
 * ——不是没触发，是失败后放弃了。
 *
 * 闭锁天然发生在最不利的时刻：人正走远、信号最弱、还连着车内 WiFi。
 * 一次失败就放弃，等于这个功能在真实场景里几乎不成立。
 */
export interface RetryPolicy {
  /** 最多重试几次（不含首次尝试）。attempt 从 1 开始，超过它就放弃。 */
  maxAttempts: number;
  /** 首次重试等待；之后按倍数退避。 */
  baseDelayMs: number;
  /** 退避倍数。 */
  backoff: number;
  /** 单次重试等待的上限，避免退避到用户已经走远。 */
  maxDelayMs: number;
}

export const RETRY_POLICY: RetryPolicy = {
  // 实测一次失败要耗 10 s（timeout）或数秒（133），3 次重试已够覆盖走远的窗口；
  // 再多就是拿蓝牙反复撞墙，还和下一次靠近的建连抢控制器。
  maxAttempts: 3,
  baseDelayMs: 5_000,
  backoff: 2,
  maxDelayMs: 30_000,
};

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; giveUp: boolean; abandonReason?: 'exhausted' | 'now-nearby' | 'succeeded' };

export function decideRetry(input: {
  action: 'unlock' | 'lock';
  failed: boolean;
  /** 第几次尝试（1 = 首次失败后的第一次重试）。 */
  attempt: number;
  policy?: RetryPolicy;
}): RetryDecision {
  if (!input.failed) return { retry: false, giveUp: false, abandonReason: 'succeeded' };
  const policy = input.policy ?? RETRY_POLICY;
  // 原先这里用判距器的"是否在附近"判断"人又回车里了吗，别把他锁在车边"。
  // 该判据已废除：它读的是车锁状态的代理值，"车锁着"既可能是人站在车旁、
  // 也可能是人已走远，"车开着"也可能只是刚解锁——两个方向都对不上"人在物理上
  // 是否贴着车"。而且重试期间扫描本就停着，根本没有实时信号可用。
  // 因此这里只按重试次数退避：这个"防把人锁在车边"的保护目前没有可靠输入，
  // 属于已知缺口（见文档），不在数据不可靠时假装有保护。
  // attempt 是"第几次重试"，1 起算；超过上限才放弃。用 > 而不是 >=：
  // 用 >= 会让 maxAttempts=3 只剩 2 次重试，且第 3 次拿不到 delayMs。
  if (input.attempt > policy.maxAttempts) return { retry: false, giveUp: true, abandonReason: 'exhausted' };
  const raw = policy.baseDelayMs * Math.pow(policy.backoff, Math.max(0, input.attempt - 1));
  return { retry: true, delayMs: Math.min(raw, policy.maxDelayMs) };
}
