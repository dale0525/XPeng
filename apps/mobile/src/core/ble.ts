import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import { type BleCommandOptions, type BleStage, type BleTransport } from '@xpeng/protocol/src/ble-session';
import { BleLink, type BleLinkTimers } from '@xpeng/protocol/src/ble-link';
import { base64Decode, fromHex, randomBytes, readBe, toHex } from '@xpeng/protocol/src/bytes';
import { BleV2MaterialService } from '@xpeng/protocol/src/ble-v2-material';
import { buildV2Command, validateV2Command } from '@xpeng/protocol/src/ble-v2-command';
import { decideRetry } from '@xpeng/protocol/src/proximity-retry';
import { BleV2ContextService, isP5BleV2Vehicle } from '@xpeng/protocol/src/ble-v2-context';
import type { Vehicle } from '@xpeng/protocol/src/vehicles';
import { ProximityTracker, decideScanAction, decideScanDuringAction, decideUnlockGate, decideLockGate, decideLinkAttempt, shouldLogSample, DEFAULT_PROXIMITY_CONFIG, type ProximityAction, type ProximityConfig } from '@xpeng/protocol/src/proximity';
import { parseCalibration, serializeCalibration, buildCalibrationFromMedian, type ProximityCalibration } from '@xpeng/protocol/src/proximity-calibration';
import {
  DEFAULT_SUPPRESSION, decideLinkUnderSuppression, suppressReason, suppressionPlan, type GeoPoint, type ProximitySuppression,
} from '@xpeng/protocol/src/proximity-suppression';
import { sessionStore } from './session';
import { BlePreconditionError, connectPreparedBle, type BleConnectPermissions } from './ble-connect';

type BlePermissions = BleConnectPermissions;
interface BleDevice { mac: string; name: string | null; rssi: number }
/** 只扫一台目标设备：`targetSeen` 为 false 表示这台车根本没在广播。 */
interface BleScanTargetResult { targetSeen: boolean; rssi: number | null; total: number }
interface BleNative {
  permissionStatus(): Promise<BlePermissions>;
  requestPermissions(): Promise<BlePermissions>;
  scan(timeoutMs: number): Promise<BleDevice[]>;
  scanTarget(mac: string, timeoutMs: number): Promise<BleScanTargetResult>;
  stopScan(): Promise<void>;
  connect(mac: string): Promise<void>;
  connectProfile(
    mac: string,
    serviceUuid: string | null,
    writeUuid: string | null,
    readUuid: string | null,
    writeHandle: number | null,
    readHandle: number | null,
    autoConnect: boolean,
    timeoutMs: number,
  ): Promise<void>;
  dumpServices(mac: string): Promise<Array<{ service: string; characteristics: Array<{ uuid: string; handle: number; properties: number }> }>>;
  write(mac: string, hex: string): Promise<void>;
  disconnect(mac: string): Promise<void>;
  startKeepAlive(text: string): Promise<void>;
  updateKeepAlive(text: string): Promise<void>;
  stopKeepAlive(): Promise<void>;
  /** 发一条一次性动作通知；后台也能发，不受前台服务启动限制。 */
  notifyEvent(title: string, text: string): Promise<void>;
  scheduleKeepAliveTimer(mac: string, reauth: boolean, delayMs: number): Promise<void>;
  cancelKeepAliveTimers(): Promise<void>;
  scheduleSuppressionTimer(intervalMs: number): Promise<void>;
  cancelSuppressionTimer(): Promise<void>;
  startProximityScan(mac: string): Promise<void>;
  stopProximityScan(reason: string): Promise<void>;
  logProximity(message: string): Promise<void>;
  readLinkRssi(mac: string): Promise<void>;
  startLinkRssiProbe(mac: string, intervalMs: number): Promise<void>;
  stopLinkRssiProbe(): Promise<void>;
}

const bridge = NativeModules.XpengBle as BleNative;

/** 「哪些 WiFi / 地点附近不执行」要的定位与 WiFi 探针，独立原生模块见 XpengWifiLocationModule.kt。 */
interface WifiLocationNative {
  permissionStatus(): Promise<{ granted: boolean; locationEnabled: boolean; precise?: boolean }>;
  requestPermissions(): Promise<{ granted: boolean; locationEnabled: boolean; precise?: boolean }>;
  currentSsid(): Promise<string>;
  /**
   * 取一次坐标。`timeMs` 是该定位的产生时刻——**必须校验**：
   * 原生实现拿不到新定位时会退回陈旧缓存（室内/地库必然如此），
   * 直接使用会把"15 天前的位置"当成当前位置。
   */
  currentLocation(maxAgeMs: number, timeoutMs: number): Promise<{ lat: number; lon: number; timeMs?: number; accuracyM?: number } | null>;
}
const wifiBridge = NativeModules.XpengWifiLocation as WifiLocationNative;

class NativeBleTransport implements BleTransport {
  private mac = '';
  private emitter = new NativeEventEmitter(NativeModules.XpengBle);
  async connect(mac: string) {
    this.mac = mac.toUpperCase();
    await connectPreparedBle(bridge, mac);
  }
  write(data: Uint8Array) { return bridge.write(this.mac, toHex(data)); }
  disconnect() { return bridge.disconnect(this.mac); }
  onData(callback: (data: Uint8Array) => void) {
    const sub = this.emitter.addListener('xpeng-ble-data', (value) => {
      const event = value as unknown as { mac: string; hex: string };
      if (event.mac.toUpperCase() === this.mac) callback(fromHex(event.hex));
    });
    return () => sub.remove();
  }
  onDisconnect(callback: (reason: string) => void) {
    const sub = this.emitter.addListener('xpeng-ble-disconnect', (value) => {
      const event = value as unknown as { mac: string; reason: string };
      if (event.mac.toUpperCase() === this.mac) callback(event.reason);
    });
    return () => sub.remove();
  }
}

export interface BleV2CommandOptions {
  vin: string;
  mac: string;
  keyMac: string;
  commandCode: number;
  messageId: number;
  timeoutMs?: number;
  /** Wait for the car's 0x0070 control ACK. RPA activation (0x03) has none, so it passes false. */
  expectCommandAck?: boolean;
}

/**
 * 当前持有的车辆上下文（vin + keyMac），供每次重鉴权重新取认证材料。
 * `hold()` 之前由 `prepareV2` 写入；切换车辆/账号时随 `hold` 一起更新。
 */
let holdTarget: { vin: string; keyMac: string; mac: string } | undefined;

/**
 * 每条重鉴权取一条新材料并生成独立挑战。材料一次性：`take()` 消耗后不归还，
 * 队列耗尽会自动向服务端补拉。
 */
async function authMaterialFor(): Promise<{ appN: Uint8Array; keyMac: string; verifyKey: string; verifyRandom: number }> {
  const target = holdTarget;
  if (!target) throw new Error('BLE 常驻连接缺少车辆上下文');
  const material = await materials.take(activeAccount(), target.vin);
  const appN = randomBytes(4);
  let verifyRandom: number;
  do { verifyRandom = readBe(randomBytes(4), 0, 4); } while (verifyRandom === 0xffffffff);
  return { appN, keyMac: target.keyMac, verifyKey: material.verifyCode.code, verifyRandom };
}

/**
 * 原生计时的运行器。RN 的 setTimeout 在 Activity 后台会被暂停（见 ble-link 注释），
 * 所以退避/重鉴权改由原生 Handler 计时、发事件回 JS 触发。这里只保存"到点时该跑什么"，
 * 到点事件到达后再取出来执行。
 */
let nativeRetryRun: { mac: string; run: () => void } | undefined;
let nativeReauthRun: { mac: string; run: () => void } | undefined;
const nativeTimers: BleLinkTimers = {
  retry(mac, delayMs, run) {
    nativeRetryRun = { mac: mac.toUpperCase(), run };
    void bridge.scheduleKeepAliveTimer(mac, false, delayMs).catch(() => {});
  },
  reauth(mac, delayMs, run) {
    nativeReauthRun = { mac: mac.toUpperCase(), run };
    void bridge.scheduleKeepAliveTimer(mac, true, delayMs).catch(() => {});
  },
  // 取消只丢弃待执行动作：原生计时器即便到点触发，找不到 run 也只是空转；下一次
  // schedule 会先按类型清掉同 mac 的旧计时器（见 XpengBleModule.scheduleKeepAliveTimer）。
  cancelRetry() { nativeRetryRun = undefined; },
  cancelReauth() { nativeReauthRun = undefined; },
};
const bleEmitter = new NativeEventEmitter(NativeModules.XpengBle);
bleEmitter.addListener('xpeng-ble-retry-due', (value) => {
  const pending = nativeRetryRun;
  const e = value as unknown as { mac: string };
  if (!pending || pending.mac !== e.mac.toUpperCase()) return;
  nativeRetryRun = undefined;
  pending.run();
});
bleEmitter.addListener('xpeng-ble-reauth-due', (value) => {
  const pending = nativeReauthRun;
  const e = value as unknown as { mac: string };
  if (!pending || pending.mac !== e.mac.toUpperCase()) return;
  nativeReauthRun = undefined;
  pending.run();
});

/**
 * 通知条文案只描述「现在实际在跑什么」。
 *
 * 之前文案跟着最后一条事件走，于是回前台停掉扫描后没人改它：通知一直挂着
 * 「靠近自动解闭锁运行中」，而扫描早已停了——用户据此以为功能在跑。这里由状态
 * 直接推出文案，前后台切换与连接变化都走同一个出口，不会漏。
 */
function syncKeepAlive(): void {
  const text = !appForeground
    ? '靠近自动解闭锁运行中'
    : link.connected
      ? '已连接车辆，蓝牙钥匙保持可用'
      : '正在连接车辆蓝牙';
  void bridge.updateKeepAlive(text);
}

