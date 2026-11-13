import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { plateShadow } from '../atoms';
import { themeVars, useThemeMode } from '../../core/theme';
import { Icon } from '../icons';
import { bleLink } from '../../core/ble';
import { connectPile } from '../../core/pile';

/** 圆形关闭按钮。 */
function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="关闭"
      className="w-9 h-9 rounded-full bg-inset items-center justify-center active:scale-95">
      <Text className="text-[20px] font-icon text-on-surface">{Icon.close}</Text>
    </Pressable>
  );
}

/**
 * 桩名字前缀。`XpengBleModule.kt` 的扫描回调注释记明：蓝牙充电桩以 `XPAC…`
 * 广播名出现（此前扫描硬编码 `XPED` 前缀把它过滤掉了，现已按任意非空名字上报）。
 *
 * 注意这是**代码注释给的事实，不是文档 §1 的结论**：`docs/research/xpeng-ble-charging-pile.md`
 * 记的是「没有本地发现路径，桩地址只能来自缓存或云端」。按名字前缀筛是本仓
 * 现成的唯一可行做法，真机是否稳定命中未验证。筛不到就直接报「未发现」。
 *
 * 另一个真实限制：原生模块同一时刻只允许一条 GATT/扫描（`scan` 与 `connectProfile`
 * 在已有连接时以 `E_BUSY` 拒绝）。车辆数字钥匙链路处于活动态时，这里会失败，
 * 错误原文会显示在弹窗底部，不吞掉。
 */
const PILE_NAME_PREFIX = 'XPAC';

type PileState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'connecting'; name: string; mac: string }
  | { kind: 'connected'; name: string; mac: string }
  | { kind: 'starting'; name: string; mac: string }
  | { kind: 'started'; name: string; mac: string }
  | { kind: 'stopping'; name: string; mac: string }
  | { kind: 'error'; message: string };

const STATE_TEXT: Record<PileState['kind'], string> = {
  idle: '未连接',
  searching: '扫描中',
  connecting: '握手中',
  connected: '已连接',
  starting: '下发中',
  started: '已开始充电',
  stopping: '结束中',
  error: '失败',
};

/**
 * 原生错误码 → 一句能看懂的原因。原文仍然保留在括号里，不吞掉。
 *
 * 三种码都是 `XpengBleModule.kt` 里真实会 reject 的：`E_BUSY`（同刻只允许一条
 * GATT/扫描，车辆数字钥匙在用时必现）、`E_PERMISSION` / `E_BLUETOOTH_OFF`
 * （`ready()` 的两个前置）、`E_SCAN`（`startScan` 失败回调）。之前这些原文只落在
 * 底部 12px 淡灰字上，与背景对比度不足，用户看到的就是「点了没反应」。
 */
function explain(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('E_BUSY')) {
    return `蓝牙通道被占用（车辆数字钥匙正在使用同一条链路），请先断开车辆连接后重试。原生返回：${raw}`;
  }
  if (raw.includes('E_PERMISSION')) return `缺少蓝牙权限。原生返回：${raw}`;
  if (raw.includes('E_BLUETOOTH_OFF')) return `系统蓝牙未开启。原生返回：${raw}`;
  if (raw.includes('E_SCAN')) return `蓝牙扫描失败。原生返回：${raw}`;
  if (raw.includes('unexpected command ack payload')) {
    // 命令回执数据段首字节 00 = 接受、01 = 拒绝。桩不细分拒绝原因。
    return `充电桩拒绝了这条命令（回执首字节非 00：当前条件不满足，桩不细分原因）。原生返回：${raw}`;
  }
  return raw;
}

