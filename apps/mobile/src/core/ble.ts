import { NativeEventEmitter, NativeModules } from 'react-native';
import { BleSession, type BleCommandOptions, type BleStage, type BleTransport } from '@xpeng/protocol/src/ble-session';
import { base64Decode, fromHex, randomBytes, readBe, toHex } from '@xpeng/protocol/src/bytes';
import { BleV2MaterialService } from '@xpeng/protocol/src/ble-v2-material';
import { buildV2Command, validateV2Command } from '@xpeng/protocol/src/ble-v2-command';
import { BleV2ContextService, isP5BleV2Vehicle } from '@xpeng/protocol/src/ble-v2-context';
import type { Vehicle } from '@xpeng/protocol/src/vehicles';
import { sessionStore } from './session';
import { connectPreparedBle, type BleConnectPermissions } from './ble-connect';

type BlePermissions = BleConnectPermissions;
interface BleDevice { mac: string; name: string | null; rssi: number }
interface BleNative {
  permissionStatus(): Promise<BlePermissions>;
  requestPermissions(): Promise<BlePermissions>;
  scan(timeoutMs: number): Promise<BleDevice[]>;
  stopScan(): Promise<void>;
  connect(mac: string): Promise<void>;
  connectDiagnostic(mac: string): Promise<void>;
  write(hex: string): Promise<void>;
  disconnect(): Promise<void>;
}

const bridge = NativeModules.XpengBle as BleNative;

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
}

const session = new BleSession(new NativeBleTransport(), setOperationStage);
const materials = new BleV2MaterialService((path, body) => sessionStore.call(path, body));
const contexts = new BleV2ContextService((path, body) => sessionStore.call(path, body), materials);
export type BleV2ContextState = { kind: 'idle' }
  | { kind: 'preparing' | 'ready'; vin: string }
  | { kind: 'error'; vin: string; reason: string };
export type BleV2UiState = {
  phase: 'idle' | 'preparing' | 'ready' | 'error' | BleStage;
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
    case 'ready': return { phase: 'ready', label: '蓝牙钥匙已就绪', connected: false };
    case 'error': return {
      phase: 'error',
      label: '蓝牙钥匙准备失败',
      connected: false,
      error: contextState.reason,
    };
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
    return await session.execute(options);
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
    return await session.execute({
      mac: options.mac,
      keyMac: options.keyMac,
      commandCode: options.commandCode,
      timeoutMs: options.timeoutMs,
      appN,
      verifyKey: material.verifyCode.code,
      verifyRandom,
      signal: controller.signal,
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

async function prepareV2(vin: string) {
  const account = activeAccount();
  const generation = accountGeneration;
  operationError = undefined;
  operationStage = undefined;
  setContextState({ kind: 'preparing', vin });
  try {
    const context = await contexts.prepare(account, vin);
    if (generation !== accountGeneration) throw new Error('BLE V2 account changed during preparation');
    setContextState({ kind: 'ready', vin });
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

function executePreparedV2(vin: string, commandCode: number) {
  const context = contexts.get(activeAccount(), vin);
  if (!context) throw new Error('BLE V2 vehicle context is not prepared');
  return executeV2({ ...context, commandCode });
}

/** Automatic preparation is HTTP-only; radio control remains an explicit call. */
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
  executeV2,
};
