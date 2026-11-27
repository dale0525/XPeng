/**
 * 车控通道：MQTT 连接、下发指令、收下行回执、读全车状态。
 *
 * 回执判定不靠「publish 成功」，而是等 broker 转发的车辆回执里 `msg_ref`
 * 等于本条的 `msg_id`（见 docs/research/xpeng-app-teardown.md §5.5）。因此每条
 * 指令都要带超时，UI 的「下发中 → 成功/超时」由这里驱动。
 */
import {
  buildCarMessage,
  downlinkTopics,
  uplinkTopic,
  type DownlinkMessage,
} from '@xpeng/protocol/src/mqtt';
import { COMMANDS, READ_STATUS, type CommandDef } from '@xpeng/protocol/src/commands';
import type { MqttAccount, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import { acceptPush, IPUSH_WINDOW_MS } from '@xpeng/protocol/src/status-freshness';
import {
  decideNetworkChangeAction,
  NETWORK_SWITCH_DEBOUNCE_MS,
  nextMqttReconnectDelay,
} from '@xpeng/protocol/src/mqtt-reconnect';
import { onMqttDisconnect, onMqttMessage, onNetworkChange, native, xpLog } from './native';
import { sessionStore } from './session';

const CONNECTION_ID = 'car';

export type LinkState = 'idle' | 'connecting' | 'online' | 'offline';

export interface CommandResult {
  msgId: string;
  ok: boolean;
  /** 车辆回执里的 msg_content；超时则为 undefined。 */
  echo?: any;
  error?: string;
}

type LinkListener = (s: LinkState, reason?: string) => void;

class CarLink {
  private state: LinkState = 'idle';
  private listeners = new Set<LinkListener>();
  private pending = new Map<string, (r: CommandResult) => void>();
  private unsubs: Array<() => void> = [];
  private account: MqttAccount | null = null;
  private lastStatus: VehicleStatus | null = null;
  private statusListeners = new Set<(s: VehicleStatus) => void>();
  private vin = '';
  private uid = '';
  private rtt: number | null = null;
  /** 最近一次发出 st=19 查询的时刻；主动推送也可能先于回执到达，用它兜住延迟显示。 */
  private statusQueryAt: number | null = null;
  /** 回执到达后到此刻为止的推送视为过期快照，不回写界面（见 acceptPush）。 */
  private ignorePushesUntil = 0;
  /** 已采纳过的推送 `msg_id`。旧报文会被重放第二次，同一个 msg_id 不该再回写。 */
  private readonly seenPushIds = new Set<string>();
  /** 自动重连定时器与到期时刻（ms）；用于防止断线退避把更早的切网重连推迟。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDueAt = 0;
  /** 连续断线重连次数（0 起始）；连上或切网时清零。 */
  private reconnectAttempt = 0;
  /** 系统当前是否有可用默认网络；无网时暂停退避，等 onAvailable 立刻拉起。 */
  private networkAvailable = true;
  /** `connecting` 途中发生了切网/恢复，等本次建连落地后立刻在新网络上补连。 */
  private pendingNetworkReconnect = false;
  /** 原生默认网络变化监听的退订句柄；仅在显式 disconnect 时撤掉。 */
  private netUnsub: (() => void) | null = null;

  get linkState(): LinkState {
    return this.state;
  }

  get status(): VehicleStatus | null {
    return this.lastStatus;
  }

  /** 最近一次读状态的往返耗时（毫秒）。 */
  get latencyMs(): number | null {
    return this.rtt;
  }

  /** MQTT 凭据到期时间（毫秒时间戳）；未连过则为 null。 */
  get credentialsExpireAt(): number | null {
    return this.account?.expireTime ?? null;
  }

  subscribe(fn: LinkListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  subscribeStatus(fn: (s: VehicleStatus) => void): () => void {
    this.statusListeners.add(fn);
    if (this.lastStatus) fn(this.lastStatus);
    return () => this.statusListeners.delete(fn);
  }

  private setState(s: LinkState, reason?: string) {
    this.state = s;
    for (const fn of this.listeners) fn(s, reason);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectDueAt = 0;
    }
  }

  private ensureNetworkListener() {
    if (this.netUnsub) return;
    this.netUnsub = onNetworkChange((e) => {
      this.networkAvailable = e.available;
      const decision = decideNetworkChangeAction({
        hasSession: Boolean(this.vin) && sessionStore.current.kind === 'active',
        state: this.state,
        available: e.available,
        switched: e.switched,
      });
      xpLog(
        'mqtt',
        `network change available=${e.available} switched=${e.switched} state=${this.state} -> ${decision}`,
      );
      if (decision === 'pause') {
        this.clearReconnectTimer();
        return;
      }
      if (decision === 'defer-after-connect') {
        this.pendingNetworkReconnect = true;
        return;
      }
      if (decision === 'reconnect-now') {
        this.reconnectAttempt = 0;
        this.scheduleReconnect(NETWORK_SWITCH_DEBOUNCE_MS, 'network-change');
      }
    });
  }

  private scheduleReconnect(delayMs: number, trigger: string) {
    if (!this.vin || sessionStore.current.kind !== 'active') return;
    const dueAt = Date.now() + delayMs;
    // 已有更早的重连在排队（例如切网 500 ms 防抖）时，不要被较长的断线退避往后推。
    if (this.reconnectTimer !== null && this.reconnectDueAt <= dueAt) return;
    this.clearReconnectTimer();
    this.reconnectDueAt = dueAt;
    xpLog('mqtt', `schedule reconnect in ${delayMs}ms (${trigger})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDueAt = 0;
      if (!this.vin || sessionStore.current.kind !== 'active') return;
      if (this.state === 'connecting') return;
      void this.connect(this.vin, Number(this.uid));
    }, delayMs);
  }

  private scheduleBackoffReconnect(trigger: string) {
    if (!this.networkAvailable) {
      xpLog('mqtt', `skip backoff reconnect (${trigger}): network unavailable`);
      return;
    }
    if (!this.vin || sessionStore.current.kind !== 'active') return;
    const delayMs = nextMqttReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.scheduleReconnect(delayMs, `${trigger}#${this.reconnectAttempt}`);
  }

  private async closeSocket(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    await native.mqttDisconnect(CONNECTION_ID).catch(() => {});
  }

  /** 取凭据 → 连 broker → 订阅。凭据每次签发都会作废旧凭据，所以每次连接都重取。 */
  async connect(vin: string, uid: number): Promise<void> {
    if (this.state === 'connecting') return;
    this.clearReconnectTimer();
    this.pendingNetworkReconnect = false;
    this.vin = vin;
    this.uid = String(uid);
    this.ensureNetworkListener();
    // 续期成功或切网重连时 App 会从 online 态重跑连接：必须先断干净旧 socket 再重取，
    // 否则旧凭据/旧接口的读取循环还会留着。注意这里不清空 vin 与网络监听。
    if (this.state === 'online') {
      xpLog('mqtt', 'reconnect: disconnect previous socket first');
      await this.closeSocket();
    }
    this.setState('connecting');
    // 每次重连都会重新注册两个原生监听；不先撤掉旧的，回前台重连几次后同一条
    // 下行会被处理多遍（状态合并重复、pending 被同一 msg_ref 命中两次）。
    for (const u of this.unsubs) u();
    this.unsubs = [];
    try {
      const account = await sessionStore.call<MqttAccount>(
        '/biz/v5/mqtt/createMqttAccount/app',
        {},
      );
      this.account = account;
      const [host, portText] = account.serverSsl.split(':');
      const topics: Record<string, string> = {};
      downlinkTopics(this.uid, account.clientId.split(':').pop() ?? '').forEach((t, i) => {
        topics[String(i)] = t;
      });

      this.unsubs.push(
        onMqttMessage((e) => {
          if (e.id === CONNECTION_ID) this.handleDownlink(e.topic, e.payload);
        }),
        onMqttDisconnect((e) => {
          if (e.id !== CONNECTION_ID) return;
          this.setState('offline', e.reason);
          this.failAllPending('连接断开');
          this.scheduleBackoffReconnect('disconnect');
        }),
      );

      const rc = await native.mqttConnect(
        CONNECTION_ID,
        host,
        Number(portText || 8883),
        `${account.clientId}:2.0:V5.19.0:com.xpengmobile`,
        account.username,
        account.password,
        topics,
      );
      if (rc !== 0) {
        xpLog('mqtt', `connect refused rc=${rc}`, 'w');
        this.setState('offline', `broker 拒绝连接（返回码 ${rc}）`);
        this.finishConnectWithRetry('refused');
        return;
      }
      xpLog('mqtt', `connect ok host=${host} topics=${Object.keys(topics).length}`);
      this.reconnectAttempt = 0;
      this.setState('online');
      if (this.pendingNetworkReconnect) {
        this.pendingNetworkReconnect = false;
        this.scheduleReconnect(NETWORK_SWITCH_DEBOUNCE_MS, 'deferred-network-switch');
        return;
      }
      await this.readStatus().catch(() => {
        // 首次读状态失败不阻断连接；用户可手动刷新
      });
    } catch (e) {
      this.setState('offline', e instanceof Error ? e.message : String(e));
      this.finishConnectWithRetry('connect-error');
    }
  }

  private finishConnectWithRetry(reason: string) {
    if (this.pendingNetworkReconnect) {
      this.pendingNetworkReconnect = false;
      this.reconnectAttempt = 0;
      this.scheduleReconnect(NETWORK_SWITCH_DEBOUNCE_MS, 'deferred-network-switch');
      return;
    }
    this.scheduleBackoffReconnect(reason);
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    this.pendingNetworkReconnect = false;
    this.reconnectAttempt = 0;
    this.vin = '';
    this.netUnsub?.();
    this.netUnsub = null;
    await this.closeSocket();
    this.setState('idle');
  }

  /**
   * 回到前台或急需发云端指令时补状态。
   *
   * 即使已有断线退避与切网监听，回前台仍保留立刻补连与补读状态：
   * 1. 若当前正在长退避（例如 30 s），回前台立刻清退避重连，不必让用户等；
   * 2. 即使连接没断，界面上的车况也可能是进后台前的旧值，补读一次确保界面最新。
   */
  async resume(): Promise<void> {
    if (!this.vin || sessionStore.current.kind !== 'active') return;
    if (this.state === 'online') {
      await this.readStatus().catch(() => {});
      return;
    }
    if (this.state === 'connecting') return;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    xpLog('mqtt', `resume, previous=${this.state}`);
    await this.connect(this.vin, Number(this.uid));
  }

  /** 下发一条指令并等待回执。默认 20 s 超时（实测车端回执 3–12 s）。 */
  async send(def: CommandDef, timeoutMs = 20_000): Promise<CommandResult> {
    if (this.state !== 'online') {
      return { msgId: '', ok: false, error: '连接未就绪' };
    }
    const { payload, msgId } = buildCarMessage(
      this.uid,
      this.vin,
      def.serviceType,
      def.msgContent,
    );
    const waiter = new Promise<CommandResult>((resolve) => {
      this.pending.set(msgId, resolve);
      setTimeout(() => {
        if (this.pending.delete(msgId)) {
          resolve({ msgId, ok: false, error: '车辆未回执（超时）' });
        }
      }, timeoutMs);
    });
    try {
      await native.mqttPublish(CONNECTION_ID, uplinkTopic(this.uid), payload);
    } catch (e) {
      this.pending.delete(msgId);
      return { msgId, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return waiter;
  }

  /** 读全车状态（只读通道 service_type:19 / cmd_type:2）。 */
  async readStatus(timeoutMs = 15_000): Promise<VehicleStatus | null> {
    if (this.state !== 'online') return null;
    const { payload, msgId } = buildCarMessage(
      this.uid,
      this.vin,
      READ_STATUS.serviceType,
      READ_STATUS.msgContent,
    );
    const got = new Promise<VehicleStatus | null>((resolve) => {
      this.pending.set(msgId, (r) => {
        if (!r.ok || !r.echo) {
          resolve(null);
          return;
        }
        // st=19 的回执把整包状态直接放在 msg_content 里（顶层就是 msg/code/instant/
        // interval/digital_vehicle），没有额外的 status 子键。判据取 `instant`：
        // 车控指令的回执只有 `{code:200}`，把它当状态写进界面会让所有字段变空
        // （实测「打开遮阳帘」后整页变成「—」）。
        // 派发由 handleDownlink 统一做，这里只负责结束等待。
        const status = r.echo as VehicleStatus;
        resolve(status.instant ? status : null);
      });
      setTimeout(() => {
        if (this.pending.delete(msgId)) resolve(null);
      }, timeoutMs);
    });
    const t0 = Date.now();
    this.statusQueryAt = t0;
    await native.mqttPublish(CONNECTION_ID, uplinkTopic(this.uid), payload);
    const status = await got;
    // 只有真的拿到回执才算往返：超时时记 null，不要用超时值污染延迟显示
    if (status) this.rtt = Date.now() - t0;
    return status;
  }

  private handleDownlink(_topic: string, payload: string) {
    let msg: DownlinkMessage;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    const content = msg.msg_content as Record<string, any> | undefined;

    // 车辆会主动推 st=19 状态（命令回执，以及定时推送）。
    // 这些推送的 msg_ref 不一定等于我们发出的 msg_id，但内容正是界面要的数据，
    // 所以先无条件采纳，再去配对等待中的请求。
    //
    // 注意是**增量**推送：只带变化的那几个子域（例如开遮阳帘只回 window），
    // 必须合并进上一份状态，直接替换会把 solarRoof / trunkPower / chargeStatistics
    // 这些没推的域清空（实测：点一次遮阳帘，太阳能天窗与电动尾门全变成「—」）。
    const resolve = this.pending.get(msg.msg_ref);

    // 过期推送：一次 st=19 查询会让车端先推一条查询前的增量快照，再回本次查询的
    // 完整回执。回执让界面变新，那条迟到的快照随后又把它盖回旧值——实测表现为
    // 「结束充电后先显示未充电，约 1 秒后又变回充电中」。下行报文没有时间戳，
    // 无法比较新旧，只能在回执到达后的短窗口里忽略非回执推送。
    const accepted = acceptPush({
      isReply: resolve !== undefined,
      msgId: msg.msg_id,
      now: Date.now(),
      ignoreUntil: this.ignorePushesUntil,
      seen: this.seenPushIds,
    });

    if (content?.instant && accepted) {
      // 首读状态经常是「推送先到、回执后到」，此时配对不到 msg_id，量不到往返。
      // 用发出查询的时刻兜底，保证设置页的延迟不是恒为「—」。
      if (this.statusQueryAt !== null) {
        this.rtt = Date.now() - this.statusQueryAt;
        this.statusQueryAt = null;
      }
      const status = mergeStatus(this.lastStatus, content as VehicleStatus);
      this.lastStatus = status;
      for (const fn of this.statusListeners) fn(status);
    }

    if (!resolve) return;
    this.pending.delete(msg.msg_ref);
    const code = content?.code;
    // 本次查询的回执是权威快照：开一个短窗口挡掉紧跟着到达的过期推送。
    // 实测迟到的旧快照在回执后 3.19 s 到达，窗口取 6 s 留余量：这期间不采纳非回执推送，
    // 界面停在刚查到的权威值上。真正的变化车端会在 6 s 后再推，不会丢。
    if (content?.instant) this.ignorePushesUntil = Date.now() + IPUSH_WINDOW_MS;
    resolve({
      msgId: msg.msg_ref,
      ok: code === 200 || code === undefined,
      echo: content,
      error: code !== 200 && code !== undefined ? `车辆返回 ${code}` : undefined,
    });
  }

  private failAllPending(reason: string) {
    for (const [, resolve] of this.pending) resolve({ msgId: '', ok: false, error: reason });
    this.pending.clear();
  }
}

/**
 * 把一次下行里的状态合并进已有状态。
 *
 * `instant` 下 14 个子域，推送只带变化的那些；`interval` 同理。只做两层合并：
 * 顶层子域整体替换、其内部对象按键覆盖。再深没有必要——推送的子域本身就是完整的。
 */
function mergeStatus(prev: VehicleStatus | null, next: VehicleStatus): VehicleStatus {
  if (!prev) return next;
  const merged = { ...prev, ...next } as Record<string, any>;
  for (const key of ['instant', 'interval', 'digital_vehicle']) {
    const a = (prev as Record<string, any>)[key];
    const b = (next as Record<string, any>)[key];
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      merged[key] = { ...a, ...b };
    }
  }
  return merged as VehicleStatus;
}

export const carLink = new CarLink();

export { COMMANDS };
