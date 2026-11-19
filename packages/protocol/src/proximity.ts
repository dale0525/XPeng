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

/**
 * 达标轮数的统计窗口（轮）。
 *
 * 取 10：扫描约 1.5 s 一轮，10 轮 ≈ 15 s，足以覆盖 `leaveMs`（8 s）的时间跨度，
 * 同时短到不会把"几分钟前路过时的一个强值"算进来。
 */
const SAMPLE_WINDOW = 10;

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
  /**
   * 采信这一轮读数所允许的最大漏扫率（0~1，默认 0.4）。
   *
   * 超过就说明最近几轮大半没扫到车，此时的强读数多半是幸存者偏差抬起来的
   * （见 MISS_RATE_WINDOW）。设为 1 可关掉该判据。
   */
  maxMissRate?: number;
  /**
   * 解锁状态下连续收不到读数多久，直接判定人已离开并闭锁（ms）。
   *
   * 这是阈值闭锁覆盖不到的兜底：人快步走远，RSSI 掉到闭锁线以下后要凑满
   * `leaveMs`（8 s）；但若他在 8 s 内走出蓝牙范围，链路断开、转扫描、扫不到车，
   * 那 8 s 永远凑不满，车就一直不锁。设 0 关闭该判据。
   */
  missingLockMs?: number;
}

export const DEFAULT_PROXIMITY_CONFIG: ProximityConfig = {
  // 官方按「主驾门 1 米」校准，具体数值要在车边标定。这组默认来自 2026-11-12
  // 真车手机近处的实测：人离车约数米时车端广播 RSSI 落在 -83…-90 dBm，所以
  // -80 作「进入」会把近在眼前也判成远。先取宽松的一组，等车边标定再收紧。
  // 2026-11-12 用户实走标定（656 轮真实样本离线回放）：
  //   门边静置 7 分钟均值 -72.6、5 米 -79、30 米 -73.8。
  // 30 米读数反而比 5 米强，原记录归因为「多径反射」。2026-11-19 复核推翻了这个归因：
  // 把同一份数据按漏扫率分桶，漏扫越少读数越强（0-20% → -69.1，40-60% → -76.0，
  // 60-80% → -78.3）。30 米段漏扫只有 28.9%，而门边高达 48.9%——远端只有强包能到达，
  // 弱包全丢，读数被幸存者偏差抬高。真正机制是**广播采样的选择偏差**，不是多径。
  // 这也是「持连接读 RSSI」优于广播的实证依据：连接态 100/100 采样零缺失，无此偏差。
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
  // 见 MISS_RATE_WINDOW 的注释：漏扫超过四成就把这一轮读数视为不可采信。
  maxMissRate: 0.4,
  // 失联兜底：连续 6 轮（约 9 s）收不到读数就判离开。
  // 取 9 s 比 leaveMs 的 8 s 稍长：正常走远应先由阈值在 8 s 触发，这条只在
  // "阈值还没来得及凑满就断链"时接管，不应比阈值路径更早误判。
  missingLockMs: 9000,
};

/**
 * 漏扫率置信度：最近若干轮里「没扫到」的占比超过阈值，就当这一轮读数不可采信。
 *
 * 依据（2026-11-19 复核 2026-11-12 的 656 轮数据）：漏扫 0-20% 的窗口中位读数
 * -69.1，40-60% 为 -76.0，60-80% 为 -78.3。同一份数据里 30 米段漏扫仅 28.9%、
 * 门边 48.9%，于是 30 米的中位数反而比 5 米还强。远端只有强包能到达、弱包全部丢失，
 * 剩下的样本是被抬高的幸存者——**读数强不等于离得近**。
 *
 * 所以：漏扫多的窗口里，无论读数多强都不推进解锁；漏扫少的窗口才采信。
 * 取 40% 是因为实测中 20-40% 档的中位读数（-74.9）仍与模型吻合，超过就明显偏强。
 */
