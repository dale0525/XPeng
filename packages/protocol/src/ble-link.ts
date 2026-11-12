/**
 * 常驻 BLE 连接：把「一条命令一条连接」改成「一条连接多条命令」。
 *
 * 官方 App 也是这样，但真正的约束比「保持连接」更深一层：**车端要求连上后立刻
 * 完成三段认证，不发就约 5 秒断开**（实测：连上后 4.88–4.93 s 车端 `status=19`
 * 主动断开，连续 8 个周期波动 <0.05 s，是固定计时器不是抢连接槽）。而认证材料
 * 是一次性的——`BleV2MaterialService.take()` 每条消息只能用一次、失败也不归还。
 *
 * 因此「保持」= 连上即认证 + 周期性重鉴权（每轮重新取一条材料），不是「只建连」。
 * 官方 App 一次 65 分钟抓包里自动重鉴权 31 轮、中位间隔约 127 秒，同此机制。
 *
 * 计时为什么可注入：RN 的 `setTimeout` 走宿主(View)时钟，Activity 退到后台后会被
 * 暂停，息屏后台时重连与重鉴权的定时器一次都不触发（实测被踢后数分钟零重连）。
 * 所以接入层注入一套原生计时（前台服务持唤醒锁时主线程消息照常执行），本类只调度
 * 延迟、不关心底层是 JS 还是原生。
 *
 * 职责边界：
 * - `hold()` 之后由本类持有连接：连上→认证→按 `reauthIntervalMs` 重鉴权，
 *   断开按指数退避重连，直到 `release()`；
 * - `execute()` 在 hold 期间复用已认证的连接，不碰建连与断开；
 * - 未 hold 时 `execute()` 仍是一条命令一条连接，与 `BleSession` 原行为一致。
 *
 * 不把这件事塞进 `BleSession`：它的 `execute()` 在 `finally` 必断是刻意的契约
 * （认证材料不可重放），常驻需要的是另一个连接生命周期，两者混在一起会让
 * 「一次操作一次连接」这条已有契约失去保护。
 */
import {
  BleSession, type BleCommandAck, type BleCommandOptions, type BleStage, type BleTransport,
} from './ble-session.ts';

export type BleLinkState =
  | { kind: 'idle' }
  | { kind: 'connecting'; mac: string }
  | { kind: 'connected'; mac: string }
  | { kind: 'backoff'; mac: string; retryInMs: number; attempts: number };

/** 一次认证握手所需材料，由调用方每条重新提供（材料一次性）。 */
export type BleLinkAuthMaterial = {
  appN: Uint8Array;
  keyMac: string;
} & ({
  createAuthCipher(appN: Uint8Array, carN: Uint8Array): Promise<Uint8Array>;
  verifyKey?: never;
  verifyRandom?: never;
} | {
  verifyKey: string;
  verifyRandom: number;
  createAuthCipher?: never;
});

/**
 * 延迟驱动。`retry`/`reauth` 各留一个待触发的把手，`cancel*` 取消当前待触发项。
 * 接入层用原生计时实现它，避免 RN 的 setTimeout 在后台被暂停。
 */
export interface BleLinkTimers {
  retry(mac: string, delayMs: number, run: () => void): void;
  reauth(mac: string, delayMs: number, run: () => void): void;
  cancelRetry(): void;
  cancelReauth(): void;
}