export function ConnectChargerSheet(props: {
  visible: boolean;
  onClose: () => void;
  /** 启动/结束充电命令成功后触发：由宿主关闭弹窗并刷新一次车辆数据。 */
  onChargingSettled?: () => void;
}): React.JSX.Element {
  const { visible, onClose } = props;
  /** 用 ref 持有，避免把回调塞进 useCallback 依赖导致重复建链。 */
  const onSettled = useRef(props.onChargingSettled);
  onSettled.current = props.onChargingSettled;
  const [, , scheme] = useThemeMode();
  const [pile, setPile] = useState<PileState>({ kind: 'idle' });
  const [chargeText, setChargeText] = useState('可充电');
  /** 供回调读取最新状态，避免把 pile 放进 useCallback 依赖导致重复建链。 */
  const pileRef = useRef<PileState>(pile);
  pileRef.current = pile;
  /** 握手完成后的会话；关闭弹窗时由 cleanup 释放，不随启动充电释放。 */
  const live = useRef<Awaited<ReturnType<typeof connectPile>> | null>(null);
  /** 打开期间只允许一条链路：重复 effect（重渲染）不能重复连接。 */
  const opening = useRef(false);

  const connect = useCallback(async () => {
    setPile({ kind: 'searching' });
    setChargeText('正在扫描充电桩');
    try {
      // 原生 `startScan` 第一步就走 `ready(p)`：缺 BLUETOOTH_SCAN/CONNECT（或旧系统的
      // ACCESS_FINE_LOCATION）时立刻 reject E_PERMISSION。不先申请就会「扫描」在几毫秒内
      // 结束，状态从 scanning 一闪而过，表现为点了没反应。申请完仍缺权限才走失败分支。
      const perms = await bleLink.requestPermissions();
      if (!perms.granted) {
        setPile({
          kind: 'error',
          message: `缺少蓝牙权限：${perms.missing.join('、') || '未知权限'}。请在系统设置里授予后重试。`,
        });
        setChargeText('缺少权限');
        return;
      }
      const devices = await bleLink.scan(6000);
      const found = devices.find((device) => device.name?.startsWith(PILE_NAME_PREFIX));
      if (!found) {
        const seen = devices.map((d) => d.name).filter((n): n is string => !!n);
        setPile({
          kind: 'error',
          message: seen.length === 0
            ? '扫描完成：一个蓝牙设备都没发现（检查定位/蓝牙权限与系统蓝牙开关）'
            : `未发现 XPAC 前缀的充电桩。本次扫到 ${seen.length} 台：${seen.slice(0, 4).join('、')}`,
        });
        setChargeText('未发现充电桩');
        return;
      }
      const name = found.name ?? '充电桩';
      setPile({ kind: 'connecting', name, mac: found.mac });
      setChargeText('正在握手');
      const handshake = await connectPile(found.mac);
      live.current = handshake;
      // 桩侧断链不会走任何 promise：不监听就会一直显示「已连接」。
      handshake.transport.onDrop((reason) => {
        live.current = null;
        setPile({ kind: 'error', message: `充电桩连接已断开：${reason}` });
        setChargeText('连接已断开');
      });
      setPile({ kind: 'connected', name, mac: found.mac });
      setChargeText('已连接充电桩');
    } catch (error) {
      setPile({ kind: 'error', message: explain(error) });
      setChargeText('连接失败');
    }
  }, []);

  /** 启动充电与连接解耦：只有握手完成的会话才能下发。 */
  const startCharging = useCallback(async () => {
    const session = live.current;
    if (!session) return;
    const current = pileRef.current;
    if (current.kind !== 'connected' && current.kind !== 'started') return;
    setPile({ kind: 'starting', name: current.name, mac: current.mac });
    setChargeText('正在下发启动充电');
    try {
      await session.startCharging();
      setPile({ kind: 'started', name: current.name, mac: current.mac });
      setChargeText('已开始充电');
      // 命令已生效：关掉弹窗并让宿主刷新一次车辆数据。
      onSettled.current?.();
    } catch (error) {
      setChargeText('启动失败');
      setPile({ kind: 'error', message: explain(error) });
    }
  }, []);

  /** 结束充电与启动对称：同一条链路、同一个命令交换。 */
  const stopCharging = useCallback(async () => {
    const session = live.current;
    if (!session) return;
    const current = pileRef.current;
    // 连上桩就允许结束：进页面时车可能本就在充（不是本次启动的），桩也不上报状态。
    if (current.kind !== 'started' && current.kind !== 'connected') return;
    setPile({ kind: 'stopping', name: current.name, mac: current.mac });
    setChargeText('正在下发结束充电');
    try {
      await session.stopCharging();
      setPile({ kind: 'connected', name: current.name, mac: current.mac });
      setChargeText('已结束充电');
      onSettled.current?.();
    } catch (error) {
      setChargeText('结束失败');
      setPile({ kind: 'error', message: explain(error) });
    }
  }, []);

  // 打开即自动连接，关闭即释放：原生模块同一时刻只允许一条 GATT。
  useEffect(() => {
    if (!visible) return;
    if (opening.current) return;
    opening.current = true;
    void connect();
    return () => {
      opening.current = false;
      const session = live.current;
      live.current = null;
      if (session) void session.transport.disconnect().catch(() => {});
    };
  }, [visible, connect]);

  /** 连接失败后没有别的入口，必须能就地重试（关闭再开等于重来一次）。 */
  const retry = useCallback(() => {
    if (opening.current) return;
    opening.current = true;
    void connect();
  }, [connect]);

  const named = pile.kind === 'connecting' || pile.kind === 'connected'
    || pile.kind === 'starting' || pile.kind === 'started' || pile.kind === 'stopping' ? pile : null;
  const name = named?.name ?? '—';
  const mac = named?.mac ?? '—';
  const connected = pile.kind === 'connected' || pile.kind === 'started';
  const busy = pile.kind === 'searching' || pile.kind === 'connecting'
    || pile.kind === 'starting' || pile.kind === 'stopping';
  /** 握手完成即可下发启动。连上就给两个按钮，已启动后启动键置灰、结束键可用。 */
  const canStart = pile.kind === 'connected';
  /** 连上桩就允许结束：App 不知道桩是否已在充电（不轮询桩状态），
   *  用户常在家充已开启的情况下进来关它。发一条桩会正常应答或拒绝的结束命令，
   *  比藏掉按钮让人无从操作更合理。 */
  const canStop = connected;
  /** 原生拒绝的原文要单独占一行可读位置，不能挤在底部那句淡灰小字里。 */
  const failure = pile.kind === 'error' ? pile.message : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="justify-end bg-black/45" style={[themeVars(scheme), { flex: 1 }]}>
        <View
          className="bg-surface rounded-t-[28px] overflow-hidden px-6 pt-3 pb-2"
          style={[themeVars(scheme), plateShadow]}>
          <View className="w-full items-center pt-1 pb-3">
            <View className="w-10 h-1 rounded-full bg-inset" />
          </View>

          <View className="flex-row items-center justify-between pt-1 pb-5">
            <Text className="text-[20px] font-headline font-semibold text-on-surface tracking-tight">
              连接充电桩
            </Text>
            <CloseButton onPress={onClose} />
          </View>

          <View className="bg-inset rounded-[22px] px-5 py-1 mb-3">
            <View className="flex-row items-center justify-between py-3.5 border-b border-hairline">
              <Text className="text-[14px] font-body text-on-surface-variant">充电桩名称</Text>
              <Text className="text-[15px] font-headline font-medium text-on-surface">{name}</Text>
            </View>
            <View className="flex-row items-center justify-between py-3.5 border-b border-hairline">
              <Text className="text-[14px] font-body text-on-surface-variant">连接状态</Text>
              <View className="flex-row items-center gap-1.5">
                {connected ? (
                  <View className="w-2 h-2 rounded-full bg-positive" />
                ) : (
                  <View className="w-2 h-2 rounded-full bg-surface-container-highest" />
                )}
                <Text className="text-[14px] font-body font-medium text-on-surface">
                  {STATE_TEXT[pile.kind]}
                </Text>
              </View>
            </View>
            <View className="flex-row items-center justify-between py-3.5">
              <Text className="text-[14px] font-body text-on-surface-variant">充电桩编号</Text>
              <Text className="text-[15px] font-headline font-medium text-on-surface">{mac}</Text>
            </View>
          </View>

          <View className="bg-inset rounded-[22px] px-5 py-3.5 flex-row items-center justify-between mb-5">
            <Text className="text-[14px] font-body text-on-surface-variant">可充电状态</Text>
            <Text className="text-[14px] font-body font-semibold text-on-surface">{chargeText}</Text>
          </View>

          <Pressable
            onPress={startCharging}
            disabled={!canStart}
            className="w-full h-[52px] rounded-full bg-primary-container flex-row items-center justify-center gap-2 active:scale-[0.98]"
            style={canStart ? undefined : { opacity: 0.5 }}>
            <Text className="text-[20px] font-icon text-on-primary-fixed">{Icon.bolt}</Text>
            <Text className="text-[16px] font-headline font-semibold text-on-primary-fixed">
              {pile.kind === 'starting' ? STATE_TEXT.starting : '启动充电'}
            </Text>
          </Pressable>

          {canStop || pile.kind === 'stopping' ? (
            <Pressable
              onPress={stopCharging}
              disabled={busy}
              className="w-full h-[52px] mt-2 rounded-full bg-inset flex-row items-center justify-center active:scale-[0.98]"
              style={busy ? { opacity: 0.5 } : undefined}>
              <Text className="text-[16px] font-headline font-semibold text-on-surface">
                {pile.kind === 'stopping' ? STATE_TEXT.stopping : '结束充电'}
              </Text>
            </Pressable>
          ) : null}

          {failure ? (
            <Pressable
              onPress={retry}
              className="w-full h-11 mt-2 rounded-full bg-inset items-center justify-center active:scale-95">
              <Text className="text-[14px] font-headline font-semibold text-on-surface">重新连接</Text>
            </Pressable>
          ) : null}

          <Text className="text-center text-[12px] font-body text-on-surface-variant mt-3 mb-2">
            {failure ? null : connected ? '充电桩已连接，可在车旁启动充电' : '正在自动连接充电桩'}
          </Text>

          {failure ? (
            /* 失败原文放在 bg-error-container 上，而不是 12px 淡灰字：与背景同色系的
               灰字在真机上几乎看不见，这就是「点了没反应」的观感来源。 */
            <View className="mt-3 mb-1 rounded-[18px] bg-error-container px-4 py-3">
              <Text className="text-xs font-body font-medium text-on-error-container leading-relaxed">
                {failure}
              </Text>
            </View>
          ) : null}

          <View className="w-full items-center pt-2 pb-1">
            <View className="w-32 h-1 rounded-full bg-on-surface" style={{ opacity: 0.2 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