const MISS_RATE_WINDOW = 10;

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
  /**
   * 车辆当前是否已解锁（= 人大概在附近）。
   *
   * 由车辆真实锁状态驱动（见 calibrate），不再由本地"判断成功与否"写入。
   * 原字段叫 nearby，但那会误导：它实际表达的是车锁状态，而"人在附近"是
   * 另一个概念（例如人在车里、车锁着时两者不同）。改名后调用方按事实理解。
   */
  private unlocked = false;
  private readonly config: ProximityConfig;
  /**
   * 最近 `SAMPLE_WINDOW` 轮里「达标」的时间戳与样本数。
   *
   * 为什么不是"连续 N 轮"：2026-11-15 实测走近年，20:51:13 起是
   * -76 → -88 → -75，一个 -88 就把连续计数清零，整段走完一次也没触发。
   * 真实多径信号里强弱交替是常态，要求严格连续等于把触发交给运气
   * （同一形态 12:41 走远凑够了、20:51 走近没凑够，纯属偶然）。
   * 现在只统计"窗口内够强的有几轮"，夹一两个弱值不影响。
   */
  private nearTimes: number[] = [];
  private farTimes: number[] = [];
  /**
   * 最近若干轮的「扫到/没扫到」记录，用于算漏扫率。
   *
   * 只记最近 MISS_RATE_WINDOW 轮：漏扫率必须跟着时间滑动。若把整段历史都算进来，
   * 一次长时间的空窗（刚起扫、车还没广播）会把后面的可靠样本永久拖成"不可信"，
   * 表现为功能再也不触发。
   */
  private recentMisses: boolean[] = [];
  /** 连续收不到读数的起点时刻；null 表示最近一轮有读数。 */
  private missingSince: number | null = null;

  constructor(config: ProximityConfig = DEFAULT_PROXIMITY_CONFIG) {
    this.config = config;
  }

  /**
   * 用当前信号**直接确立**远近状态，不产生动作。
   *
   * 扫描是间歇运行的（前台停、退后台起、抑制解除后起）。每次新起扫描时判距器都
   * 假定"人不在附近"，于是第一眼看到的就是车旁强信号——它会把"人本来就在车边"
   * 误判成"刚刚走近"，立刻发一次解锁。2026-11-15 实测：手动解锁后退出 App，
   * 扫描启动 4 秒就补发了一次解锁（rssi=-35）。
   * 播种后这种"起扫瞬间贴脸"只被记为"已经近"，不会再触发解锁。
   */
  /**
   * 用车辆真实锁状态校准「是否在附近」。
   *
   * 每轮扫描前调用。锁着 = 人不在附近、开着 = 人在附近；拿不到状态时维持原值
   * （不能默认成"不在附近"，那会让已解锁的车永远不再闭锁）。
   *
   * 这同时治了两个问题：① 动作失败后 nearby 停在错值导致再也不触发；
   * ② 长时间运行后本地判断与车辆真实状态漂移。
   */
  calibrate(locked: boolean | null): void {
    const next = unlockedFromLockState({ locked });
    if (next === null) return;
    if (next === this.unlocked) return;
    this.unlocked = next;
    this.nearTimes = [];
    this.farTimes = [];
  }

  seed(rssi: number | null): void {
    if (rssi === null) return;
    this.unlocked = rssi >= this.config.nearRssi;
    this.nearTimes = [];
    this.farTimes = [];
  }

  /** 喂一条样本；返回本条触发的动作，没有则 undefined。 */
  push(t: number, rssi: number | null): ProximityAction | undefined {
    // 漏扫一轮不代表远近变化：既不算"靠近"，也**不**算"离开"。原实现把 null 当
    // isFar，于是一次没扫到就推进离开计时，静态时反复误锁（2026-11-12 故障）。
    // 进度与时间窗都保持不动，等下一轮有值再说。
    // 但要记进漏扫窗口：漏扫率高时后续的强读数不可采信（见 MISS_RATE_WINDOW）。
    this.recentMisses.push(rssi === null);
    if (this.recentMisses.length > MISS_RATE_WINDOW) this.recentMisses.shift();
    if (rssi === null) {
      // 失联兜底：解锁状态下连续收不到读数够久，判人已离开并闭锁。
      // 只对"已解锁"生效——没解锁时收不到信号本来就该什么都不做。
      const limit = this.config.missingLockMs ?? 0;
      if (this.unlocked && limit > 0) {
        if (this.missingSince === null) this.missingSince = t;
        if (t - this.missingSince >= limit) {
          this.unlocked = false;
          this.missingSince = null;
          this.farTimes = [];
          this.nearTimes = [];
          return 'lock';
        }
      }
      return undefined;
    }
    // 重新收到读数：失联计时清零。
    this.missingSince = null;

    // 漏扫太多时**只挡解锁，不挡闭锁**。
    //
    // 为什么不对称：漏扫率高说明车在远端（实测人走远时漏扫 70-90%）。此时
    // ① 偶尔到达的强包会被幸存者偏差抬高，据此解锁就是"人在 30 米外车开了"，
    //    属安全事故，必须挡；
    // ② 闭锁本就该在"远"时触发，用漏扫率挡它等于让车永远不锁——2026-11-19 拿
    //    656 轮真实走位数据回放，闭锁从 1 次直接变成 0 次，正是这个后果。
    // 所以这条判据只作用在解锁侧。
    if (!this.unlocked && this.missRateTooHigh()) return undefined;

    if (!this.unlocked) {
      // 弱值只是不计数，不再把已有进度清零。
      if (rssi < this.config.nearRssi) { this.nearTimes = []; return undefined; }
      this.nearTimes.push(t);
      if (this.nearTimes.length > SAMPLE_WINDOW) this.nearTimes.shift();
      if (this.nearTimes.length < this.config.enterSamples) return undefined;
      if (t - this.nearTimes[0] < this.config.enterMs) return undefined;
      this.unlocked = true;
      this.nearTimes = [];
      this.farTimes = [];
      return 'unlock';
    }

    if (rssi > this.config.farRssi) { this.farTimes = []; return undefined; }
    this.farTimes.push(t);
    if (this.farTimes.length > SAMPLE_WINDOW) this.farTimes.shift();
    if (this.farTimes.length < this.config.leaveSamples) return undefined;
    if (t - this.farTimes[0] < this.config.leaveMs) return undefined;
    this.unlocked = false;
    this.farTimes = [];
    this.nearTimes = [];
    return 'lock';
  }

  /** 车辆是否已解锁（= 人在附近）。取代原 isNearby，含义按事实命名。 */
  get isUnlocked(): boolean { return this.unlocked; }

  /** 最近窗口的漏扫率是否已高到不能采信读数。窗口未满时按已有样本算。 */
  private missRateTooHigh(): boolean {
    const limit = this.config.maxMissRate ?? DEFAULT_PROXIMITY_CONFIG.maxMissRate ?? 0.4;
    if (limit >= 1) return false;
    if (this.recentMisses.length === 0) return false;
    const misses = this.recentMisses.filter(Boolean).length;
    return misses / this.recentMisses.length > limit;
  }
}

