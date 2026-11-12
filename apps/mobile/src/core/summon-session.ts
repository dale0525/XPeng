/**
 * 直线召唤会话：激活 → 心跳 → 退出。
 *
 * 事实来源：2026-11-12 真车 HCI 抓包（无线调试）run
 * `work/ble-capture/20261112-225648-rpa-activate-heartbeat`，官方 App 5.19.0 主账号。
 * 该 run 覆盖「进页面 → 按住上箭头约 2 秒 → 松手 → 退出」全过程：
 *
 * - **进入召唤态**是车控通道上的一条 V2 命令（`0xED` 帧，`cmd=0x03`、外层 `type=3`、
 *   `chunk_len=140` / `tbox_len=133`），不是心跳的一部分：进页面后先走常规三段握手，
 *   再发这一条，随后才开始写 5 字节心跳。以前这里只发心跳、把 `activated` 恒置 false，
 *   就是因为缺这一条。**注意**：该命令没有 `0x0070` 控制回执，车端只回 `0318`/`0225`
 *   状态帧，所以激活按「不等回执、写成功即算」处理（见 `ble.ts` 的 `expectCommandAck`）。
 * - **心跳**是 5 字节 `ef 03 02 <mode> <counter>`：待机 `00`、前进 `01`、后退 `02`、
 *   退出 `07`；counter 是 7 位，`0x7f` 之后回 `0x00`。它是**持续**写的，不是一帧。
 * - **退出**：点退出后连发 5 帧 `07`（counter 连续递增），然后彻底停写（实测退出后零心跳）。
 *
 * 本模块只做状态机与帧形状，不碰蓝牙与网络：`RpaSessionIo` 由调用方注入。
 * 这样发帧节奏与模式切换可测，而原生链路仍是唯一的写入口。
 */

export type SummonDirection = 'forward' | 'backward';

/**
 * 心跳间隔。2026-11-12 实测 107 帧：中位 155.3 ms、均值 154.9 ms、最大 283.8 ms。
 * 最大值来自前进段与退出帧之间的一次停顿，常态稳定在 155 ms 附近。
 */
export const RPA_HEARTBEAT_INTERVAL_MS = 155;

/** 退出时连发的 `07` 帧数。2026-11-12 实测退出段正好 5 帧 `ef 03 02 07 xx`。 */
export const RPA_EXIT_FRAME_COUNT = 5;

const HEARTBEAT_PREFIX = Uint8Array.from([0xef, 0x03, 0x02]);

const MODE = { idle: 0x00, forward: 0x01, backward: 0x02, exit: 0x07 } as const;

export interface RpaSessionIo {
  /** 发一条指令码 0x03 的 V2 车控帧并等回执；失败必须抛错（材料/握手/车端拒绝）。 */
  activate(): Promise<void>;
  /** 把一帧写进当前已订阅的 GATT 链路，失败必须抛错。 */
  write(frame: Uint8Array): Promise<void>;
  /** 起一个周期计时器，返回停止函数。 */
  startTicker(everyMs: number, tick: () => void): () => void;
  /** 退出帧按心跳节奏发（抓包 5 帧跨约 565 ms），不在一次回调里连发。 */
  delay(ms: number): Promise<void>;
  /** 心跳中断（写失败、连接掉了）时通知界面：循环已停，车不会继续动。 */
  onInterrupted(message: string): void;
}

export class RpaSession {
  private readonly io: RpaSessionIo;
  private counter = 0;
  private mode: number = MODE.idle;
  private stopTicker: (() => void) | null = null;
  /** 首帧正在写时收到的第二次触发，要等它落定再发，避免同一连接上并发写。 */
  private writing: Promise<void> = Promise.resolve();
  private entering = false;

  constructor(io: RpaSessionIo) {
    this.io = io;
  }

  get active(): boolean {
    return this.stopTicker !== null;
  }

  /**
   * 进入召唤态。激活帧失败就直接抛给界面，并且**不**开始心跳——
   * 车端没进召唤态时心跳只会被丢掉，继续写等于让界面显示「在召唤」而车不动。
   */
  async enter(): Promise<void> {
    if (this.active || this.entering) return;
    this.entering = true;
    try {
      await this.io.activate();
    } finally {
      this.entering = false;
    }
    this.mode = MODE.idle;
    this.stopTicker = this.io.startTicker(RPA_HEARTBEAT_INTERVAL_MS, () => { this.beat(); });
  }

  /** 按住某个方向：切模式并立刻写一帧，不等下一个心跳周期。 */
  async move(direction: SummonDirection): Promise<void> {
    this.requireActive();
    this.mode = MODE[direction];
    await this.write();
  }

  /** 松手：立刻回到待机心跳，车速降下来靠的就是这一帧。 */
  async halt(): Promise<void> {
    this.requireActive();
    this.mode = MODE.idle;
    await this.write();
  }

  /** 退出：停心跳、按心跳节奏连发 `07`、清模式。重复调用无副作用。 */
  async exit(): Promise<void> {
    this.stop();
    this.mode = MODE.exit;
    for (let i = 0; i < RPA_EXIT_FRAME_COUNT; i++) {
      if (i > 0) await this.io.delay(RPA_HEARTBEAT_INTERVAL_MS);
      try {
        await this.write();
      } catch {
        // 退出帧写不出去不能再抛：调用方正在关界面，此时抛错会把「已关闭」变成失败弹窗。
        return;
      }
    }
    this.mode = MODE.idle;
  }

  private requireActive(): void {
    if (!this.active) throw new Error('召唤会话未激活：先进入召唤态再发方向');
  }

  private stop(): void {
    this.stopTicker?.();
    this.stopTicker = null;
  }

  private beat(): void {
    if (!this.active) return;
    void this.write().catch((error: unknown) => {
      // 写失败就停循环：链路已经不可用，继续按周期写只会刷屏，而界面还显示「召唤中」。
      this.stop();
      this.io.onInterrupted(`心跳中断：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private write(): Promise<void> {
    const frame = this.frame();
    // 串行排队：同一连接上不能有两条并发写；链本身保持 resolved，失败只交给本次调用方。
    const sent = this.writing.then(() => this.io.write(frame));
    this.writing = sent.catch(() => {});
    return sent;
  }

  private frame(): Uint8Array {
    const frame = new Uint8Array(5);
    frame.set(HEARTBEAT_PREFIX);
    frame[3] = this.mode;
    frame[4] = this.counter;
    this.counter = (this.counter + 1) & 0x7f;
    return frame;
  }
}
