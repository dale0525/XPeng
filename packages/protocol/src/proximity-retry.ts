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
  /** 当前判距是否已回到「附近」。闭锁重试时若人又回来了，不能把他锁在车边。 */
  nowNearby?: boolean;
  policy?: RetryPolicy;
}): RetryDecision {
  if (!input.failed) return { retry: false, giveUp: false, abandonReason: 'succeeded' };
  const policy = input.policy ?? RETRY_POLICY;
  // 人又回到车边：这次闭锁的前提已经不存在了，继续重试会把人锁在车旁。
  if (input.action === 'lock' && input.nowNearby) {
    return { retry: false, giveUp: false, abandonReason: 'now-nearby' };
  }
  // attempt 是"第几次重试"，1 起算；超过上限才放弃。用 > 而不是 >=：
  // 用 >= 会让 maxAttempts=3 只剩 2 次重试，且第 3 次拿不到 delayMs。
  if (input.attempt > policy.maxAttempts) return { retry: false, giveUp: true, abandonReason: 'exhausted' };
  const raw = policy.baseDelayMs * Math.pow(policy.backoff, Math.max(0, input.attempt - 1));
  return { retry: true, delayMs: Math.min(raw, policy.maxDelayMs) };
}