/**
 * 按「车辆距离」给扫描分成本档。
 *
 * 目标不是提高判距精度，而是**把耗电花在该花的地方**：明显不需要解闭锁的场景
 * （车在几公里外）连扫描都不必开；而一旦进入可疑范围，就正常扫描，此时多耗电
 * 是可接受的——总比"人在车前却解不开"强。
 *
 * 为什么只用距离做粗筛、不拿它判近场：手机侧定位在地库基本不可用、室外 WiFi 定位
 * 误差也有 30-100 m，而真正要判的是 3-5 m。所以它只能回答"绝对不可能在附近"，
 * 不能回答"是否已经足够近"。近场判断仍归 RSSI。
 *
 * `distanceMeters` 为 null（没权限/取不到坐标）时返回 normal：缺数据最坏只是白耗电，
 * 而据此停掉扫描会让功能整体失效，两者代价不对等。
 */
/**
 * 车辆行驶时的解锁门控。
 *
 * 车在动时人不可能站在车旁等解锁，此时 RSSI 再强也不该开锁——这是**语义判断**，
 * 不依赖信号质量，因此不受多径、漏扫、坐标系任何问题影响，是本模块里最可靠的一条判据。
 *
 * 关于 `speed` 的单位：字段是字符串、实测为 `"0.000000"`，单位未证实（显示层按
 * km/h 渲染但没有独立证据）。不过「大于 0 即在动」与单位无关：任何单位下 0 都是静止，
 * 所以这里只判正负，不解读量纲。
 *
 * 拿不到车速（null）时放行：误放行最坏是多解一次锁，误挡则是人在车前解不开，
 * 两者代价不对等。
 */
/**
 * 用车辆真实锁状态推导「人是否在附近」。
 *
 * 取代原来纯本地的 nearby 记忆。原实现只有"自己判断解锁成功"才置 true、
 * "自己判断闭锁成功"才置 false，于是动作失败时它会停在错值上：解锁三次失败就
 * 永远不再解锁、闭锁三次失败就永远不再闭锁（2026-11-12 真车实测过后者）。
 *
 * 改用真实锁状态后四种场景全部自洽：
 * - 走远自动闭锁成功 → 锁着 → 不在附近 → 之后走近能解锁
 * - 走近自动解锁成功 → 开着 → 在附近 → 之后走远能闭锁
 * - 手动锁车走人     → 锁着 → 不在附近
 * - 开门下车         → 开着 → 在附近 → 之后走远能闭锁
 *
 * 「人在车里且车锁着」不需要特殊处理：要下车必须从里面开门，一开门车就解锁了。
 *
 * 返回 null 表示拿不到车锁状态，调用方应维持原值——不能默认成"不在附近"，
 * 那会让已解锁的车永远不再闭锁。
 */
export function unlockedFromLockState(input: { locked: boolean | null }): boolean | null {
  if (input.locked === null) return null;
  return !input.locked;
}