export interface BleLinkOptions {
  /** 首次重连等待；之后按 2 的幂翻倍。 */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * 重鉴权周期。车端约每 5 s 踢掉「连上不认证」的连接；实测一次认证后连接稳定
   * 保持约 120 s，与官方 App 的 ~127 s 重鉴权周期吻合，故取 120 s。
   */
  reauthIntervalMs?: number;
  /** 计时驱动；不给则用 JS setTimeout（前台/测试场景足够）。 */
  timers?: BleLinkTimers;
  onStateChange?(state: BleLinkState): void;
  /** 操作阶段由 `BleSession` 发出，供 UI 显示「认证中/指令中」。 */
  onStage?(stage: BleStage): void;
  /**
   * 判定「重试没有意义」的错误（权限被拒、蓝牙关闭、设备不支持）。
   *
   * 常驻重连是无限退避的，所以缺了这条判据时，用户拒绝一次蓝牙权限就会变成
   * 每 30 s 一次的无效重连。
   */
  isPermanentError?(error: unknown): boolean;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_REAUTH_INTERVAL_MS = 120_000;

/** 默认计时：直接回落 JS setTimeout（会被 RN 后台暂停，故接入层要覆盖）。 */
export function defaultBleLinkTimers(): BleLinkTimers {
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reauthTimer: ReturnType<typeof setTimeout> | undefined;
  const clear = (t: ReturnType<typeof setTimeout> | undefined) => { if (t !== undefined) clearTimeout(t); };
  return {
    retry(_mac, delayMs, run) {
      clear(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = undefined; run(); }, delayMs);
    },
    reauth(_mac, delayMs, run) {
      clear(reauthTimer);
      reauthTimer = setTimeout(() => { reauthTimer = undefined; run(); }, delayMs);
    },
    cancelRetry() { clear(retryTimer); retryTimer = undefined; },
    cancelReauth() { clear(reauthTimer); reauthTimer = undefined; },
  };
}

export class BleLink {
  private readonly transport: BleTransport;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly reauthIntervalMs: number;
  private readonly timers: BleLinkTimers;
  private readonly onStateChange?: (state: BleLinkState) => void;
  private readonly onStage?: (stage: BleStage) => void;
  private readonly isPermanentError?: (error: unknown) => boolean;
  private readonly session: BleSession;
  private mac = '';
  private held = false;
  private open = false;
  private attempts = 0;
  private offDrop?: () => void;
  private state: BleLinkState = { kind: 'idle' };
  /** 认证材料的提供者；由接入层注入，每条重鉴权都会调用一次取新材料。 */
  private readonly authMaterial: (mac: string) => Promise<BleLinkAuthMaterial>;

  constructor(
    transport: BleTransport,
    authMaterial: (mac: string) => Promise<BleLinkAuthMaterial>,
    options: BleLinkOptions = {},
  ) {
    this.transport = transport;
    this.authMaterial = authMaterial;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.reauthIntervalMs = options.reauthIntervalMs ?? DEFAULT_REAUTH_INTERVAL_MS;
    this.timers = options.timers ?? defaultBleLinkTimers();
    this.onStateChange = options.onStateChange;
    this.onStage = options.onStage;
    this.isPermanentError = options.isPermanentError;
    // 会话层拿到的永远是这层代理：hold 期间它把 connect 变成幂等、把 disconnect
    // 变成空操作，于是 `BleSession` 不用知道自己是在常驻模式下工作。
    this.session = new BleSession({
      connect: (mac) => this.connectThroughSession(mac),
      write: (data) => this.transport.write(data),
      disconnect: () => this.disconnectThroughSession(),
      onData: (cb) => this.transport.onData(cb),
      onDisconnect: (cb) => this.transport.onDisconnect(cb),
    }, (stage) => this.onStage?.(stage));
  }

  get connected(): boolean { return this.open; }
  get current(): BleLinkState { return this.state; }

  /**
   * 持有连接。立即发起一次连接并认证；失败不抛给调用方，而是进入退避重连，
   * 因为常驻连接的意义就是「不需要用户再点一次」。
   */
  async hold(mac: string): Promise<void> {
    const target = mac.toUpperCase();
    if (this.held && this.mac !== target) await this.release();
    this.mac = target;
    this.held = true;
    this.timers.cancelRetry();
    if (this.open) return;
    this.offDrop?.();
    this.offDrop = this.transport.onDisconnect((reason) => this.onDrop(reason));
    await this.connect();
  }

  /** 放手：取消退避与重鉴权、断连，之后不再自动重连。 */
  async release(): Promise<void> {
    this.held = false;
    this.attempts = 0;
    this.timers.cancelRetry();
    this.timers.cancelReauth();
    this.offDrop?.();
    this.offDrop = undefined;
    if (!this.open) { this.setState({ kind: 'idle' }); return; }
    this.open = false;
    this.setState({ kind: 'idle' });
    await this.transport.disconnect().catch(() => {});
  }