const link = new BleLink(new NativeBleTransport(), authMaterialFor, {
  timers: nativeTimers,
  // 常驻模式下一次操作收尾也会报 disconnected，但那只是会话结束、连接还在，
  // 直接透传会让状态行显示「蓝牙连接已断开」而实际仍连着。
  onStage: (stage) => setOperationStage(stage === 'disconnected' && link.connected ? 'authenticated' : stage),
  isPermanentError: (error) => error instanceof BlePreconditionError,
  onStateChange: (state) => {
    if (state.kind === 'connected') {
      syncKeepAlive();
      // 任何途径建连成功后都必须停扫描并开连接态探针。
      //
      // 原来只有 enterLinkMode（扫描扫到车）会做这两件事，其余路径——前台 holdLink、
      // 手动车控建连、**以及 BleLink 自己的后台退避重连**——都会留下「连着但无读数」：
      // 车端一连上就停广播，扫描只能收到 null，而 link.connected 又挡住了 enterLinkMode，
      // 判距器于是彻底失明。2026-11-24 实测：21:21:57 退避重连抢先建连，之后 23 秒
      // 用户站在车旁 0 个有效 RSSI，只能手动解锁。
      void onLinkEstablished(state.mac);
    } else if (state.kind === 'backoff') {
      // 首次尝试就失败说明「从来没连上」，与「连着又掉了」是两回事：人离车几十米时
      // 每次都落在前一种，写「已断开」会让用户以为刚才还连着。
      void bridge.updateKeepAlive(
        state.attempts <= 1 ? '未发现车辆蓝牙，正在重试' : '连接已断开，正在重连',
      );
    } else if (state.kind === 'idle') {
      // 后台只扫描时连接本来就不该存在（release 必然报 idle），此时服务是扫描的载体，
      // 停了它后台判距立刻失效、进程也会被当普通后台进程回收。只有开关也关着才停服务。
      if (!proximityEnabled) void bridge.stopKeepAlive();
      else syncKeepAlive();
    }
    // 链路掉线：停掉连接态 RSSI 探针，并退回扫描态。
    //
    // 不退回去就会卡在"既没连接、也没扫描"的空档里——判距彻底停摆，用户看到的是
    // 功能开着却什么都不发生。holdLink 自带退避重连，重连成功后下一轮扫描会重新
    // 触发 enterLinkMode。
    // 同一次断开会被上报多次（实测启动时 idle 连报两次，间隔约 100 ms；退避重连
    // 期间 backoff 会每隔几秒再报一次）。逐次处理会重复停探针、重复起扫——起扫要
    // 先停扫描再启动，两次叠在一起会互相打断。
    //
    // 用时间去抖不够：退避期长达数十秒，每轮上报都落在窗口外，日志里就是每隔几秒
    // 刷一条。改成"一次断开只处理一次"——从连上到下次连上之间，无论上报多少次都
    // 只处理并记录一次；真正重新连上才复位。
    if (state.kind === 'connected') {
      disconnectHandled = false;
    } else if (state.kind !== 'connecting' && !disconnectHandled) {
      disconnectHandled = true;
      // 掉线是"为什么突然不判距了"的第一嫌疑，必须留痕。
      void bridge.logProximity(`link dropped (state=${state.kind}), falling back to scan`);
      linkFeedMac = null;
      void bridge.stopLinkRssiProbe().catch(() => {});
      if (proximityEnabled && !scanRunning && proximityMac) {
        void startScanUnlessSuppressed().catch(() => {});
      }
      // 退回扫描态必须把常驻链路真正放掉。
      //
      // 原先只是"退回去扫描"，BleLink 仍 held=true，继续按退避每 10 s 重连一次；
      // 扫描与建连争同一个控制器，重连还必然吃 133。2026-11-24 实测：12:41 离车后
      // 这个僵尸状态持续 8 小时 40 分、空转 2356 次建连超时，最后退避重连抢在扫描
      // 之前连上，判距反而失明（见 onLinkEstablished 的注释）。
      // 释放是安全的：hold() 会在下一次需要时重新建立。
      if (proximityEnabled) {
        disconnectHandled = true;
        void link.release().catch(() => {});
        void bridge.logProximity('released held link, staying on scan');
      }
    }
    publishState();
  },
});
const materials = new BleV2MaterialService((path, body) => sessionStore.call(path, body));
const contexts = new BleV2ContextService((path, body) => sessionStore.call(path, body), materials);
export type BleV2ContextState = { kind: 'idle' }
  | { kind: 'preparing' | 'ready'; vin: string }
  | { kind: 'error'; vin: string; reason: string };
export type BleV2UiState = {
  phase: 'idle' | 'preparing' | 'ready' | 'backoff' | 'error' | BleStage;
  label: string;
  connected: boolean;
  error?: string;
};
let contextState: BleV2ContextState = { kind: 'idle' };
let operationStage: BleStage | undefined;
let operationError: string | undefined;
const stateListeners = new Set<(state: BleV2UiState) => void>();

const STAGE_LABELS: Record<BleStage, string> = {
  connecting: '正在连接车辆蓝牙',
  authenticating: '正在进行数字钥匙认证',
  authenticated: '数字钥匙认证通过',
  command: '已下发蓝牙指令',
  disconnected: '蓝牙连接已断开',
};

function uiState(): BleV2UiState {
  if (operationError) {
    return { phase: 'error', label: '蓝牙操作失败', connected: false, error: operationError };
  }
  const stage = operationStage;
  if (stage) {
    const label = stage === 'disconnected' && contextState.kind === 'ready'
      ? `${STAGE_LABELS[stage]} · 蓝牙钥匙已就绪`
      : STAGE_LABELS[stage];
    return {
      phase: stage,
      label,
      connected: stage === 'authenticating' || stage === 'authenticated' || stage === 'command',
    };
  }
  switch (contextState.kind) {
    case 'idle': return { phase: 'idle', label: '蓝牙未准备', connected: false };
    case 'preparing': return { phase: 'preparing', label: '正在准备蓝牙钥匙', connected: false };
    case 'ready': return readyState();
    case 'error': return {
      phase: 'error',
      label: '蓝牙钥匙准备失败',
      connected: false,
      error: contextState.reason,
    };
  }
}

/** 钥匙物料就绪后，「就绪」还要再分连接是否真的持有：常驻连接的可见状态就是这个。 */
function readyState(): BleV2UiState {
  const state = link.current;
  switch (state.kind) {
    case 'connected': return { phase: 'ready', label: '蓝牙钥匙已连接 · 保持中', connected: true };
    case 'connecting': return { phase: 'connecting', label: '正在连接车辆蓝牙', connected: false };
    case 'backoff': return {
      phase: 'backoff',
      label: `蓝牙连接已断开，${Math.round(state.retryInMs / 100) / 10} s 后重连`,
      connected: false,
    };
    case 'idle': return { phase: 'ready', label: '蓝牙钥匙已就绪', connected: false };
  }
}

function publishState() {
  const state = uiState();
  for (const listener of stateListeners) listener(state);
}

function setContextState(next: BleV2ContextState) {
  contextState = next;
  publishState();
}

function setOperationStage(stage: BleStage) {
  // 每次阶段跃迁都落盘：建连、认证、下发、断开的准确时刻是算延迟的唯一依据。
  void bridge.logProximity(`stage ${stage}`);
  operationStage = stage;
  publishState();
}
let accountId: string | number | undefined;
let accountGeneration = 0;
let operationActive = false;
let operationAbort: AbortController | undefined;
sessionStore.subscribe(state => {
  const next = state.kind === 'active' ? state.session.uid : undefined;
  if (state.kind !== 'active' || next !== accountId) {
    accountGeneration++;
    operationAbort?.abort(new Error('BLE V2 account changed during operation'));
    void link.release();
    materials.reset();
    contexts.reset();
    operationError = undefined;
    operationStage = undefined;
    setContextState({ kind: 'idle' });
  }
  accountId = next;
});

function activeAccount(): string | number {
  const state = sessionStore.current;
  if (state.kind !== 'active') throw new Error('BLE V2 requires an active account');
  return state.session.uid;
}

async function execute(options: BleCommandOptions) {
  if (operationActive) throw new Error('BLE operation already running');
  operationActive = true;
  try {
    return await link.execute(options);
  } finally {
    operationActive = false;
  }
}

async function executeV2(options: BleV2CommandOptions) {
  const account = activeAccount();
  if (operationActive) throw new Error('BLE operation already running');
  validateV2Command(options.commandCode, options.messageId);
  operationError = undefined;
  operationStage = undefined;
  operationActive = true;
  const controller = new AbortController();
  operationAbort = controller;
  const generation = accountGeneration;
  try {
    const material = await materials.take(account, options.vin);
    if (generation !== accountGeneration) throw new Error('BLE V2 account changed during request');
    const appN = randomBytes(4);
    let verifyRandom: number;
    do { verifyRandom = readBe(randomBytes(4), 0, 4); } while (verifyRandom === 0xffffffff);
    return await link.execute({
      mac: options.mac,
      keyMac: options.keyMac,
      commandCode: options.commandCode,
      timeoutMs: options.timeoutMs,
      appN,
      verifyKey: material.verifyCode.code,
      verifyRandom,
      signal: controller.signal,
      expectCommandAck: options.expectCommandAck,
      frame: buildV2Command(base64Decode(material.message), options.commandCode, options.messageId),
    });
  } catch (error) {
    operationError = error instanceof Error ? error.message : String(error);
    operationStage = undefined;
    publishState();
    throw error;
  } finally {
    operationAbort = undefined;
    operationActive = false;
  }
}