/** 行驶状态的保质期。超过即视为「不知道」，门控退回放行。 */
/**
 * 要不要把这一轮 RSSI 明细写进日志。
 *
 * 关键事件（触发、建连、抑制、失败）一直记；每轮 1.5 s 的读数明细只在开关打开时记。
 * 不这样分开，日志几分钟就滚满 8 MB 上限，把真正要查的那几行冲掉。
 */
export function shouldLogSample(input: { verbose: boolean }): boolean {
  return input.verbose;
}

/** 建连失败后的最小重试间隔。 */
export const LINK_RETRY_BACKOFF_MS = 5_000;

/**
 * 建连失败后要不要立刻再试。
 *
 * "扫到车就建连"在建连失败时会退回扫描，而扫描马上又会扫到车、再次尝试建连。
 * 车端拒绝连接时（例如唯一连接槽被官方 App 占着）这会变成"扫描→失败→扫描→失败"
 * 的快速循环，很耗电。失败后至少等 5 秒——比 ble-link 内部的重连退避更长，
 * 确保不会出现两套退避互相叠加的高频重试。
 */
export function decideLinkAttempt(input: {
  /** 上一次建连失败的时刻；null 表示还没失败过。 */
  lastFailureAtMs: number | null;
  nowMs: number;
}): 'retry' | 'wait' {
  if (input.lastFailureAtMs === null) return 'retry';
  return input.nowMs - input.lastFailureAtMs >= LINK_RETRY_BACKOFF_MS ? 'retry' : 'wait';
}

export const MOVING_STATE_TTL_MS = 30_000;

export function decideUnlockGate(input: {
  moving: boolean | null;
  /** 这条状态是多久以前收到的（ms）。省略表示未提供，按新鲜处理。 */
  ageMs?: number;
}): 'allow' | 'block' {
  if (input.moving !== true) return 'allow';
  // 过期保护：MQTT 只在状态变化时推送（实测静止车辆 60 秒零推送）。若车停下后
  // 没有新的 speed=0，缓存会一直停在"在动"，门控就永久挡住解锁——人站在车边
  // 解不开锁。过期即当"不知道"，退回放行，最坏只是回到未加门控时的行为。
  if (typeof input.ageMs === 'number' && input.ageMs > MOVING_STATE_TTL_MS) return 'allow';
  return 'block';
}

/**
 * 闭锁门控：与解锁同样受行驶状态约束。
 *
 * 车在动时人不可能在车旁，此时闭锁与解锁一样都是基于不可靠信息的误动作。
 * 具体场景：车开走时蓝牙本来就在快速变弱，很容易被误判成"人走远了"而发闭锁，
 * 但人根本没走、是车走了——这时锁车没有意义，还可能打断正在进行的其他车控。
 *
 * 过期规则与解锁一致：状态超过 TTL 未更新即视为不知道，放行。
 */
export function decideLockGate(input: { moving: boolean | null; ageMs?: number }): 'allow' | 'block' {
  return decideUnlockGate(input);
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
   * App 是否在前台。
   *
   * **不再用它拦扫描**。旧实现在前台一律不扫，依据是"前台持连接、后台扫描"的
   * 粗粒度互斥（2026-11-12 实测：持有 GATT 连接时扫描 20 轮 results=0，车端
   * 在已有连接时不广播）。2026-11-19 起判距改成两态自动切换——扫描态扫到车就进
   * 连接态、链路掉线退回扫描态——前后台不再是决定因素。继续按前台拦截会让
   * 前台永远起不了扫，也就永远进不了连接态，功能在前台静默失效。
   *
   * 保留这个字段只为兼容既有调用点与测试，语义上不再参与判定。
   */
  foreground: boolean;
  /** 当前是否已持有链路。连接与扫描互斥（争同一个控制器），连着就不该再扫。 */
  linkConnected?: boolean;
}): 'stop' | 'start' | 'none' {
  if (!input.enabled) return input.scanRunning ? 'stop' : 'none';
  if (input.linkConnected) return input.scanRunning ? 'stop' : 'none';
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
  /**
   * 动作结束后链路是否还持有。
   *
   * 两态架构下后台同样可能走连接态判距（扫到车就切连接），动作执行时链路本来就在，
   * 结束后也该继续用它判距。原判据「后台就恢复扫描」会在此处停掉连接态、改起扫描，
   * 而车端在已有连接时不广播——等于每次后台动作后都把判距打断一次。
   */
  linkHeld?: boolean;
}): 'resume' | 'stay-stopped' {
  if (!input.enabled || !input.hasMac) return 'stay-stopped';
  // 已持链路：动作后继续用连接态判距，不要切回扫描。
  if (input.linkHeld) return 'stay-stopped';
  return input.foreground ? 'stay-stopped' : 'resume';
}