  /**
   * 常驻模式下由本类掌握连接；未 hold 时退回 `BleSession` 的一次性行为。
   *
   * 退避窗口里用户点了车控，不能直接报「未连接」——那会把「保持连接」变成
   * 「连接断了就别用」。这里立刻补一次连接（含认证）再执行，失败才报错。
   */
  async execute(options: BleCommandOptions): Promise<BleCommandAck> {
    if (this.held && options.mac.toUpperCase() !== this.mac) {
      // 手上连着 A 车，用户去控 B 车：不换连接就是往 A 车的链路上发 B 车的指令。
      await this.hold(options.mac);
    }
    if (this.held && !this.open) {
      this.timers.cancelRetry();
      await this.connect();
      if (!this.open) throw new Error('BLE link is not connected');
    }
    if (this.held) {
      // 命令与重鉴权互斥：握手期间 `BleSession.active` 为真，重鉴权排在命令之后。
      this.timers.cancelReauth();
      try {
        return await this.session.execute(options);
      } finally {
        this.scheduleReauth();
      }
    }
    return this.session.execute(options);
  }

  private async connectThroughSession(mac: string): Promise<void> {
    if (this.held) {
      // hold 期间连接已由 hold()/退避负责建好；会话只复用，不重建。
      if (this.open && mac.toUpperCase() === this.mac) return;
      throw new Error('BLE link is reconnecting');
    }
    await this.transport.connect(mac);
  }

  private async disconnectThroughSession(): Promise<void> {
    // hold 期间一条命令结束不能把常驻连接拆掉；断开时机归 release() 与车端。
    if (this.held) return;
    await this.transport.disconnect();
  }

  private async connect(): Promise<void> {
    if (!this.held) return;
    this.setState({ kind: 'connecting', mac: this.mac });
    try {
      await this.transport.connect(this.mac);
    } catch (error) {
      if (this.isPermanentError?.(error)) {
        // 前置条件不满足时重连只会空转：直接放手，等用户处理后重新 prepare。
        this.held = false;
        this.attempts = 0;
        this.offDrop?.();
        this.offDrop = undefined;
        this.setState({ kind: 'idle' });
        return;
      }
      this.scheduleRetry();
      return;
    }
    if (!this.held) {
      // release() 恰好落在连接途中：不要把连接漏在外面。
      await this.transport.disconnect().catch(() => {});
      return;
    }
    this.open = true;
    this.attempts = 0;
    this.setState({ kind: 'connected', mac: this.mac });
    // 连上即认证：不发握手车端约 5 s 就断开。认证失败按退避重来。
    await this.authenticateNow();
    this.scheduleReauth();
  }

  /** 用一条新材料做一次三段握手；失败时按连接掉线处理（重连会重新认证）。 */
  private async authenticateNow(): Promise<void> {
    if (!this.held || !this.open) return;
    let material: BleLinkAuthMaterial;
    try {
      material = await this.authMaterial(this.mac);
    } catch (error) {
      // 取材料失败（网络/账号）不该把连接拖垮到崩溃；退避后重连会再试。
      this.onDrop(`auth material unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!this.held || !this.open) return;
    try {
      await this.session.authenticate({ mac: this.mac, ...material });
    } catch (error) {
      this.onDrop(`authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleReauth(): void {
    if (!this.held || !this.open) return;
    this.timers.cancelReauth();
    this.timers.reauth(this.mac, this.reauthIntervalMs, () => { void this.reauthenticate(); });
  }

  private async reauthenticate(): Promise<void> {
    if (!this.held || !this.open) return;
    await this.authenticateNow();
    this.scheduleReauth();
  }

  private onDrop(_reason: string): void {
    if (!this.held) return;
    this.timers.cancelReauth();
    this.open = false;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.held) return;
    this.timers.cancelRetry();
    const retryInMs = Math.min(this.baseDelayMs * 2 ** this.attempts, this.maxDelayMs);
    this.attempts += 1;
    this.setState({ kind: 'backoff', mac: this.mac, retryInMs, attempts: this.attempts });
    this.timers.retry(this.mac, retryInMs, () => { void this.connect(); });
  }

  private setState(next: BleLinkState): void {
    this.state = next;
    this.onStateChange?.(next);
  }
}