/**
 * 钥匙物料就绪后开始持有连接。
 *
 * 连不上不算准备失败：物料已经在手，失败的是链路。混进 `prepareV2` 的异常分支
 * 会让 UI 报「蓝牙钥匙准备失败」，并把已经取到手的物料判成不可用。
 */
async function holdLink(mac: string): Promise<void> {
  try {
    // 常驻连接要先有蓝牙权限；在这里申请，用户不必先点一次车控再被要求授权。
    await bridge.requestPermissions();
  } catch (error) {
    console.warn('[ble] 蓝牙权限申请失败:', error instanceof Error ? error.message : String(error));
  }
  try {
    // 前台服务必须趁 App 还在前台拉起：Android 12 起从后台启动会直接被拒。
    // 它与连接本身无关，拉不起来只影响「退到后台还能不能活」，不该连累连接。
    await bridge.startKeepAlive('正在连接车辆蓝牙');
  } catch (error) {
    console.warn('[ble] 前台保活服务启动失败:', error instanceof Error ? error.message : String(error));
  }
  try {
    await link.hold(mac);
  } catch (error) {
    console.warn('[ble] 常驻连接未能建立:', error instanceof Error ? error.message : String(error));
  }
}

async function prepareV2(vin: string) {
  const account = activeAccount();
  const generation = accountGeneration;
  operationError = undefined;
  operationStage = undefined;
  setContextState({ kind: 'preparing', vin });
  try {
    const context = await contexts.prepare(account, vin);
    if (generation !== accountGeneration) throw new Error('BLE V2 account changed during preparation');
    holdTarget = { vin, keyMac: context.keyMac, mac: context.mac };
    setContextState({ kind: 'ready', vin });
    await holdLink(context.mac);
    // 开关可能在物料就绪之前就打开了（设置页先拨、车辆列表后到），这里补拉起扫描。
    if (proximityEnabled) await setProximityEnabled(true, vin);
    return context;
  } catch (error) {
    if (generation === accountGeneration) {
      setContextState({ kind: 'error', vin, reason: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

async function autoPrepareV2(vehicle: Vehicle): Promise<void> {
  if (!isP5BleV2Vehicle(vehicle)) return;
  await prepareV2(vehicle.vin);
}

/**
 * 车不在蓝牙范围内。
 *
 * 与「连上了但握手失败」要区分开：前者说明这台车现在根本没在广播，蓝牙这条路
 * 走不通，路由应当直接改走云端；后者仍值得在蓝牙上重试。
 *
 * 用 `name` 而不是 `instanceof` 跨包传递：路由在 `packages/protocol` 里，不能反向
 * 依赖 App 的模块，只能按名字认这个错误。
 */
export class BleOutOfRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleOutOfRangeError';
  }
}

/**
 * 车在不在蓝牙范围内：扫一眼目标广播，扫不到就别去连。
 *
 * 蓝牙连接超时 3 秒，但一次锁车还要算上认证与回执；人已经走远时，这三秒和后面
 * 那些步骤全是白等。扫描比建连便宜得多（实测 1.5 s 一轮就能覆盖车旁范围），
 * 而且能明确回答「这台车现在根本没在广播」——那是「走云端」的充分理由，
 * 与「车在附近但这次握手失败」不是一回事，后者仍值得用蓝牙重试。
 *
 * 扫不到不等于一定在范围外（广播是间歇的、人体遮挡也会丢包），所以只在
 * **连续两轮都没扫到** 时才判定不在范围内；扫到一次就按在范围内处理。
 */
async function vehicleInBleRange(mac: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await bridge.scanTarget(mac, 1500);
      if (result.targetSeen) return true;
    } catch {
      // 扫描失败（权限、控制器被占用）不能当成「车不在附近」：那会让车旁的人
      // 也被推去走云端。返回 true 让调用方照常尝试蓝牙。
      return true;
    }
  }
  return false;
}

/**
 * 前台车控入口。先确认车在不在蓝牙范围内，不在就直接抛 `BleOutOfRangeError`
 * 让路由改走云端，不再花时间做注定失败的建连。
 *
 * 只对**临时建连**的场景做这个判断：常驻连接已连着时（`link.connected`）说明
 * 车就在旁边，没必要多扫一轮。
 */
async function executePreparedV2(vin: string, commandCode: number, expectCommandAck = true) {
  const context = contexts.get(activeAccount(), vin);
  if (!context) throw new Error('BLE V2 vehicle context is not prepared');
  if (!link.connected && !(await vehicleInBleRange(context.mac))) {
    throw new BleOutOfRangeError('车辆不在蓝牙范围内');
  }
  return executeV2({ ...context, commandCode, expectCommandAck });
}

/** Automatic preparation is HTTP-only; radio control remains an explicit call. */
/**
 * 后台靠近解闭锁。
 *
 * 分工（用户已确认）：App 在前台才持有连接；退到后台就释放连接、只跑扫描。
 * 人靠过来/走开时才临时连一次、认证、发一条解/闭锁指令，然后断开。
 *
 * 扫描节奏与解闭锁判定都不在 JS 定时器里：息屏进 Doze 后 RN 的 setTimeout 不触发
 * （实测被踢后数分钟零重连），所以扫描环跑在原生侧、按窗回传 RSSI 事件，JS 只做
 * 状态判定与执行。事件本身在后台仍可达（实测「断开→改通知」在后台照常执行）。
 */
/** 判距器按当前生效阈值构建；标定完成后会用新阈值重建。 */
let proximityTracker = new ProximityTracker();
/**
 * 被抑制时多久复查一次 WiFi / 坐标。
 *
 * 抑制条件的真实变化都是分钟级的（走出 WiFi 覆盖、离开那个地点），20 s 足够及时；
 * 又不必像判距那样 1.5 s 一轮——抑制期间既不扫蓝牙、也不该频繁唤醒定位。
 */
const SUPPRESSION_RECHECK_MS = 20_000;
/** 已标定的阈值；空表示还没标定，用的是 DEFAULT_PROXIMITY_CONFIG。 */
let calibration: ProximityCalibration | null = null;
/**
 * 「哪些 WiFi / 哪些地点附近不执行」的名单。空名单时整条抑制链一次探针都不会发，
 * 所以没配过的人不会为这个功能付任何耗电。
 */
let suppression: ProximitySuppression = DEFAULT_SUPPRESSION;
let proximityEnabled = false;
let proximityVin: string | undefined;
let proximityMac: string | undefined;
let proximityBusy = false;
/**
 * 动作忙锁的最近一次置位时刻。
 *
 * `proximityBusy` 挡住连接态 RSSI 的入口（见 xpeng-ble-link-rssi 监听器），一旦
 * 漏复位，判距就彻底停摆：2026-11-23 实测 12:06 之后 sample 一条不写、而 probe 读数
 * 照常刷到 12:44（1511 条），功能静默失效 9 小时。根因是 runProximityActionWithRetry
 * 里两条早退（!vin / !context）直接 return，绕过了复位。
 *
 * 两条早退已补复位；这里再加一道超时兜底——即便将来又漏一处，最多卡 30 秒，
 * 不会整天停摆。取 30 秒：正常一次动作（建连 1.2~1.7 s + 三次握手 + 回执）远小于它。
 */
const PROXIMITY_BUSY_TTL_MS = 30_000;
let proximityBusyAt = 0;

/** 忙锁是否仍然有效；过期就当没锁，并顺手复位。 */
function proximityBusyActive(): boolean {
  if (!proximityBusy) return false;
  if (Date.now() - proximityBusyAt <= PROXIMITY_BUSY_TTL_MS) return true;
  proximityBusy = false;
  void bridge.logProximity('proximity busy lock expired after 30s, reset');
  return false;
}
/** 原生扫描是否真的在跑；与「开关是否打开」是两件事，不能互相代替。 */
let scanRunning = false;
/** App 是否在前台；前台持连接、后台只扫描，两者互斥（车端连上就不广播）。 */
let appForeground = AppState.currentState === 'active';

/**
 * 车辆是否在行驶（`speed > 0`）。
 *
 * 只存布尔：`speed` 的单位未证实，但「大于 0 即在动」与单位无关。
 * 初值 null 表示还没收到过车辆状态——此时门控放行，不能因为缺数据就挡住解锁。
 */
let vehicleMoving: { moving: boolean; at: number } | null = null;

/**
 * 车辆是否已锁（`driver_door_lock_st === 1`）。
 *
 * 用来校准判距器的「是否解锁」状态——解闭锁的真实结果只有车知道，本地"我发成功了"
 * 不可靠（失败时状态会停错）。初值 null = 不知道，校准器会维持原值不覆盖。
 */
let vehicleLocked: { locked: boolean; at: number } | null = null;

/**
 * 驾驶位是否有人（`instant.seat.driver_seat_state === 1`）。
 *
 * 用来区分「等红灯」与「走回车旁」：两者在车速、车锁、信号强度上完全一致
 * （车速都归零、车都锁着、车内信号都很强），唯一差别就是驾驶位有没有人。
 * 2026-11-19 上下车实测确认该字段双向可靠：人不在 0、坐上 1、下车后刷新回 0。
 *
 * 与车速同样带保质期：它只在状态变化时推送，人下车不落锁不熄火时可能长期停在 1，
 * 过期即视为不知道，退回不拦（见 decideUnlockGate）。
 */
let vehicleSeated: { seated: boolean; at: number } | null = null;

/**
 * 云端锁车通道：蓝牙发不出去时用它兜底。
 *
 * 闭锁天然发生在"人已走远、蓝牙已断"的时刻，而 BLE 指令必须有一条活着的链路。
 * 2026-11-20 实测：车锁着走远，阈值闭锁因闭锁线被标定到 -108（-93-15，蓝牙根本
 * 到不了）永远触发不了，只剩"失联 9 秒"兜底，可它触发时链路刚断，`action=lock
 * failed: BLE link is not connected`，车一直没锁。云端 MQTT（service_type 9 /
 * cmd_type 1）不依赖近距离，正是补这个缺口。
 *
 * 由 App 层注入（car₂ 依赖本模块同层组件，反向 import 会成环）：
 * 先执行 BLE，失败再发云端；返回是否最终成功。
 */
let cloudLock: (() => Promise<boolean>) | null = null;

/**
 * 周期拉一次车辆状态的通道（App 层用 carLink.readStatus 实现）。
 *
 * 为什么必须周期拉：车速 / 驾驶位 / 车锁这三个字段**只在状态变化时推送**
 * （实测静止车辆 60 秒零推送）。而解闭锁的两个否决门控都靠保质期判断新鲜度，
 * 停在路口等红灯恰恰是「状态不再变化」的典型——于是门控会在 60 秒后自动失效。
 * 2026-11-24 实测：12:00:09 起连续 21 次 `blocked: driver seated` 拦了 90 秒，
 * 12:01:44 座椅状态过期，随即在车内自动解锁。不刷新就等于「任何超过 60 秒的红灯
 * 都会被解锁」，这不是偶发，是设计上的必然。
 *
 * 同理，解锁/闭锁成功后本地缓存的车锁状态会停在旧值：下一轮 calibrate 又把它
 * 校准回「未解锁/已解锁」，于是动作被反复重发（同一天实测连解 4 次、连锁 7 次）。
 * 周期刷新是这条的根治手段，TTL 只是刷新失败时的兜底。
 */
let refreshVehicleState: (() => Promise<void>) | null = null;

/** 上一次成功续期车辆状态的时刻。 */
let vehicleStateRefreshedAt = 0;

/**
 * 车辆状态的续期周期。必须明显小于最短的门控保质期（座椅 60 s），
 * 取 30 s 留出一次读状态的往返（实测 3–12 s）与一次心跳错过的余量。
 */
const VEHICLE_STATE_REFRESH_MS = 30_000;

/**
 * 车锁状态的保质期。
 *
 * 比续期周期长一档：正常情况每 30 s 就会被刷新，这里留到 90 s 才判过期，
 * 容得下两次刷新失败（例如后台网络短暂断掉），又不会让一份几分钟前的锁状态
 * 一直推翻刚成功的解闭锁动作。过期即视为"不知道"，判距器维持原值。
 */
const LOCK_STATE_TTL_MS = 90_000;

/** 车速字符串 -> 是否在动。解析不出数字时返回 null（按"不知道"处理）。 */
function parseMoving(speed: unknown): boolean | null {
  const n = typeof speed === 'number' ? speed : Number.parseFloat(String(speed ?? ''));
  if (!Number.isFinite(n)) return null;
  return n > 0;
}

/**
 * 判一次「现在该不该被抑制」。
 *
 * 省电靠两件事：配置为空时一次探针都不发；有坐标配置时先读 WiFi，命中就不再唤醒定位。
 *
 * 拿不到定位返回 `'unknown'`，**按"抑制"处理**：配了坐标规则却拿不到位置时，无法
 * 证明人不在抑制区，这时放行等于让那条规则静默失效——2026-11-12 的「设了 100 米
 * 还在一直解闭锁」就是这么来的。宁可少解锁一次，也不能在明确设了禁区的屋里解锁。
 * 定位是异步的，拿不到也会在下一个复查周期重试，人一走出屋子立刻恢复。
 *
 * 位置优先用系统缓存的 last-known（120 s 内直接用）；缓存过期时允许原生要一次新定位，
 * 上限 6 s。原先是 `timeoutMs=0`（永不请求），配合"过期即无位置"的判法，导致静止在家时
 * 系统不更新 last-known → 永远拿不到位置 → 100 m 半径规则永不生效（2026-11-12 故障）。
 * 实测主动请求 4 s 内可返回；6 s 上限保证"人站在车边"时解锁不会被拖长。
 */
/** 缓存精确权限结果，避免每 20 秒的复查都跨桥问一次原生。 */
let preciseLocationKnown: boolean | null = null;

async function lacksPreciseLocation(): Promise<boolean> {
  if (preciseLocationKnown !== null) return !preciseLocationKnown;
  try {
    const status = await wifiBridge.permissionStatus();
    // 老版本原生模块没有 precise 字段：退回"只要授权了就算有"，保持向后兼容。
    preciseLocationKnown = status.precise ?? status.granted;
  } catch {
    preciseLocationKnown = false;
  }
  return !preciseLocationKnown;
}

async function isSuppressed(): Promise<'wifi' | 'place' | 'unknown' | null> {
  const plan = suppressionPlan(suppression);
  if (!plan.probeWifi) return null;
  // 没有精确定位时抑制整体不可用：读不到 SSID、坐标误差 1~3 km。此时**放行**
  // （当作没配规则），而不是当成"在禁区里"——后者会让功能永久不解锁，
  // 而前者最坏只是在该挡的地方没挡，用户仍能手动解闭锁。
  if (await lacksPreciseLocation()) {
    void bridge.logProximity('suppression skipped: no precise location');
    return null;
  }
  let ssid: string | null = null;
  try { ssid = await wifiBridge.currentSsid(); } catch { ssid = null; }
  if (suppressReason({ rules: suppression, ssid, location: null }) === 'wifi') return 'wifi';
  if (!plan.probeLocation) return null;
  let location: GeoPoint | null = null;
  try {
    const fix = await wifiBridge.currentLocation(120_000, 6_000);
    if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lon)) location = { lat: fix.lat, lon: fix.lon };
  } catch { location = null; }
  // 有坐标规则却拿不到位置：不能证明自己在禁区外，按抑制处理。
  if (location === null) return 'unknown';
  return suppressReason({ rules: suppression, ssid: null, location });
}

