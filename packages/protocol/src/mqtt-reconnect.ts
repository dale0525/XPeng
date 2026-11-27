/**
 * MQTT 断线与网络切换时的重连策略（纯逻辑，不碰原生与定时器，便于单测）。
 *
 * 2026-11-27 实测暴露两类断连不自愈：
 * 1. 人在前台时从 WiFi 切到移动数据：旧 TCP socket 报 IOException，原生回
 *    `onDisconnect("网络中断")`，但原先只有 `AppState === 'active'` 切前台时才调
 *    `carLink.resume()`，前台切网后永远停在 `offline` + RETRY 横幅。
 * 2. 后台网络波动/切换：断开后不再重连，导致车速/座椅/车锁状态断更数小时，
 *    以及云端兜底锁车报「连接未就绪」。
 *
 * 两条路径合在一起处理：
 * - 意外断线 / 连接失败：指数退避自动重连（2 s → 60 s 封顶）；
 * - 系统通知默认网络切换或恢复：立刻清零退避、经过短防抖后重连（切网时即使
 *   当前仍是 online 也要主动换到新接口，不等 45 s 心跳才发现旧 socket 已死）。
 */

export type MqttLinkState = 'idle' | 'connecting' | 'online' | 'offline';

/** 断线重连退避序列（ms）：前几次快恢复，长时间断网时不刷屏耗电。 */
export const MQTT_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;

/**
 * 切网/恢复联网后的短防抖（ms）。
 *
 * Android 在 WiFi 切 5G 瞬间可能连续发出多次网络变更回调，且新接口的路由/DNS
 * 需要几百毫秒就绪；等 500 ms 能把抖动合并成一次干脆的重连。
 */
export const NETWORK_SWITCH_DEBOUNCE_MS = 500;

/** 返回第 `attempt` 次重连（0 起始）前应等待的毫秒数。 */
export function nextMqttReconnectDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), MQTT_RECONNECT_DELAYS_MS.length - 1));
  return MQTT_RECONNECT_DELAYS_MS[index];
}

export type NetworkChangeDecision =
  | 'none'
  | 'pause'
  | 'reconnect-now'
  | 'defer-after-connect';

/**
 * 系统网络状态变化时，决定 MQTT 连接器下一步该做什么。
 *
 * - `none`：无会话或同一网络重复通知且已在线，不动。
 * - `pause`：当前无可用网络，暂停退避定时器，等网络回来再连，避免无网空转。
 * - `reconnect-now`：网络刚恢复（此前离线）或默认网络切换（WiFi ↔ 移动数据），
 *   清零退避并经短防抖后重连。
 * - `defer-after-connect`：正好在 `connecting` 途中发生了切网/恢复，记下标记，
 *   等本次建连一落地立刻按新网络补连，避免白等旧接口超时后再进长退避。
 */
export function decideNetworkChangeAction(input: {
  hasSession: boolean;
  state: MqttLinkState;
  available: boolean;
  switched: boolean;
}): NetworkChangeDecision {
  if (!input.hasSession) return 'none';
  if (!input.available) return 'pause';
  if (input.state === 'connecting') return 'defer-after-connect';
  if (input.state === 'online') {
    return input.switched ? 'reconnect-now' : 'none';
  }
  return 'reconnect-now';
}
