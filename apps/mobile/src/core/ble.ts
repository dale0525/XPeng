import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import { type BleCommandOptions, type BleStage, type BleTransport } from '@xpeng/protocol/src/ble-session';
import { BleLink, type BleLinkTimers } from '@xpeng/protocol/src/ble-link';
import { base64Decode, fromHex, randomBytes, readBe, toHex } from '@xpeng/protocol/src/bytes';
import { BleV2MaterialService } from '@xpeng/protocol/src/ble-v2-material';
import { buildV2Command, validateV2Command } from '@xpeng/protocol/src/ble-v2-command';
import { decideRetry } from '@xpeng/protocol/src/proximity-retry';
import { BleV2ContextService, isP5BleV2Vehicle } from '@xpeng/protocol/src/ble-v2-context';
import type { Vehicle } from '@xpeng/protocol/src/vehicles';
import { ProximityTracker, decideScanAction, decideScanDuringAction, DEFAULT_PROXIMITY_CONFIG, type ProximityAction, type ProximityConfig } from '@xpeng/protocol/src/proximity';
import { parseCalibration, serializeCalibration, buildCalibrationFromMedian, type ProximityCalibration } from '@xpeng/protocol/src/proximity-calibration';
import {
  DEFAULT_SUPPRESSION, suppressReason, suppressionPlan, type GeoPoint, type ProximitySuppression,
} from '@xpeng/protocol/src/proximity-suppression';
import { sessionStore } from './session';
import { BlePreconditionError, connectPreparedBle, type BleConnectPermissions } from './ble-connect';

type BlePermissions = BleConnectPermissions;
interface BleDevice { mac: string; name: string | null; rssi: number }
interface BleNative {
  permissionStatus(): Promise<BlePermissions>;
  requestPermissions(): Promise<BlePermissions>;
  scan(timeoutMs: number): Promise<BleDevice[]>;
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
  dumpServices(): Promise<Array<{ service: string; characteristics: Array<{ uuid: string; handle: number; properties: number }> }>>;
  write(hex: string): Promise<void>;
  disconnect(): Promise<void>;
  startKeepAlive(text: string): Promise<void>;
  updateKeepAlive(text: string): Promise<void>;
  stopKeepAlive(): Promise<void>;
  scheduleKeepAliveTimer(mac: string, reauth: boolean, delayMs: number): Promise<void>;
  cancelKeepAliveTimers(): Promise<void>;
  startProximityScan(mac: string): Promise<void>;
  stopProximityScan(): Promise<void>;
  logProximity(message: string): Promise<void>;
}

const bridge = NativeModules.XpengBle as BleNative;

/** 「哪些 WiFi / 地点附近不执行」要的定位与 WiFi 探针，独立原生模块见 XpengWifiLocationModule.kt。 */
interface WifiLocationNative {
  permissionStatus(): Promise<{ granted: boolean; locationEnabled: boolean }>;
  requestPermissions(): Promise<{ granted: boolean; locationEnabled: boolean }>;
  currentSsid(): Promise<string>;
  currentLocation(maxAgeMs: number, timeoutMs: number): Promise<{ lat: number; lon: number } | null>;
}
const wifiBridge = NativeModules.XpengWifiLocation as WifiLocationNative;