/** 一条靠近/离开动作：临时连一次、认证、发指令。失败只记录，不打断扫描环。 */
/**
 * 发一条动作；失败按 RETRY_POLICY 重试。
 *
 * 2026-11-12 真车实测：走到 50 m 外触发闭锁，两次都失败（`BLE operation timeout`
 * 等满 10 s、`GATT disconnected: 133`），原实现 catch 完就结束，而状态机早已把
 * nearby 置 false，于是**再也不重试**——用户看到的是"只解锁、从不闭锁"。
 * 闭锁恰好发生在信号最弱、人正走远的时刻，一次失败就放弃等于功能不成立。
 */
async function runProximityActionWithRetry(action: ProximityAction, attempt = 1): Promise<void> {
  const vin = proximityVin;
  // 这两条早退必须自己复位忙锁：调用方 runProximityAction 已把 proximityBusy 置 true，
  // 直接 return 会让它永远停在 true，连接态 RSSI 全被丢弃，判距静默停摆
  // （2026-11-23 实测停了 9 小时）。重试链的上一环也会在 finally 里复位，
  // 但早退发生在 try 之外，等不到那里。
  if (!vin) {
    proximityBusy = false;
    void bridge.logProximity(`action=${action} abandoned: no target vin`);
    return;
  }
  const context = contexts.get(activeAccount(), vin);
  if (!context) {
    proximityBusy = false;
    void bridge.logProximity(`action=${action} abandoned: no vehicle context`);
    return;
  }
  const mac = proximityMac;
  if (scanRunning) {
    scanRunning = false;
    await bridge.stopProximityScan('action starting').catch(() => {});
  }
  let failed = false;
  let message = '';
  try {
    await executeV2({ ...context, commandCode: action === 'unlock' ? 1 : 2 });
    void bridge.logProximity(`action=${action} ok${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
    // 动作成功后立刻让缓存里的车锁状态过期，下一轮判距马上补一次真实状态。
    //
    // 不这样做，缓存会停在动作前的那一刻：解锁成功后仍记着"已锁"，于是 calibrate
    // 每轮把判距器压回未解锁，4.5 s 后又满足进入条件、再发一次解锁。2026-11-24 实测
    // 22 秒内连解 4 次；同一天离车后连续 7 次云端闭锁也是同一机制（缓存停在"未锁"，
    // 每轮都判成该锁）。单纯给缓存加保质期治不了这个——它在保质期内仍然有效，
    // 而这 4.5 s 的重复周期远短于任何合理保质期。
    vehicleStateRefreshedAt = 0;
  } catch (error) {
    failed = true;
    message = error instanceof Error ? error.message : String(error);
    void bridge.logProximity(`action=${action} failed: ${message}`);
  } finally {
    // 恢复判距；重试期间也要恢复，否则下一次靠近就再也不会触发。
    if (decideScanDuringAction({ enabled: proximityEnabled, foreground: appForeground, hasMac: Boolean(mac), linkHeld: link.connected }) === 'resume') {
      scanRunning = true;
      await bridge.startProximityScan(mac!).catch(() => { scanRunning = false; });
    }
  }
  if (!failed) {
    // 自动锁车成功要告诉用户：这是发生在后台、人已经走开的动作，不给反馈的话
    // 用户无法确认车到底锁没锁（2026-11-15 就是因为没有反馈，只能掏出官方 App 核对）。
    if (action === 'lock') {
      void bridge.notifyEvent('已自动锁车', '离开车辆后已自动上锁').catch(() => {});
    }
    return;
  }
  // 闭锁天然发生在"人已走远、蓝牙已断"的时刻，BLE 这条路在这种场景下基本必失败
  // （2026-11-20 实测：`action=lock failed: BLE link is not connected`）。先走云端兜底——
  // 它不依赖距离，是这种场景下唯一能可靠把车锁上的通道。云端成功就不再空耗 BLE 重试。
  if (action === 'lock' && cloudLock) {
    try {
      const ok = await cloudLock();
      if (ok) {
        void bridge.logProximity('action=lock ok (cloud fallback)');
        void bridge.notifyEvent('已自动锁车', '离开车辆后已通过云端上锁').catch(() => {});
        // 同上：云端锁成功也要立刻让本地车锁缓存失效，否则会连续重复下发。
        vehicleStateRefreshedAt = 0;
        return;
      }
      void bridge.logProximity('action=lock cloud fallback failed');
    } catch (error) {
      void bridge.logProximity(
        `action=lock cloud fallback error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // 闭锁重试前若人又回到附近，放弃：不能把人锁在车边。
  // 不再把"车解锁"当成"人回到车边"：车锁着也可能是人站在车旁正准备解锁，
  // 车开着也可能是人已走远但车没锁。那不是一个可用的"人在附近"判据。
  // 这里只按重试次数退避，不再因状态提前放弃。
  const decision = decideRetry({ action, failed, attempt });
  if (!decision.retry) {
    void bridge.logProximity(
      `action=${action} give up after ${attempt} attempt(s): ${decision.abandonReason ?? 'unknown'}`,
    );
    return;
  }
  void bridge.logProximity(`action=${action} retry #${attempt} in ${decision.delayMs} ms`);
  await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
  // 等待期间开关可能被关掉，或被新的动作占用。
  if (!proximityEnabled || proximityBusyActive()) return;
  proximityBusy = true;
  proximityBusyAt = Date.now();
  try {
    await runProximityActionWithRetry(action, attempt + 1);
  } finally {
    proximityBusy = false;
  }
}

async function runProximityAction(action: ProximityAction): Promise<void> {
  if (proximityBusyActive()) return;
  const vin = proximityVin;
  if (!vin) return;
  const context = contexts.get(activeAccount(), vin);
  if (!context) return;
  proximityBusy = true;
  proximityBusyAt = Date.now();
  // release 包下 JS 的 console.warn 不进 logcat，触发链只能靠原生打点观察。
  void bridge.logProximity(`action=${action} start`);
  const mac = proximityMac;
  const suppressed = await isSuppressed();
  if (suppressed !== null) {
    // 兜底：抑制条件在扫描期间也可能变（比如中途连上了名单里的 WiFi），那时扫描
    // 已经在跑，只有这里能拦住。正常路径下被抑制时扫描根本不会启动。
    void bridge.logProximity(`action=${action} skipped by ${suppressed}`);
    proximityBusy = false;
    return;
  }
  // 行驶门控：车在动时人不可能站在车旁，**解锁与闭锁都不做**。
  // 这是语义判断，不受多径/漏扫/坐标系影响，是本功能里最可靠的一条判据。
  // 闭锁也挡的理由：车开走时信号本来就在快速变弱，容易被误判成"人走远了"而误锁，
  // 而人根本没走——这时锁车没有意义，还可能打断正在进行的其他车控。
  const moving = vehicleMoving;
  const movingAge = moving ? Date.now() - moving.at : undefined;
  const seated = vehicleSeated;
  const seatAge = seated ? Date.now() - seated.at : undefined;
  const gate = action === 'unlock'
    ? decideUnlockGate({
        moving: moving?.moving ?? null,
        ageMs: movingAge,
        driverSeated: seated?.seated ?? null,
        seatAgeMs: seatAge,
      })
    : decideLockGate({ moving: moving?.moving ?? null, ageMs: movingAge });
  if (gate === 'block') {
    // 两种否决要分开记：行驶中与「人坐在驾驶位」是不同原因，事后排查不能混在一起。
    const why = seated?.seated === true && moving?.moving !== true
      ? 'driver seated'
      : 'vehicle moving';
    void bridge.logProximity(`action=${action} blocked: ${why}`);
    proximityBusy = false;
    return;
  }
  // 建连前必须停扫描：实测扫描在跑时 GATT 建连直接吃 `133`
  // (GATT_CONN_FAIL_ESTABLISH)，重试也落在同一窗口里失败。两者共用同一个控制器。
  if (scanRunning) {
    scanRunning = false;
    await bridge.stopProximityScan('action starting').catch(() => {});
  }
  try {
    await runProximityActionWithRetry(action);
  } finally {
    proximityBusy = false;
  }
}

const proximityEmitter = new NativeEventEmitter(NativeModules.XpengBle);
proximityEmitter.addListener('xpeng-ble-proximity-rssi', (value) => {
  const event = value as unknown as { mac: string; rssi: number | null; round: number };
  // 标定期间不做判距（采样走连接态，见 startCalibration）。
  if (calibrating) return;
  if (!proximityEnabled || !proximityMac) return;
  if (event.mac.toUpperCase() !== proximityMac) return;
  // 扫到车了（任何强度）：从扫描态转连接态。
  //
  // 为什么"有信号就切"而不是设一个可疑门槛：连接态 RSSI 每 1.5 s 刷新、零丢失
  // （2026-11-19 实测，走动 32 dB 全程跟随），所以切过去信息只会更准、不会更差；
  // 而门槛本身需要额外标定、还会让"该精测时没切"。这是自用项目，接受在
  // 有信号/无信号交界处反复建连——建链 1.2~1.7 s，且 ble-link 自带退避，
  // 不会疯狂重试。真正的耗电大头（人在家里且车停得近）已由抑制检查挡住。
  if (typeof event.rssi === 'number' && !link.connected && !proximityBusyActive()) {
    void enterLinkMode();
    return;
  }
  feedProximity(event.rssi);
});

/** 上一次建连失败的时刻；用于 5 秒退避，避免"扫到就建连"反复撞墙。 */
let lastLinkFailureAt: number | null = null;

/** 本次断开是否已处理；连上时复位。退避期会持续上报非连接态，只该处理一次。 */
let disconnectHandled = false;

/**
 * 详细日志开关。
 *
 * 关着时只记关键事件（触发、建连、抑制、失败）；打开后把每轮 RSSI、状态切换、
 * 建连耗时都写进日志文件。不分开的话每轮 1.5 s 一条明细几分钟就把 8 MB 滚满，
 * 真正要查的那几行会被冲掉。
 */
let verboseLog = false;

/**
 * 扫描态 → 连接态：停扫描、建常驻连接，之后改读连接态 RSSI 判距。
 *
 * 必须先停扫描再建连：两者共用同一个控制器，扫描在跑时建连直接吃 `133`
 * （GATT_CONN_FAIL_ESTABLISH）。
 */
async function enterLinkMode(): Promise<void> {
  const mac = proximityMac;
  if (!mac || link.connected) return;
  // 建连失败后 5 秒内不再尝试：扫描马上又会扫到车，否则会变成
  // "扫描→建连失败→退回扫描→再建连失败"的快速循环（车端连接槽被占用时尤其糟）。
  if (decideLinkAttempt({ lastFailureAtMs: lastLinkFailureAt, nowMs: Date.now() }) === 'wait') {
    return;
  }
  void bridge.logProximity('switch scan -> link (target seen)');
  const linkStartAt = Date.now();
  if (scanRunning) {
    scanRunning = false;
    await bridge.stopProximityScan('switching to link mode').catch(() => {});
  }
  // holdLink 内部会拉起前台保活服务并建链；失败时保持扫描态，不阻塞功能。
  await holdLink(mac).catch(() => {});
  if (!link.connected) {
    lastLinkFailureAt = Date.now();
    void bridge.logProximity('link mode failed, staying on scan (backoff 5s)');
    if (proximityEnabled) await startScanUnlessSuppressed().catch(() => {});
    return;
  }
  // 连上了就清掉失败时刻，下次正常切换不受影响。
  lastLinkFailureAt = null;
  // 建连耗时是排查"解锁慢"的关键：它直接加在响应时间上。
  void bridge.logProximity(`link mode ready in ${Date.now() - linkStartAt} ms`);
  await startLinkRssiFeed(mac);
}

/** 判距器喂样本（扫描态与连接态共用同一条判定路径）。 */
/**
 * 标定进行中的标记。
 *
 * 标定期间读数只进标定样本，**不参与判距**：否则用户站在"希望解锁的位置"静置
 * 十几秒，会先触发一次自动解锁，把标定过程变成一次真实车控动作。
 */
let calibrating = false;

/**
 * 车辆状态快过期时补拉一次。
 *
 * 门控的保质期是拿"最后一次收到状态"的时刻算的，而车停稳后不再推送，
 * 所以不主动续期就必然过期（见 refreshVehicleState 注入处的注释）。
 */
async function refreshVehicleStateIfStale(): Promise<void> {
  if (!refreshVehicleState) return;
  if (!proximityEnabled) return;
  if (Date.now() - vehicleStateRefreshedAt < VEHICLE_STATE_REFRESH_MS) return;
  // 先记时刻再拉：读状态本身要 3–12 s，期间每 1.5 s 一轮判距都会经过这里，
  // 不先标记就会并发发出好几次同样的查询。
  vehicleStateRefreshedAt = Date.now();
  try {
    await refreshVehicleState();
  } catch (error) {
    void bridge.logProximity(
      `vehicle state refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function feedProximity(rssi: number | null): void {
  if (calibrating) return;
  // 每轮判距前检查状态新鲜度，快过期就补一次真实状态。
  //
  // 放在这里而不是定时器里：判距本身就是 1.5 s 一跳的心跳，而且只有判距在跑时
  // 才需要这份状态。独立定时器会在人不在车旁时也持续唤醒网络，纯属浪费。
  void refreshVehicleStateIfStale();
  // 每轮先用车辆真实锁状态校准「是否解锁」，再判距。
  // 这样解闭锁失败后状态不会卡死：动作失败时车锁没变，下一轮校准会把状态拉回真值，
  // 于是还能重新触发（2026-11-12 真车实测过闭锁失败后"只解锁、从不闭锁"）。
  // 过期的车锁状态不能拿来校准：它与门控的过期语义必须对称。
  //
  // 门控（车速 30 s / 座椅 60 s）过期即放行，而这里原先**永不过期**：
  // 解锁成功后车端会推 driver_door_lock_st=0，但后台收不到、我们又没主动读，
  // 缓存就一直停在"已锁"，于是每轮 calibrate 把判距器压回未解锁 → 4.5 s 后再发一次
  // unlock。2026-11-24 实测 22 秒内连解 4 次，直到用户切回前台刷新状态才停；
  // 同一天离车后连续 7 次云端闭锁也是同一机制（缓存停在"未锁"）。
  // 现在周期刷新是主手段，这里过期只是刷新失败时的兜底：宁可回到"不知道"、
  // 让判距器维持原值，也不能用一份过期状态反复推翻刚做成功的动作。
  const lockFresh = vehicleLocked && Date.now() - vehicleLocked.at <= LOCK_STATE_TTL_MS;
  proximityTracker.calibrate(lockFresh ? vehicleLocked!.locked : null);
  // 每轮明细只在开关打开时记：这是排查"为什么没触发/为什么触发了"唯一的一手数据。
  //
  // 紧凑单行（约 40 字节）：开关打开时它就是日志的全部内容，一天 57600 轮，
  // 每多一个字节一天就多 56 KB。字段用单字母 + 冒号，? 表示不知道。
  //   s=信号  u=判距器是否已解锁  m=当前态(1 连接/0 扫描)  l=车锁  v=车速在动
  if (shouldLogSample({ verbose: verboseLog })) {
    void bridge.logProximity(
      `s=${rssi ?? '?'} u=${proximityTracker.isUnlocked ? 1 : 0} m=${link.connected ? 1 : 0} ` +
      `l=${vehicleLocked ? (vehicleLocked.locked ? 1 : 0) : '?'} ` +
      `v=${vehicleMoving ? (vehicleMoving.moving ? 1 : 0) : '?'}`,
    );
  }
  const action = proximityTracker.push(Date.now(), rssi);
  if (action) {
    logProximityTrigger(action, rssi);
    void runProximityAction(action);
  }
}

// 连接态 RSSI：与扫描态走同一条判距路径，只是样本来源不同。
proximityEmitter.addListener('xpeng-ble-link-rssi', (value) => {
  const event = value as unknown as { rssi: number | null };
  if (!proximityEnabled || !proximityMac) return;
  if (calibrating) return;
  // 用带超时的判断：忙锁若漏复位，这里会永久丢样本、判距静默停摆。
  if (proximityBusyActive()) return;
  // 只在连接态下采纳：链路已断时这条流可能还有残留回调。
  if (!link.connected) return;
  feedProximity(typeof event.rssi === 'number' ? event.rssi : null);
});

/**
 * 探针当前为哪台车在跑；null 表示没在跑。
 *
 * 用来让「启动连接态探针」这件事幂等：建连有多个入口（扫描切连接、前台 holdLink、
 * 手动车控、退避重连），它们可能在极短时间内先后都调到这里。重复 start 会把探针
 * 重启一次、日志刷两条，而这些路径不需要各自维护自己的生命周期。
 */
let linkFeedMac: string | null = null;

/**
 * 任一路径建连成功后的统一收敛：停扫描、启动连接态探针。
 *
 * 为什么必须收在一处：车端在已有 GATT 连接时**停止广播**（2026-11-12 实测），
 * 所以「连着却还在扫描」拿到的全是 null；而扫描回调又因 `link.connected` 为真
 * 不会再去走 enterLinkMode。两者叠加就是判距彻底失明——2026-11-24 实测：
 * BleLink 的退避重连抢在扫描回调之前建连，之后用户站在车旁 23 秒，
 * 判距器收到 0 个有效 RSSI，最终只能手动解锁。
 */
async function onLinkEstablished(mac: string): Promise<void> {
  const target = (mac ?? '').toUpperCase();
  if (!proximityEnabled || !proximityMac) return;
  // 标定期间探针归标定独占（间隔 500 ms 且样本直接进标定器），不能在这里重启它。
  if (calibrating) return;
  if (scanRunning) {
    scanRunning = false;
    await bridge.stopProximityScan('link established').catch(() => {});
    void bridge.logProximity('scan stopped: link established');
  }
  if (linkFeedMac === target) return;
  linkFeedMac = target;
  void bridge.logProximity(`starting link rssi feed for ${target}`);
  await startLinkRssiFeed(target).catch(() => {});
}

/**
 * 进入连接态后必须启动 RSSI 读取探针。
 *
 * 连接态没有"广播包"这个被动来源，读数只能主动 `readRemoteRssi` 去要。
 * 不启动探针就永远没有连接态读数，判距会停在切换前那一刻。
 */
async function startLinkRssiFeed(mac: string): Promise<void> {
  linkFeedMac = mac.toUpperCase();
  // 扫描态几乎每轮都扫不到车，漏扫窗口里塞满 null（实测一天 26687/26813 轮为空）。
  // 切连接态后若沿用，前 10 轮漏扫率 >0.4，解锁会被一直挡着直到窗口被稀释——
  // 2026-11-20 实测：标定 -93 却要等到 -61（走到门口）才解锁，白等约 10 秒。
  // 实测连接态 100/100 轮零漏扫，旧窗口对新环境毫无参考价值，直接清空。
  proximityTracker.resetMisses();
  await bridge.startLinkRssiProbe(mac, 1500).catch((error) => {
    void bridge.logProximity(
      `link rssi probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/** 扫描失败后的自动恢复计时器（原生侧，后台 JS 定时器不可靠）。 */
let scanRecoverPending = false;

proximityEmitter.addListener('xpeng-ble-proximity-failed', (value) => {
  const event = value as unknown as { code: number };
  // 原实现只打一行 warn 就结束：扫描死了、`scanRunning` 仍为 true、通知仍写「运行中」，
  // 于是功能静静地再也不工作——用户看到的就是「开着却一直不解锁」。
  // 现在把状态复位并安排恢复；失败原因留痕，事后能判断是权限、控制器还是被抢占。
  void bridge.logProximity(`scan failed: code=${event.code}`);
  scanRunning = false;
  if (scanRecoverPending) return;
  scanRecoverPending = true;
  // 间隔 15 s：控制器被别的 App 抢占、蓝牙刚开启等瞬态原因需要一点时间才恢复，
  // 立即重试通常还是同一个失败。
  void bridge.scheduleSuppressionTimer(15_000).catch(() => {});
});

/**
 * 扫描恢复：`scanRecoverPending` 为真时由抑制复查的同一个原生心跳驱动。
 *
 * 与抑制复查共用一个定时器是刻意的：两者都只在后台、都只在扫描没跑时才有意义，
 * 两套定时器只会让「现在到底在等什么」变得难以判断。
 */
async function recoverScanIfNeeded(): Promise<void> {
  if (!scanRecoverPending) return;
  // 不再按前后台拦截：两态架构下前台也可能是扫描态（连接态掉线后退回），
  // 拦住会让功能在前台静默失效。
  if (!proximityEnabled || scanRunning || link.connected) return;
  scanRecoverPending = false;
  void bridge.logProximity('scan recovering');
  await startScanUnlessSuppressed();
}
/**
 * 抑制复查到点了：重新判一次 WiFi / 坐标。
 *
 * 仍命中就什么都不做（定时器会自己续下一次）；一旦不再命中，说明人已经走出那个
 * 禁区，此时才把蓝牙扫描真正拉起来——这是抑制期间唯一会进入扫描的入口。
 */
proximityEmitter.addListener('xpeng-ble-suppression-due', () => {
  // 扫描失败后的恢复优先：它要先跑，才能决定要不要重新起扫。
  if (scanRecoverPending) {
    void recoverScanIfNeeded();
    return;
  }
  if (!proximityEnabled || !proximityMac) return;
  // 连接态与扫描态都要受抑制约束。
  //
  // 原实现只处理"没在扫描"的情形，于是连接态完全绕过了抑制：人走进标记地点
  // （家里、车又停得近）会一直连着，比扫描还费电——扫描至少还被抑制挡住了。
  // 前台时连接由 holdLink 持有、后台时由扫描态转连接，两条路都要能断开。
  if (link.connected) {
    void releaseLinkIfSuppressed();
    return;
  }
  if (scanRunning) return;
  void startScanUnlessSuppressed();
});

/**
 * 连接态下复查抑制：命中就主动断开，退回扫描态（扫描态自己会再被抑制挡住）。
 *
 * 断开后不立即重连：抑制复查定时器会继续跑，等走出禁区才重新拉起。
 */
async function releaseLinkIfSuppressed(): Promise<void> {
  const suppressed = await isSuppressed();
  const action = decideLinkUnderSuppression({ suppressed, connected: link.connected });
  void bridge.logProximity(`link suppression check: ${suppressed ?? 'clear'} -> ${action}`);
  if (action !== 'release') return;
  await link.release().catch(() => {});
  await bridge.startKeepAlive(
    suppressed === 'wifi' ? '已连接指定 WiFi，暂不自动解闭锁'
      : suppressed === 'place' ? '在指定地点附近，暂不自动解闭锁'
        : '无法获取位置，暂不自动解闭锁',
  ).catch(() => {});
  await bridge.scheduleSuppressionTimer(SUPPRESSION_RECHECK_MS).catch(() => {});
}

/**
 * 判距触发点日志。
 *
 * 用户报告"解锁太晚"时，唯一能分辨的是这几件事的先后：扫描何时在跑、何时扫到、
 * 何时判出靠近、何时开始建连。判距器的每次 push 都落一行不划算（1.5 s 一轮刷屏），
 * 所以只在触发时刻记一行，带上当轮 RSSI 与触发前已经历的轮数。
 */
function logProximityTrigger(action: ProximityAction, rssi: number | null): void {
  void bridge.logProximity(`trigger ${action} rssi=${rssi ?? 'none'} foregroundGated=${appForeground}`);
}

/** 手动操作也要落盘：事后才能分辨"人点的"和"自动触发的"。 */
function logUserAction(message: string): void {
  void bridge.logProximity(`user ${message}`);
}

/**
 * 开启/关闭「靠近自动解闭锁」，并把扫描拉起或停掉。
 * 持久化由设置页负责；这里只做运行态。
 */
async function setProximityEnabled(enabled: boolean, vin?: string): Promise<void> {
  proximityEnabled = enabled;
  if (!enabled) proximityMac = undefined;
  const target = enabled ? (vin ?? proximityVin ?? holdTarget?.vin) : undefined;
  const mac = target && (holdTarget?.vin === target ? holdTarget.mac : contexts.get(activeAccount(), target)?.mac);
  // 判据只能是「扫描有没有真的在跑」：开关可能先于物料就绪被拨开，也可能来自冷启动
  // 恢复，那些情况下开关已为「开」而扫描没跑，按开关状态早退会让功能静默失效。
  const action = decideScanAction({ enabled, scanRunning, hasTarget: Boolean(mac), foreground: appForeground, linkConnected: link.connected });
  if (action === 'stop') {
    scanRunning = false;
    proximityVin = undefined;
    await bridge.stopProximityScan('proximity disabled').catch(() => {});
    await bridge.cancelSuppressionTimer().catch(() => {});
    return;
  }
  if (!target || !mac) return;
  proximityVin = target;
  proximityMac = mac.toUpperCase();
  // 已持有链路时 decideScanAction 返回 none（连接与扫描互斥），但此时不是"什么都
  // 不做"——连接态要接着判距，否则刚打开开关而链路恰好已在，判距永远不启动。
  if (link.connected) {
    await startLinkRssiFeed(mac.toUpperCase()).catch(() => {});
    return;
  }
  if (action === 'none') return;
  await startScanUnlessSuppressed();
}

/**
 * 起扫描；但抑制条件命中时**根本不启动扫描**，只留一个轻量的复查定时器。
 *
 * 抑制看的是连着哪个 WiFi、人在哪个坐标，与蓝牙毫无关系。放在扫描前面判，人待在
 * 禁区的整段时间就一轮蓝牙都不用扫——既不耗电，也不会因为白跑判距而出现「明明在
 * 禁区里却停过一次扫描再恢复」的抖动。条件是会变的（走出 WiFi 覆盖、离开那个地点），
 * 所以留一个原生复查定时器，命中就继续不扫，一旦不命中立刻把扫描拉起来。
 */
/**
 * 起扫前用一次短扫描播种判距器。
 *
 * 扫不到（车不广播、人离得远）时**不播种**：保持默认"不在附近"，这样真正走近时
 * 仍会正常触发解锁。只有确实扫到、且强度足以判断远近时才写入状态。
 */
async function seedProximityState(mac: string): Promise<void> {
  try {
    const result = await bridge.scanTarget(mac, 1500);
    if (!result.targetSeen || typeof result.rssi !== 'number') return;
    proximityTracker.seed(result.rssi);
    void bridge.logProximity(`seeded rssi=${result.rssi} unlocked=${proximityTracker.isUnlocked}`);
  } catch {
    // 播种失败不影响正常判距，让它照旧从"不在附近"起步。
  }
}

async function startScanUnlessSuppressed(): Promise<void> {
  const mac = proximityMac;
  if (!mac) return;
  const suppressed = await isSuppressed();
  void bridge.logProximity(`suppression check: ${suppressed ?? 'clear'}`);
  if (suppressed !== null) {
    scanRunning = false;
    void bridge.logProximity(`scan held by ${suppressed}`);
    // 服务仍要拉起：它是复查定时器与后续扫描的载体，也是用户在通知条上看到
    // 「功能在跑」的依据。停掉的只是耗电的蓝牙扫描。
    await bridge.startKeepAlive(
      suppressed === 'wifi' ? '已连接指定 WiFi，暂不自动解闭锁'
        : suppressed === 'place' ? '在指定地点附近，暂不自动解闭锁'
          : '无法获取位置，暂不自动解闭锁',
    ).catch(() => {});
    await bridge.scheduleSuppressionTimer(SUPPRESSION_RECHECK_MS).catch(() => {});
    return;
  }
  // 只清「抑制复查」的定时器；扫描失败后的恢复定时器由 scanRecoverPending 驱动，
  // 这里无脑取消会把刚排上的恢复一并抹掉。
  if (!scanRecoverPending) await bridge.cancelSuppressionTimer().catch(() => {});
  scanRunning = true;
  // 扫描必须挂在 connectedDevice 前台服务下：息屏进 Doze 后普通后台进程会被冻结，
  // 服务既抬进程优先级也持唤醒锁。服务只能趁 App 还在前台时拉起。
  await bridge.startKeepAlive('靠近自动解闭锁运行中').catch((error) => {
    console.warn('[ble] 判距前台服务启动失败:', error instanceof Error ? error.message : String(error));
  });
  // 起扫前先看一眼当前信号，用它播种判距器。
  // 不播种的话，判距器从"不在附近"起步，而人可能本来就在车边（手动解锁完退出 App
  // 就是这种情形），第一眼看到 -35 就会当成"刚走近"补发一次解锁。
  // 这里不产生动作，只确立"已经在附近/还不在附近"这个前提。
  await seedProximityState(mac);
  try {
    await bridge.startProximityScan(mac);
    void bridge.logProximity('scan started');
  } catch (error) {
    // 启动失败跟扫描中途失败是同一类故障，必须走同一条恢复路径：原实现只把
    // scanRunning 置 false 然后放弃，功能从此静默失效。
    scanRunning = false;
    void bridge.logProximity(
      `scan start failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!scanRecoverPending) {
      scanRecoverPending = true;
      await bridge.scheduleSuppressionTimer(15_000).catch(() => {});
    }
  }
}

/**
 * 前后台切换。
 *
 * 2026-11-19 起不再由前后台决定"连还是扫"：判距改成两态自动切换——
 * 扫描态扫到车就进连接态，链路掉线就退回扫描态（见 enterLinkMode / onStateChange）。
 *
 * 原实现在退到后台时无条件 `release()` 断连，那会直接抵消刚建立的连接态：
 * 人走到车边、刚切成连接态，一锁屏就被断回扫描，连接态白建。现在只在
 * **没有开判距功能**时才维持"前台连、后台断"的旧行为。
 */
async function setForeground(foreground: boolean): Promise<void> {
  appForeground = foreground;
  if (foreground) {
    // 开着判距时连接态由自动切换管理，不在这里抢占；关着判距时才沿用
    // "前台持连接"的老语义（车控需要链路）。
    if (proximityEnabled) {
      // 前台仍然不能扫描与连接并存（争控制器），若正在扫描则停掉，
      // 下一轮判断会按需重新进入连接态。
      if (scanRunning) {
        scanRunning = false;
        await bridge.stopProximityScan('app foregrounded').catch(() => {});
      }
      // 前台同样要跑抑制复查：否则人在家里（标记地点）且车停得近、又开着 App 时，
      // 连接会一直被保持——这正是"家里离车近就持续耗电"的场景。
      await bridge.scheduleSuppressionTimer(SUPPRESSION_RECHECK_MS).catch(() => {});
      // 命中抑制时不主动建链：进了前台就无脑 holdLink 会把刚被抑制断开的连接
      // 又接回去，形成每 20 秒"断开→重连"的抖动。车控本身会退回云端，不依赖这条链路。
      const suppressedNow = await isSuppressed();
      if (suppressedNow !== null) {
        void bridge.logProximity(`foreground: suppressed by ${suppressedNow}, not linking`);
        await link.release().catch(() => {});
        syncKeepAlive();
        return;
      }
      syncKeepAlive();
      // 前台不再无条件重持链路。判距开着时"连还是扫"由两态机决定：没有连接就应
      // 去扫描，扫到车再由 enterLinkMode 切连接态。在这里抢先 holdLink 会：
      // ① 与扫描争控制器（必然吃 133 超时）；② 建连失败后 BleLink 进入退避重连，
      // 而前台又不扫描，两边都推进不了。2026-11-25 实测 13:27 就是这条路把链路
      // 重新 held 住、随后空转 9.5 小时。
      // 只有"本来就没开判距"时才需要前台持连接给车控用（见下方非判距分支）。
      if (!scanRunning && proximityMac) await startScanUnlessSuppressed().catch(() => {});
      return;
    }
    if (scanRunning) {
      scanRunning = false;
      await bridge.stopProximityScan('app foregrounded').catch(() => {});
    }
    await bridge.cancelSuppressionTimer().catch(() => {});
    syncKeepAlive();
    if (holdTarget) await holdLink(holdTarget.mac);
    return;
  }
  // 退后台：开着判距时保留**已建立**的连接（否则刚建立的连接态会被立刻断掉），
  // 只确保抑制复查定时器在跑——连接态同样要受抑制约束。
  //
  // 但"链路正在退避重连"（held 且未连上）必须放掉：那是 BleLink 内部的无限重试，
  // 后台没人会来连，它只会与扫描争控制器、每 13 s 打一条超时。
  // 2026-11-25 实测：13:27 回前台时 holdLink 重持链路、13:27:37 又退后台，链路始终
  // 没连上，于是空转 9.5 小时（2537 次 `BLE operation timeout`），直到 22:43 扫描
  // 抢到连接才结束。已有连接的路径不受影响。
  if (proximityEnabled) {
    await bridge.scheduleSuppressionTimer(SUPPRESSION_RECHECK_MS).catch(() => {});
    if (!link.connected) {
      // 后台只该扫描。释放会把 held 清掉、停掉内部重试定时器。
      await link.release().catch(() => {});
      linkFeedMac = null;
      await bridge.stopLinkRssiProbe().catch(() => {});
      if (!scanRunning) await setProximityEnabled(true);
    }
    return;
  }
  await link.release().catch(() => {});
  // 释放连接后车端才恢复广播（实测），此时才可能扫到车。
  if (proximityEnabled) await setProximityEnabled(true);
}

function applyCalibration(next: ProximityCalibration | null): void {
  calibration = next;
  const config: ProximityConfig = next
    ? { ...DEFAULT_PROXIMITY_CONFIG, nearRssi: next.nearRssi, farRssi: next.farRssi }
    : DEFAULT_PROXIMITY_CONFIG;
  // 重建判距器，避免带着上一组阈值的内部状态（nearby/计时）继续跑。
  proximityTracker = new ProximityTracker(config);
}

/**
 * 在给定距离静置采样，按平均值生成阈值。调用方负责在采完后落盘（设置页做）。
 * 采样窗口时长与次数由 `durationMs` 决定，原生每 5 s 一轮。
 */
/**
 * 标定：在「你希望解锁的位置」静置采样，用**持连接**读数算阈值。
 *
 * 2026-11-19 改成持连接采样，原因有二：
 * ① 判距本身已经跑在连接态上（扫描态扫到车就切连接），标定必须采同一种量纲，
 *    否则标定出来的阈值与实际判据不是一回事；
 * ② 持连接零丢失、无选择偏差（广播在远端只有强包能到达，读数被幸存者偏差抬高）。
 *
 * 站位语义也随之改变：以前是"贴到门把手"（那是广播最强处），现在是**站到你希望
 * 它自动解锁的那个位置**——阈值直接对应你的实际期望，不再需要一个偏移量去猜。
 */
async function startCalibration(durationMs = 15000): Promise<{
  ok: boolean; reason?: string; calibration?: ProximityCalibration; count: number;
}> {
  const mac = proximityMac ?? (holdTarget ? holdTarget.mac.toUpperCase() : undefined);
  if (!mac) return { ok: false, reason: 'no-target', count: 0 };
  // 标定要用连接态读数：先确保链路在。没连就建一条（同时把扫描停掉，两者互斥）。
  if (scanRunning) {
    scanRunning = false;
    await bridge.stopProximityScan('calibration start').catch(() => {});
  }
  if (!link.connected) {
    await holdLink(mac).catch(() => {});
    if (!link.connected) return { ok: false, reason: 'no-target', count: 0 };
  }
  const samples: number[] = [];
  calibrating = true;
  // 标定期间由这里独占收集，判距路径不参与（见 feedProximity 的 calibrating 判断）。
  const sub = proximityEmitter.addListener('xpeng-ble-link-rssi', (value) => {
    const e = value as unknown as { rssi: number | null };
    if (typeof e.rssi === 'number') samples.push(e.rssi);
  });
  await bridge.startLinkRssiProbe(mac, 500).catch(() => {});
  await new Promise<void>((r) => setTimeout(r, durationMs));
  await bridge.stopLinkRssiProbe().catch(() => {});
  sub.remove();
  calibrating = false;
  // 用中位数：抗多径弱值也抗单次强值。12 秒窗口的最强值不代表日常站位强度。
  const result = buildCalibrationFromMedian(samples);
  // 采完恢复判距：连接还在就继续用连接态判距，不在就退回扫描。
  if (link.connected) await startLinkRssiFeed(mac);
  else if (proximityEnabled) await setProximityEnabled(true);
  if (result.ok) return { ok: true, calibration: result.calibration, count: result.calibration.sampleCount };
  return { ok: false, reason: result.reason, count: result.count };
}

/** 当前生效阈值（用于界面显示）。 */
function currentThresholds(): { nearRssi: number; farRssi: number; calibrated: boolean } {
  const c = calibration;
  return c
    ? { nearRssi: c.nearRssi, farRssi: c.farRssi, calibrated: true }
    : { nearRssi: DEFAULT_PROXIMITY_CONFIG.nearRssi, farRssi: DEFAULT_PROXIMITY_CONFIG.farRssi, calibrated: false };
}

export const bleLink = {
  permissions: () => bridge.permissionStatus(),
  requestPermissions: () => bridge.requestPermissions(),
  scan: (timeoutMs = 5000) => bridge.scan(timeoutMs),
  execute,
  get contextState(): BleV2ContextState { return { ...contextState }; },
  get uiState(): BleV2UiState { return uiState(); },
  subscribe(listener: (state: BleV2UiState) => void) {
    stateListeners.add(listener);
    listener(uiState());
    return () => { stateListeners.delete(listener); };
  },
  prepareV2,
  autoPrepareV2,
  executePreparedV2,
  setProximityEnabled,
  setForeground,
  /**
   * 更新车辆坐标快照（来自 MQTT `interval.drive`）。
   *
   * 传 null 表示当前没有可信坐标（例如 `coordValid` 为 0），此时距离粗筛会让路、
   * 退化成正常扫描——缺数据只该少省点电，不该让功能停摆。
   */
  /**
   * 更新「车辆是否在行驶」；传 null 表示当前不知道，门控会放行。
   *
   * 记下收到时刻：MQTT 只在状态变化时推送，状态可能很久不更新。门控据此判断
   * 是否过期（见 MOVING_STATE_TTL_MS），避免车已停下却因缓存仍停在"在动"而永久不解锁。
   */
  setVehicleMoving(moving: boolean | null) {
    vehicleMoving = moving === null ? null : { moving, at: Date.now() };
  },
  /** 详细日志开关（运行时值）；落盘由设置页负责。 */
  setVerboseLog(enabled: boolean) { verboseLog = enabled; },
  /** 更新车辆锁状态；传 null 表示不知道，判距器维持原值。 */
  setVehicleLocked(locked: boolean | null) {
    vehicleLocked = locked === null ? null : { locked, at: Date.now() };
  },
  /** 注入云端锁车兜底（App 层用 carLink.send 实现）。 */
  setCloudLockFallback(fn: (() => Promise<boolean>) | null) { cloudLock = fn; },
  /** 更新驾驶位是否有人；传 null 表示不知道。 */
  setVehicleSeated(seated: boolean | null) {
    vehicleSeated = seated === null ? null : { seated, at: Date.now() };
  },
  /** 注入周期拉车辆状态的实现（App 层用 carLink.readStatus）。 */
  setVehicleStateRefresher(fn: (() => Promise<void>) | null) { refreshVehicleState = fn; },
  /**
   * 站位对照采样：一个站位一次调用，自动跑完「持连接」与「断开采广播」两遍。
   *
   * 为什么必须自动跑两遍：车端在已有 GATT 连接时不广播（2026-11-12 实测），
   * 两条测量路径物理互斥，只能先后做。让用户自己去"断开再打开"既容易做错，
   * 也无法保证两遍落在同一站位、同一姿态——那样采到的两条曲线就没法比。
   *
   * 参数 `station` 只用于写进日志，事后对齐用（例如 1m/3m/5m）。
   * 两遍各采 `holdMs`，期间原生按 `intervalMs` 逐点读，读数落日志。
   */
  startLinkRssiProbe: async (intervalMs = 1500) => {
    const mac = proximityMac ?? holdTarget?.mac.toUpperCase();
    if (!mac) throw new Error('没有可用的车辆 MAC：先让数字钥匙物料就绪');
    await bridge.startLinkRssiProbe(mac, intervalMs);
    return mac;
  },
  stopLinkRssiProbe: () => bridge.stopLinkRssiProbe(),
  readLinkRssi: () => {
    const mac = proximityMac ?? holdTarget?.mac.toUpperCase();
    if (!mac) return Promise.reject(new Error('没有可用的车辆 MAC'));
    return bridge.readLinkRssi(mac);
  },
  currentThresholds,
  /** 应用一组阈值（标定结果或冷启动恢复的历史值）。 */
  applyCalibration,
  /** 现场标定：站到你希望解锁的位置静置，用持连接读数算阈值。 */
  startCalibration,
  parseStoredCalibration: parseCalibration,
  serializeCalibration,
  logUserAction,
  get calibration() { return calibration; },
  /** 抑制名单（运行时值）；落盘由设置页负责，与开关、标定值同一套约定。 */
  setSuppression(next: ProximitySuppression) { suppression = next; },
  get suppression() { return suppression; },
  currentWifiSsid: () => wifiBridge.currentSsid(),
  locationPermission: () => wifiBridge.permissionStatus(),
  // 授权结果会变（用户随时可能收回精确权限），每次请求后清掉缓存。
  requestLocationPermission: async () => {
    const status = await wifiBridge.requestPermissions();
    preciseLocationKnown = null;
    return status;
  },
  currentLocation: (maxAgeMs = 120_000, timeoutMs = 8_000) => wifiBridge.currentLocation(maxAgeMs, timeoutMs),
  get foreground() { return appForeground; },
  get proximityEnabled() { return proximityEnabled; },
  /** 已准备好的车辆 VIN（`prepareV2` 成功后才非空）。召唤会话靠它取 V2 车控上下文。 */
  currentVin: () => holdTarget?.vin ?? null,
  /** 已准备车辆的 BLE 地址：原生按 MAC 管理链路，写帧必须指明走哪一条。 */
  currentMac: () => holdTarget?.mac ?? null,
  executeV2,
};
