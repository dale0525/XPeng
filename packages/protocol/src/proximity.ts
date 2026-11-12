/**
 * 靠近解闭锁的判距状态机（纯逻辑，不碰蓝牙/网络，便于单测）。
 *
 * 设备侧只负责按周期回传车端 RSSI（dBm，越接近 0 越近）；本模块把连续样本喂进来，
 * 用「阈值 + 停留时间」决定一次动作：
 * - 未在附近 → 近到 `nearRssi` 以上且持续 `enterMs` → 触发 unlock；
 * - 在附近 → 弱于 `farRssi` 以下且持续 `leaveMs` → 触发 lock。
 *
 * 两个不同阈值（滞回）避免在临界点抖动；离开的 `leaveMs` 故意比进入长，用来挡住
 * 「只是路过车尾一下」就误闭锁。用户明确选择不查车锁状态、无条件解/闭锁，所以这里
 * 只在「状态真的翻转」时才产生一次动作，避免同一侧连续采样反复解/锁。
 */
export type ProximityAction = 'unlock' | 'lock';

export interface ProximityConfig {
  /** 进入「附近」的 RSSI 上阈值（dBm，例如 -65）。 */
  nearRssi: number;
  /** 离开「附近」的 RSSI 下阈值（dBm，例如 -80），必须比 nearRssi 更弱。 */
  farRssi: number;
  /** 进入需要持续满足的时长（ms）。 */
  enterMs: number;
  /** 离开需要持续满足的时长（ms），通常比 enterMs 长以挡路过。 */
  leaveMs: number;
  /**
   * 进入前必须连续拿到够强的样本数。`null` 只表示"这一轮没扫到"，**不清零**进度。
   * 2026-11-12：车与人都不动，但 5 s 窗口会间歇漏扫，RSSI 在 -82 与 -96 间来回跳，
   * 原实现据此反复判进/判出，几分钟内解锁锁定来回切。
   */
  enterSamples: number;
  /** 离开前必须连续拿到够弱的样本数；单个偶发的弱样本不能当"车走了"。 */
  leaveSamples: number;
}

export const DEFAULT_PROXIMITY_CONFIG: ProximityConfig = {
  // 官方按「主驾门 1 米」校准，具体数值要在车边标定。这组默认来自 2026-11-12
  // 真车手机近处的实测：人离车约数米时车端广播 RSSI 落在 -83…-90 dBm，所以
  // -80 作「进入」会把近在眼前也判成远。先取宽松的一组，等车边标定再收紧。
  // 2026-11-12 用户实走标定（656 轮真实样本离线回放）：
  //   门边静置 7 分钟均值 -72.6、5 米 -79、30 米 -73.8（多径反射，30 米反而比 5 米强）。
  //   -70 进 / -92 锁 是唯一一组"门边解一次、走远锁一次、全程不反复切换"的参数。
  // 原 -88/-95 的实测表现：二楼（-84）就误解锁；而走远到 50 米均值才 -86，
  // 永远碰不到 -95，所以闭锁几乎从不触发。
  nearRssi: -70,
  farRssi: -92,
  // 用户 2026-11-12 选定：检测延迟压到 4.5 s。窗口 1.5 s × (3-1) + 1.5 s 停留 = 4.5 s。
  // 停留时间必须与窗口一起缩，否则单靠窗口只把 13 s 降到 10.5 s。
  enterMs: 1500,
  leaveMs: 8000,
  // 连续 3 轮（约 15 s）同向才算数：静态实测里 -82 与 -96 会交替出现，
  // 要求连续同向是唯一能把"抖动"和"真的靠近/离开"分开的判据。
  enterSamples: 3,
  leaveSamples: 3,
};

/**
 * 把一条 RSSI 时间序列折算成动作序列（测试与离线回放用）。
 *
 * 它只是 `ProximityTracker` 的薄驱动：判距逻辑只有一份实现，否则测试测的会是
 * 一段复制品，生产路径改坏了也照样全绿。
 */
export function evaluateProximity(
  samples: ReadonlyArray<{ t: number; rssi: number | null }>,
  config: ProximityConfig,
): ProximityAction[] {
  const tracker = new ProximityTracker(config);
  const actions: ProximityAction[] = [];
  for (const s of samples) {
    const action = tracker.push(s.t, s.rssi);
    if (action) actions.push(action);
  }
  return actions;
}

