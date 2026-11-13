/**
 * 原生能力的 JS 侧门面。三样东西：带 mTLS 的 HTTP、MQTT 长连接、本地存储。
 *
 * 全部走一个自研模块 `XpengNet`（`android/.../bridge/XpengNetModule.kt`），
 * 不引 OkHttp / Paho / AsyncStorage：只用到「POST + 客户端证书」「MQTT 三件事」
 * 「读写两个字符串」，加起来不到 400 行 Kotlin，比三个依赖更省包体积。
 *
 * `log()` 是给真机自测用的：release 下 console.* 的 TAG 由 RN 固定为
 * ReactNativeJS、会混入框架日志，无法按业务过滤；统一走原生 Log 用字面量
 * XPSession 作 TAG，一条 `adb logcat -s XPSession` 就能收全续期链路。
 */
import { NativeEventEmitter, NativeModules } from 'react-native';

const Native = NativeModules.XpengNet as {
  post(
    host: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    clientCertPem: string | null,
    clientKeyPem: string | null,
  ): Promise<{ status: number; body: string; setCookie: string[] }>;
  mqttConnect(
    id: string,
    host: string,
    port: number,
    clientId: string,
    username: string,
    password: string,
    topics: Record<string, string>,
  ): Promise<number>;
  mqttPublish(id: string, topic: string, payload: string): Promise<void>;
  mqttDisconnect(id: string): Promise<void>;
  storageGet(key: string): Promise<string | null>;
  storageSet(key: string, value: string): Promise<void>;
  storageRemove(key: string): Promise<void>;
  log(level: 'i' | 'w' | 'e', tag: string, message: string): void;
  /** 让桌面组件重画；返回一共重画了几个组件实例。 */
  refreshWidgets(): Promise<number>;
};

/** 真机自测用：统一 TAG，绝不传 token / 信封 / 请求体原文。 */
export function xpLog(event: string, detail: string, level: 'i' | 'w' | 'e' = 'i'): void {
  Native.log(level, 'XPSession', `${event} ${detail}`);
}

if (!Native) {
  throw new Error('XpengNet 原生模块未注册：检查 MainApplication 里的 add(XpengNetPackage())');
}

export const native = Native;

const emitter = new NativeEventEmitter(NativeModules.XpengNet);

export interface MqttEvent {
  id: string;
  topic: string;
  payload: string;
}

export function onMqttMessage(cb: (e: MqttEvent) => void): () => void {
  // NativeEventEmitter 的监听签名是 (...args: readonly Object[])，这里收窄成具体事件
  const sub = emitter.addListener('xpeng-mqtt-message', (e) => cb(e as unknown as MqttEvent));
  return () => sub.remove();
}

export function onMqttDisconnect(cb: (e: { id: string; reason: string }) => void): () => void {
  const sub = emitter.addListener('xpeng-mqtt-disconnect', (e) =>
    cb(e as unknown as { id: string; reason: string }),
  );
  return () => sub.remove();
}

/** 会话与偏好都存这里；键名集中在这几个常量里，避免拼错。 */
export const StorageKey = {
  session: 'session.v1',
  deviceId: 'device.id',
  lastRefresh: 'session.lastRefresh',
  theme: 'ui.theme',
  quickCommands: 'ui.quickCommands',
  proximity: 'ui.proximityAutoUnlock',
  proximityCalibration: 'ui.proximityCalibration',
  proximitySuppression: 'ui.proximitySuppression',
  /** 2x4 组件读的电量/续航快照，键名与原生 `WidgetSnapshot.KEY_SNAPSHOT` 一致。 */
  widgetSnapshot: 'widget.snapshot',
} as const;
