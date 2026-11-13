/**
 * 车端状态推送的新鲜度判定。
 *
 * 抽在这里（而不是留在 `apps/mobile/src/core/car.ts`）是因为 car.ts 顶层 import 了
 * React Native——node 下无法加载，规则就没法测。这里只依赖纯数据。
 *
 * 实测（2026-11-14，PILE_DIAG 日志）一次 st=19 查询后的到达顺序：
 *
 *     01:59:59.398  match=true   ttcc=0    查询回执（结束充电后的正确值）
 *     02:00:00.417  match=false  ttcc=0    推送，仍正确
 *     02:00:02.587  match=false  ttcc=331  **3.19 s 后旧快照，把界面盖回「充电中」**
 *
 * 旧快照的 `msg_id` 与更早那次查询的完全一致，是**重放**——下行报文没有时间戳，
 * 无法比较新旧，但同一个 msg_id 再出现一次就明确是旧报文。因此：
 *
 *  1. 查询回执永远采纳（它是权威快照）；
 *  2. 回执到达后开一个窗口，窗口内的推送不采纳（挡住紧跟着的迟到快照）；
 *  3. 同一个 msg_id 只采纳一次（挡住重放，窗口足够长时才生效）。
 *
 * 记录 msg_id 会累积，超过上限就整体清空——这是去重不是历史，丢旧的无妨。
 */
/** 去重集合的上限；超过就整体清空。 */
export const SEEN_PUSH_LIMIT = 64;
/** 查询回执之后忽略非回执推送的窗口长度（毫秒）；实测迟到快照在 3.19 s 后到。 */
export const IPUSH_WINDOW_MS = 6000;

export function acceptPush(args: {
  isReply: boolean;
  msgId: string;
  now: number;
  ignoreUntil: number;
  seen: Set<string>;
}): boolean {
  const { isReply, msgId, now, ignoreUntil, seen } = args;
  if (isReply) return true;
  if (now < ignoreUntil) return false;
  if (msgId && seen.has(msgId)) return false;
  if (msgId) {
    if (seen.size >= SEEN_PUSH_LIMIT) seen.clear();
    seen.add(msgId);
  }
  return true;
}