/**
 * 有状态的在线判距器：每来一条样本返回本条样本是否触发了动作（至多一个）。
 * 引擎侧用它，这样不必自己维护样本窗口。
 */
export class ProximityTracker {
  private nearby = false;
  private nearSince: number | null = null;
  private farSince: number | null = null;
  /** 连续同向的样本计数（与时间窗同时满足才触发）。 */
  private nearHits = 0;
  private farHits = 0;
  private readonly config: ProximityConfig;

  constructor(config: ProximityConfig = DEFAULT_PROXIMITY_CONFIG) {
    this.config = config;
  }

  /** 喂一条样本；返回本条触发的动作，没有则 undefined。 */
  push(t: number, rssi: number | null): ProximityAction | undefined {
    // 漏扫一轮不代表远近变化：既不算"靠近"，也**不**算"离开"。原实现把 null 当
    // isFar，于是一次没扫到就推进离开计时，静态时反复误锁（2026-11-12 故障）。
    // 进度与时间窗都保持不动，等下一轮有值再说。
    if (rssi === null) return undefined;

    if (!this.nearby) {
      if (rssi < this.config.nearRssi) { this.nearSince = null; this.nearHits = 0; return undefined; }
      this.nearHits += 1;
      if (this.nearSince === null) this.nearSince = t;
      // 时间窗与连续样本数都要满足：只有连续够强的几轮才排除"单轮偶发强值"。
      if (this.nearHits < this.config.enterSamples) return undefined;
      if (t - this.nearSince < this.config.enterMs) return undefined;
      this.nearby = true;
      this.nearSince = null;
      this.nearHits = 0;
      this.farSince = null;
      this.farHits = 0;
      return 'unlock';
    }

    if (rssi > this.config.farRssi) { this.farSince = null; this.farHits = 0; return undefined; }
    this.farHits += 1;
    if (this.farSince === null) this.farSince = t;
    if (this.farHits < this.config.leaveSamples) return undefined;
    if (t - this.farSince < this.config.leaveMs) return undefined;
    this.nearby = false;
    this.farSince = null;
    this.farHits = 0;
    this.nearSince = null;
    this.nearHits = 0;
    return 'lock';
  }

  get isNearby(): boolean { return this.nearby; }
}

/**
 * 开关与扫描的联立决策：算清楚「这次调用到底该不该新起一轮扫描」。
 *
 * 单独抽出来是因为这里曾经出过一个真故障：原来的判据是「开关状态没变就返回」，
 * 但开关可能先于车辆物料就绪被拨开（`prepareV2` 之后才补拉起），也可能来自冷启动
 * 恢复——这两种情况下开关已经是「开」而扫描根本没跑，被早退挡掉，功能静默失效。
 * 判据只能是「扫描当前有没有真的在跑」。
 */
export function decideScanAction(input: {
  enabled: boolean;
  scanRunning: boolean;
  hasTarget: boolean;
  /**
   * App 是否在前台。前台一律不扫描：2026-11-12 真车实测，App 持有 GATT 连接时
   * 判距扫描连续 20 轮 results=0，退到后台释放连接后立刻扫到车（-83…-90 dBm）
   * ——车端在已有连接时不广播。两条路互斥，同时跑只会白耗电且永远判不出距离。
   */
  foreground: boolean;
}): 'stop' | 'start' | 'none' {
  if (!input.enabled || input.foreground) return input.scanRunning ? 'stop' : 'none';
  if (!input.hasTarget) return 'none';
  return input.scanRunning ? 'none' : 'start';
}

/**
 * 执行一次解/闭锁动作期间，扫描必须让位。
 *
 * 2026-11-12 真车实测：判距扫描在跑时发起 GATT 建连，直接吃 `133`
 * (GATT_CONN_FAIL_ESTABLISH)，原生层三次重试都落在同一窗口内失败；两者共用
 * 同一个控制器。动作发完再恢复扫描，否则下一次靠近/离开就再也不会触发。
 */
export function decideScanDuringAction(input: {
  enabled: boolean;
  foreground: boolean;
  hasMac: boolean;
}): 'resume' | 'stay-stopped' {
  return input.enabled && !input.foreground && input.hasMac ? 'resume' : 'stay-stopped';
}