class NativeBleTransport implements BleTransport {
  private mac = '';
  private emitter = new NativeEventEmitter(NativeModules.XpengBle);
  async connect(mac: string) {
    this.mac = mac.toUpperCase();
    await connectPreparedBle(bridge, mac);
  }
  write(data: Uint8Array) { return bridge.write(toHex(data)); }
  disconnect() { return bridge.disconnect(); }
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

const link = new BleLink(new NativeBleTransport(), authMaterialFor, {
  timers: nativeTimers,
  // 常驻模式下一次操作收尾也会报 disconnected，但那只是会话结束、连接还在，
  // 直接透传会让状态行显示「蓝牙连接已断开」而实际仍连着。
  onStage: (stage) => setOperationStage(stage === 'disconnected' && link.connected ? 'authenticated' : stage),
  isPermanentError: (error) => error instanceof BlePreconditionError,
  onStateChange: (state) => {
    if (state.kind === 'connected') {
      void bridge.updateKeepAlive('已连接车辆，蓝牙钥匙保持可用');
    } else if (state.kind === 'backoff') {
      // 重连期间通知条要说明「正在重连」而不是假装已连接，否则用户会以为功能还在。
      void bridge.updateKeepAlive('连接已断开，正在重连');
    } else if (state.kind === 'idle') {
      // 后台只扫描时连接本来就不该存在（release 必然报 idle），此时服务是扫描的载体，
      // 停了它后台判距立刻失效、进程也会被当普通后台进程回收。只有开关也关着才停服务。
      if (!proximityEnabled) void bridge.stopKeepAlive();
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

function executePreparedV2(vin: string, commandCode: number, expectCommandAck = true) {
  const context = contexts.get(activeAccount(), vin);
  if (!context) throw new Error('BLE V2 vehicle context is not prepared');
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
/** 原生扫描是否真的在跑；与「开关是否打开」是两件事，不能互相代替。 */
let scanRunning = false;
/** App 是否在前台；前台持连接、后台只扫描，两者互斥（车端连上就不广播）。 */
let appForeground = AppState.currentState === 'active';

/**
 * 判一次「这次动作该不该被抑制」。
 *
 * 省电靠两件事：配置为空时一次探针都不发；有坐标配置时先读 WiFi，命中就不再唤醒定位。
 * 读不到 SSID / 坐标一律判不命中——探针失败不能让功能静默失效。
 *
 * 位置优先用系统缓存的 last-known（120 s 内直接用）；缓存过期时允许原生要一次新定位，
 * 上限 6 s。原先是 `timeoutMs=0`（永不请求），配合"过期即无位置"的判法，导致静止在家时
 * 系统不更新 last-known → 永远拿不到位置 → 100 m 半径规则永不生效（2026-11-12 故障）。
 * 实测主动请求 4 s 内可返回；6 s 上限保证"人站在车边"时解锁不会被拖长，超时就退回旧点。
 */
async function isSuppressed(): Promise<'wifi' | 'place' | null> {
  const plan = suppressionPlan(suppression);
  if (!plan.probeWifi) return null;
  let ssid: string | null = null;
  try { ssid = await wifiBridge.currentSsid(); } catch { ssid = null; }
  if (suppressReason({ rules: suppression, ssid, location: null }) === 'wifi') return 'wifi';
  if (!plan.probeLocation) return null;
  let location: GeoPoint | null = null;
  try {
    const fix = await wifiBridge.currentLocation(120_000, 6_000);
    if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lon)) location = { lat: fix.lat, lon: fix.lon };
  } catch { location = null; }
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
  if (!vin) return;
  const context = contexts.get(activeAccount(), vin);
  if (!context) return;
  const mac = proximityMac;
  if (scanRunning) {
    scanRunning = false;
    await bridge.stopProximityScan().catch(() => {});
  }
  let failed = false;
  let message = '';
  try {
    await executeV2({ ...context, commandCode: action === 'unlock' ? 1 : 2 });
    void bridge.logProximity(`action=${action} ok${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
  } catch (error) {
    failed = true;
    message = error instanceof Error ? error.message : String(error);
    void bridge.logProximity(`action=${action} failed: ${message}`);
  } finally {
    // 恢复判距；重试期间也要恢复，否则下一次靠近就再也不会触发。
    if (decideScanDuringAction({ enabled: proximityEnabled, foreground: appForeground, hasMac: Boolean(mac) }) === 'resume') {
      scanRunning = true;
      await bridge.startProximityScan(mac!).catch(() => { scanRunning = false; });
    }
  }
  if (!failed) return;
  // 闭锁重试前若人又回到附近，放弃：不能把人锁在车边。
  const decision = decideRetry({ action, failed, attempt, nowNearby: proximityTracker.isNearby });
  if (!decision.retry) {
    void bridge.logProximity(
      `action=${action} give up after ${attempt} attempt(s): ${decision.abandonReason ?? 'unknown'}`,
    );
    return;
  }
  void bridge.logProximity(`action=${action} retry #${attempt} in ${decision.delayMs} ms`);
  await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
  // 等待期间开关可能被关掉，或被新的动作占用。
  if (!proximityEnabled || proximityBusy) return;
  proximityBusy = true;
  try {
    await runProximityActionWithRetry(action, attempt + 1);
  } finally {
    proximityBusy = false;
  }
}

async function runProximityAction(action: ProximityAction): Promise<void> {
  if (proximityBusy) return;
  const vin = proximityVin;
  if (!vin) return;
  const context = contexts.get(activeAccount(), vin);
  if (!context) return;
  proximityBusy = true;
  // release 包下 JS 的 console.warn 不进 logcat，触发链只能靠原生打点观察。
  void bridge.logProximity(`action=${action} start`);
  const mac = proximityMac;
  const suppressed = await isSuppressed();
  if (suppressed !== null) {
    // 抑制期间不碰 GATT：扫描环继续跑，所以人一离开这个 WiFi / 半径，下次靠近立刻恢复。
    void bridge.logProximity(`action=${action} skipped by ${suppressed}`);
    proximityBusy = false;
    return;
  }
  // 建连前必须停扫描：实测扫描在跑时 GATT 建连直接吃 `133`
  // (GATT_CONN_FAIL_ESTABLISH)，重试也落在同一窗口里失败。两者共用同一个控制器。
  if (scanRunning) {
    scanRunning = false;
    await bridge.stopProximityScan().catch(() => {});
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
  // 标定采样期间：只收集强度，不做任何判距动作。
  if (calibrationSession) {
    if (typeof event.rssi === 'number') calibrationSession.samples.push(event.rssi);
    return;
  }
  if (!proximityEnabled || !proximityMac) return;
  if (event.mac.toUpperCase() !== proximityMac) return;
  const action = proximityTracker.push(Date.now(), event.rssi);
  if (action) void runProximityAction(action);
});
proximityEmitter.addListener('xpeng-ble-proximity-failed', (value) => {
  const event = value as unknown as { code: number };
  console.warn(`[ble] 后台扫描失败 code=${event.code}`);
});

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
  const action = decideScanAction({ enabled, scanRunning, hasTarget: Boolean(mac), foreground: appForeground });
  if (action === 'stop') {
    scanRunning = false;
    proximityVin = undefined;
    await bridge.stopProximityScan().catch(() => {});
    return;
  }
  if (action === 'none' || !target || !mac) return;
  proximityVin = target;
  proximityMac = mac.toUpperCase();
  scanRunning = true;
  // 扫描必须挂在 connectedDevice 前台服务下：息屏进 Doze 后普通后台进程会被冻结，
  // 服务既抬进程优先级也持唤醒锁。服务只能趁 App 还在前台时拉起。
  await bridge.startKeepAlive('靠近自动解闭锁运行中').catch((error) => {
    console.warn('[ble] 判距前台服务启动失败:', error instanceof Error ? error.message : String(error));
  });
  await bridge.startProximityScan(mac).catch((error) => {
    scanRunning = false;
    console.warn('[ble] 后台扫描启动失败:', error instanceof Error ? error.message : String(error));
  });
}

/** 前后台切换：前台持有常驻连接；后台释放连接、只留扫描。 */
async function setForeground(foreground: boolean): Promise<void> {
  appForeground = foreground;
  if (foreground) {
    // 前台不做判距扫描：连接由 holdLink 持有，扫描与连接同时跑只会互相抢车端的
    // 连接槽，也白耗电。
    if (scanRunning) {
      scanRunning = false;
      await bridge.stopProximityScan().catch(() => {});
    }
    // 前台恢复连接：用已记下的车辆上下文，没有就不连（还没准备好物料）。
    if (holdTarget) await holdLink(holdTarget.mac);
    return;
  }
  await link.release().catch(() => {});
  // 释放连接后车端才恢复广播（实测），此时才可能扫到车。
  if (proximityEnabled) await setProximityEnabled(true);
}

/**
 * 标定采样。
 *
 * 硬约束：车端在已有 GATT 连接时不广播（实测持连接扫描 20 轮 0 结果），所以标定
 * 期间必须先断开常驻连接、只保留扫描；采完恢复原状。每一步都由原生驱动，JS 只收样本。
 */
let calibrationSession: { resolve: (r: { ok: boolean; reason?: string; calibration?: ProximityCalibration; count: number }) => void; samples: number[]; timer?: ReturnType<typeof setTimeout> } | undefined;

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
async function startCalibration(durationMs = 15000): Promise<{
  ok: boolean; reason?: string; calibration?: ProximityCalibration; count: number;
}> {
  const mac = proximityMac ?? (holdTarget ? holdTarget.mac.toUpperCase() : undefined);
  if (!mac) return { ok: false, reason: 'no-target', count: 0 };
  // 断开常驻连接，否则车不广播、采不到任何值。
  if (link.connected) await link.release().catch(() => {});
  scanRunning = false;
  await bridge.stopProximityScan().catch(() => {});
  const samples: number[] = [];
  return await new Promise((resolve) => {
    calibrationSession = { resolve, samples };
    bridge.startProximityScan(mac).catch(() => {});
    scanRunning = true;
    const timer = setTimeout(() => {
      if (!calibrationSession) return;
      const collected = calibrationSession.samples;
      calibrationSession = undefined;
      scanRunning = false;
      void bridge.stopProximityScan().catch(() => {});
      // 用中位数：抗多径弱值也抗单次强值。上一版取 max 在实机上得 -61，
      // 而门边 149 样本的 p90 才 -62——12 秒窗口的最强值不代表日常贴脸强度。
      const result = buildCalibrationFromMedian(collected);
      // 采完恢复原有分工：前台重新持有连接，后台恢复判距扫描。
      void (async () => {
        if (appForeground && holdTarget) await holdLink(holdTarget.mac);
        else if (proximityEnabled) await setProximityEnabled(true);
      })();
      if (result.ok) resolve({ ok: true, calibration: result.calibration, count: result.calibration.sampleCount });
      else resolve({ ok: false, reason: result.reason, count: result.count });
    }, durationMs);
    if (calibrationSession) calibrationSession.timer = timer;
  });
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
  startCalibration,
  currentThresholds,
  applyCalibration,
  get calibration() { return calibration; },
  parseStoredCalibration: parseCalibration,
  serializeCalibration,
  /** 抑制名单（运行时值）；落盘由设置页负责，与开关、标定值同一套约定。 */
  setSuppression(next: ProximitySuppression) { suppression = next; },
  get suppression() { return suppression; },
  currentWifiSsid: () => wifiBridge.currentSsid(),
  locationPermission: () => wifiBridge.permissionStatus(),
  requestLocationPermission: () => wifiBridge.requestPermissions(),
  currentLocation: (maxAgeMs = 120_000, timeoutMs = 8_000) => wifiBridge.currentLocation(maxAgeMs, timeoutMs),
  get foreground() { return appForeground; },
  get proximityEnabled() { return proximityEnabled; },
  /** 已准备好的车辆 VIN（`prepareV2` 成功后才非空）。召唤会话靠它取 V2 车控上下文。 */
  currentVin: () => holdTarget?.vin ?? null,
  executeV2,
};
