import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, Text, View } from 'react-native';
import {
  COMMANDS,
  setTemperature,
  type CommandDef,
} from '@xpeng/protocol/src/commands';
import type { Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import type { CustomCommandId } from './CustomCommandSheet';
import { carLink } from '../../core/car';
import { bleLink } from '../../core/ble';
import { sendVehicleCommand } from '@xpeng/protocol/src/ble-v2-routing';
import {
  CapsTag,
  Card,
  CommandButton,
  InfoRow,
  ReadoutCell,
  ScreenScroll,
  SectionHeader,
  StatusStrip,
  type CommandVisualState,
} from '../components';
import { LiveDot, SegmentBar } from '../atoms';
import { Icon, type IconName } from '../icons';

const CAR_IMAGE = require('../../assets/car/d55a.png');
const DASH = '—';

type Outcome = CommandVisualState | 'unconfirmed';

const COMMAND_DEFS: Record<string, CommandDef> = Object.fromEntries(
  COMMANDS.map((def) => [def.id, def]),
);

const REAL_COMMANDS: Record<CustomCommandId, string | undefined> = {
  doorLock: 'door.unlock',
  remoteUnlock: undefined,
  acOn: 'hvac.on',
  flash: 'light.flash',
  windowClose: 'window.up',
  windowVent: 'window.down',
  shadeOpen: 'shade.open',
  shadeClose: 'shade.close',
  quickCool: 'hvac.quickCool',
  quickWarm: 'hvac.quickWarm',
  highTempSterilize: 'hvac.highTemp',
  sentinelOn: 'sentinel.on',
  sentinelOff: 'sentinel.off',
  tailgateOpen: undefined,
  tempPark: undefined,
};

const QUICK_META: Record<CustomCommandId, {
  label: string;
  note: string;
  icon: IconName;
}> = {
  doorLock: { label: '解锁', note: '门锁', icon: 'lock_open' },
  remoteUnlock: { label: '远程解锁', note: '应急启动', icon: 'vpn_key' },
  acOn: { label: '开启空调', note: '速冷恒温', icon: 'ac_unit' },
  flash: { label: '已闪灯', note: '已响应', icon: 'highlight' },
  windowClose: { label: '全车车窗关闭', note: '一键闭窗', icon: 'window' },
  windowVent: { label: '全车车窗通风', note: '微开换气', icon: 'air' },
  shadeOpen: { label: '打开遮阳帘', note: '天幕采光', icon: 'vertical_shades' },
  shadeClose: { label: '关闭遮阳帘', note: '遮蔽隔热', icon: 'vertical_shades_closed' },
  quickCool: { label: '极速降温', note: '18°C', icon: 'severe_cold' },
  quickWarm: { label: '极速升温', note: '32°C', icon: 'heat_pump' },
  highTempSterilize: { label: '高温抑菌', note: '32°C', icon: 'sanitizer' },
  sentinelOn: { label: '开启哨兵模式', note: '录像警戒', icon: 'security' },
  sentinelOff: { label: '关闭哨兵模式', note: '解除警戒', icon: 'gpp_maybe' },
  tailgateOpen: { label: '打开尾门', note: '电动尾门', icon: 'sensor_door' },
  tempPark: { label: '临停', note: '保持供电', icon: 'power_settings_new' },
};

const SENSOR_ICONS: Record<string, IconName> = {
  door: 'sensor_door',
  window: 'window',
  hvac: 'mode_fan',
  light: 'lightbulb',
  sentinel: 'security',
};

const ACTION_ICONS: Record<string, IconName> = {
  'window.down': 'air',
  'window.up': 'check_box_outline_blank',
  'shade.open': 'expand_less',
  'shade.close': 'expand_more',
  'hvac.on': 'power_settings_new',
  'hvac.off': 'mode_standby',
  'hvac.quickCool': 'ac_unit',
  'hvac.quickWarm': 'whatshot',
  'hvac.highTemp': 'clean_hands',
  'light.flash': 'flare',
  'light.horn': 'volume_up',
  'sentinel.on': 'security',
  'sentinel.off': 'gpp_bad',
};

export function ControlScreen(props: {
  vehicle: Vehicle;
  status: VehicleStatus | null;
  onRefresh: () => void;
  bottomInset: number;
  quickCommands: readonly CustomCommandId[];
  onCustomize: () => void;
  onUnsupported: (label: string) => void;
}): React.JSX.Element {
  const { vehicle, status, bottomInset, quickCommands, onCustomize, onUnsupported } = props;
  const [states, setStates] = useState<Record<string, Outcome>>({});
  const [temp, setTemp] = useState<number | null>(null);
  const [bleState, setBleState] = useState(bleLink.uiState);
  const waterOpacity = useRef(new Animated.Value(0.28)).current;

  useEffect(() => bleLink.subscribe(setBleState), []);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(waterOpacity, { toValue: 0.45, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(waterOpacity, { toValue: 0.28, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [waterOpacity]);

  async function run(def: CommandDef) {
    setStates((s) => ({ ...s, [def.id]: 'pending' }));
    const result = await sendVehicleCommand(vehicle, def, {
      send: (command) => carLink.send(command),
      executePreparedV2: (vin, code) => bleLink.executePreparedV2(vin, code),
    });
    if (!result.ok) console.warn(`[cmd] ${def.id}:`, result.error, 'msgId=', result.msgId);
    const outcome: Outcome = result.ok
      ? 'success'
      : result.unconfirmed ? 'unconfirmed' : 'failed';
    setStates((s) => ({ ...s, [def.id]: outcome }));
    setTimeout(() => {
      setStates((s) => ({ ...s, [def.id]: 'idle' }));
    }, 3000);
    if (result.ok) carLink.readStatus().catch(() => {});
  }

  function runId(id: string) {
    const def = COMMAND_DEFS[id];
    if (def) run(def);
  }

  function runQuick(id: CustomCommandId) {
    const commandId = REAL_COMMANDS[id];
    if (commandId === undefined) {
      onUnsupported(QUICK_META[id].label);
      return;
    }
    runId(commandId);
  }

  async function changeTemp(delta: number) {
    const current = temp ?? status?.instant.hvac.hvac_temp ?? 22;
    const next = Math.min(30, Math.max(16, current + delta));
    setTemp(next);
    const { serviceType, msgContent } = setTemperature(next);
    await carLink.send({ id: 'hvac.temp', label: '设定温度', group: 'hvac', serviceType, msgContent });
    carLink.readStatus().catch(() => {});
  }

  const i = status?.instant;
  const d = i?.door;
  const w = i?.window;
  const h = i?.hvac;
  const c = i?.charge;
  const solar = i?.solarRoof;
  const ext = i?.ext;
  const seat = i?.seat;
  const locked = d?.driver_door_lock_st === 1;
  const windowCells = [
    w?.front_left_window_position,
    w?.front_right_window_position,
    w?.rear_left_window_position,
    w?.rear_right_window_position,
  ];
  const windowOpening = windowCells.filter((v): v is number => v !== undefined);
  const windowPercent = windowOpening.length === 0
    ? DASH
    : String(Math.round(windowOpening.reduce((sum, v) => sum + v, 0) / windowOpening.length));
  const shadePercent = w?.sky_sun_shade_position === undefined
    ? DASH
    : String(w.sky_sun_shade_position);
  const solarText = solar === undefined
    ? DASH
    : solar.solarWorkStatus === 1 ? '采光发电中' : '待机';
  const tailgateOpen = d?.trunk_ajar_st === 1;
  const tailgateText = d?.trunk_ajar_st === undefined
    ? DASH
    : tailgateOpen ? '已开启' : '已关闭';
  const soc = c?.battery_soc === undefined ? DASH : String(c.battery_soc);
  const chargeMinutes = c?.time_to_complete_charge_min === undefined
    ? DASH
    : c.time_to_complete_charge_min > 0 ? String(c.time_to_complete_charge_min) : DASH;
  const targetTemp = temp ?? h?.hvac_temp;
  const targetText = targetTemp === undefined ? DASH : String(targetTemp);
  const innerText = h?.hvac_inner_temp === undefined ? DASH : String(h.hvac_inner_temp);
  const windText = h?.hvac_wind_speed === undefined ? DASH : String(h.hvac_wind_speed);
  const autoText = h?.hvac_auto === undefined ? DASH : h.hvac_auto === 1 ? '开启' : '关闭';
  const seatText = seat === undefined
    ? DASH
    : `加热 ${seat.driver_seat_heat} / 通风 ${seat.driver_seat_ventilation}`;
  const videoText = ext?.sentinel_mode_video_enable === undefined
    ? DASH
    : ext.sentinel_mode_video_enable === 1 ? '开启' : '关闭';
  const repairText = ext?.repairMode === undefined ? DASH : ext.repairMode === 1 ? '开启' : '关闭';
  const sensitivity = ext?.sentinel_mode_sensitivity;
  const sensitivityText = sensitivity === undefined
    ? DASH
    : (['低', '中', '高'] as const)[sensitivity - 1] ?? String(sensitivity);
  const doorLockText = d === undefined ? DASH : locked ? '已锁止' : '已解锁';
  const fiveDoorText = d === undefined ? DASH : [
    d.driver_door_ajar_st,
    d.passenger_door_ajar_st,
    d.rear_left_door_ajar_st,
    d.rear_right_door_ajar_st,
    d.trunk_ajar_st,
  ].every((v) => v === 0) ? '全关' : '未全关';
  const sentinelVideo = ext?.sentinel_mode_video_enable;
  const heroVideoText = sentinelVideo === undefined
    ? DASH
    : sentinelVideo === 1 ? '已启用' : '已关闭';
  const st = (id: string): Outcome => states[id] ?? 'idle';

  return (
    <ScreenScroll bottomInset={bottomInset}>
      <Card padded={false} className="bg-ink border-hairline overflow-hidden">
        <View className="relative min-h-[300px] justify-between p-5">
          <View className="absolute inset-0 items-center justify-center opacity-40">
            <Image source={CAR_IMAGE} className="w-full h-44" resizeMode="contain" />
          </View>
          <Animated.View
            className="absolute bottom-0 left-0 right-0 h-[48%] bg-positive"
            style={{ height: '48%', opacity: waterOpacity }}>
            <View className="h-[2px] w-full bg-positive/70" />
          </Animated.View>

          <View className="relative flex-row items-start justify-between">
            <View>
              <View className="flex-row items-center gap-2">
                <Text className="text-lg font-headline font-bold text-surface-container-lowest tracking-tight">
                  车辆名 —
                </Text>
                <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-ink/80 border border-positive/30">
                  <View className="w-1.5 h-1.5 rounded-full bg-positive" />
                  <Text className="text-[11px] font-body font-medium text-positive">已布防</Text>
                </View>
              </View>
              <View className="flex-row items-center gap-2 mt-1">
                <Text className="text-xs text-surface-container-highest">
                  整车闭锁 <Text className="font-body font-medium text-surface-container-lowest">{DASH}</Text>
                </Text>
                <Text className="text-xs text-surface-container-highest">•</Text>
                <Text className="text-xs text-surface-container-highest">
                  五门状态 <Text className="font-body font-medium text-surface-container-lowest">{DASH}</Text>
                </Text>
              </View>
            </View>
            <View className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10">
              <Text className="text-[15px] font-icon text-accent">{Icon.shield}</Text>
              <Text className="text-[11px] text-surface-container-lowest">哨兵录像 —</Text>
            </View>
          </View>

          <View className="relative mt-16 pt-4">
            <View className="flex-row items-baseline gap-2">
              <Text className="text-display-hero-mobile font-headline font-bold text-surface-container-lowest">{soc}</Text>
              <Text className="text-2xl font-headline font-bold text-positive">%</Text>
              <Text className="text-2xl font-icon text-accent">{Icon.bolt}</Text>
            </View>
            <View className="flex-row items-center justify-between mt-3 pt-3 border-t border-white/15">
              <View className="flex-row items-center gap-1.5">
                <LiveDot colorClass="bg-positive" size={5} />
                <Text className="text-xs font-body font-medium text-surface-container-lowest">充电中</Text>
                <Text className="text-xs text-surface-container-highest">
                  / 预计 {chargeMinutes} 分钟后充满
                </Text>
              </View>
              <Text className="text-[13px] font-headline font-semibold text-surface-container-lowest">
                电量 {soc}
              </Text>
            </View>
          </View>
        </View>
      </Card>

      <Card>
        <View className="flex-row items-center justify-between mb-3 px-1">
          <Text className="text-sm font-headline font-semibold text-on-surface">快捷指令</Text>
          <Pressable
            onPress={onCustomize}
            className="flex-row items-center gap-1 active:scale-95">
            <Text className="text-[15px] font-icon text-on-surface-variant">{Icon.tune}</Text>
            <Text className="text-xs font-body font-medium text-on-surface-variant">自定义</Text>
          </Pressable>
        </View>
        <View className="flex-row gap-2.5">
          {quickCommands.slice(0, 4).map((id) => (
            <QuickAction
              key={id}
              meta={QUICK_META[id]}
              highlighted={id === 'flash'}
              onPress={() => runQuick(id)}
            />
          ))}
        </View>
      </Card>

      <Card>
        <SectionHeader
          title="车门与中控锁"
          right={
            <View className="flex-row items-center gap-2">
              <CapsTag text={`门锁 ${doorLockText}`} />
              <CapsTag text={`五门 ${fiveDoorText}`} />
            </View>
          }
        />
        <StatusStrip
          label="MQTT + BLE 双通道"
          value={bleState.error ? `${bleState.label} · ${bleState.error}` : bleState.label}
          valueClass={bleState.connected ? 'text-positive' : 'text-on-surface-variant'}
          className="mb-2.5"
        />
        <View className="bg-inset rounded-box p-3.5 mb-2.5">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-2">
              <Text className="text-sm font-headline font-semibold text-on-surface">中控门锁</Text>
              <Text className="text-xs font-body text-on-surface-variant">
                未解锁显示「解锁」，已解锁切换为「锁车」
              </Text>
            </View>
            {!locked ? (
              <Pressable
                onPress={() => runId('door.unlock')}
                className="flex-row items-center gap-1 px-4 py-2 rounded-full bg-primary-container active:scale-95">
                <Text className="text-[18px] font-icon text-on-primary-fixed">{Icon.lock_open}</Text>
                <Text className="text-sm font-headline font-semibold text-on-primary-fixed">解锁</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => runId('door.lock')}
                className="flex-row items-center gap-1 px-4 py-2 rounded-full bg-primary-container active:scale-95">
                <Text className="text-[18px] font-icon text-on-primary-fixed">{Icon.lock}</Text>
                <Text className="text-sm font-headline font-semibold text-on-primary-fixed">锁车</Text>
              </Pressable>
            )}
          </View>
        </View>
        <View className="bg-inset rounded-box p-3.5 mb-2.5">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-2">
              <View className="flex-row items-center gap-1.5">
                <Text className="text-sm font-headline font-semibold text-on-surface">远程解锁</Text>
                <Text className="text-[10px] font-body text-on-surface-variant bg-surface-container-lowest px-1.5 py-0.5 rounded-full">
                  仅远程下发
                </Text>
              </View>
              <Text className="text-xs font-body text-on-surface-variant">
                无钥匙应急 · 解锁后 2 分钟内可踩刹车挂挡启动
              </Text>
            </View>
            <PillAction label="远程解锁" onPress={() => onUnsupported('远程解锁')} />
          </View>
        </View>
        <View className="bg-inset rounded-box p-3.5 mb-2.5">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-2">
              <View className="flex-row items-center gap-1.5">
                <Text className="text-sm font-headline font-semibold text-on-surface">电动尾门</Text>
                <Text className="text-[10px] font-body text-on-surface-variant bg-surface-container-lowest px-1.5 py-0.5 rounded-full">
                  BLE 直连
                </Text>
              </View>
              <Text className="text-xs font-body text-on-surface-variant">
                当前已关显示「打开尾门」，开启后切换「关闭尾门」
              </Text>
            </View>
            {tailgateOpen ? (
              <PillAction label="关闭尾门" onPress={() => onUnsupported('电动尾门')} />
            ) : (
              <PillAction label="打开尾门" onPress={() => onUnsupported('电动尾门')} />
            )}
          </View>
        </View>
        <View className="bg-inset rounded-box p-3.5">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-2">
              <Text className="text-sm font-headline font-semibold text-on-surface">临停</Text>
              <Text className="text-xs font-body text-on-surface-variant">临时停车保持车端动力供电</Text>
            </View>
            <Pressable
              onPress={() => onUnsupported('临停')}
              className="w-12 h-6 rounded-full bg-surface-container-highest p-0.5">
              <View className="w-5 h-5 rounded-full bg-surface-container-lowest" />
            </Pressable>
          </View>
        </View>
      </Card>

      <Card>
        <SectionHeader title="车窗与遮阳帘" />
        <View className="flex-row flex-wrap gap-2 mb-2.5">
          <ReadoutCell label="四窗开度" value={`${windowPercent} %`} />
          <ReadoutCell label="天幕开度" value={`${shadePercent} %`} />
          <ReadoutCell label="太阳能天窗" value={solarText} />
          <ReadoutCell label="电动尾门状态" value={tailgateText} />
        </View>
        <View className="flex-row flex-wrap gap-2.5">
          <CommandButton
            icon={ACTION_ICONS['window.down']}
            label="全车车窗通风"
            state={st('window.down')}
            className="basis-[48%]"
            onPress={() => runId('window.down')}
          />
          <CommandButton
            icon={ACTION_ICONS['window.up']}
            label="全车车窗关闭"
            state={st('window.up')}
            className="basis-[48%]"
            onPress={() => runId('window.up')}
          />
          <CommandButton
            icon={ACTION_ICONS['shade.open']}
            label="打开遮阳帘"
            state={st('shade.open')}
            className="basis-[48%]"
            onPress={() => runId('shade.open')}
          />
          <CommandButton
            icon={ACTION_ICONS['shade.close']}
            label="关闭遮阳帘"
            state={st('shade.close')}
            className="basis-[48%]"
            onPress={() => runId('shade.close')}
          />
        </View>
      </Card>

      <Card>
        <SectionHeader title="空调与座椅" />
        <View className="bg-inset rounded-box p-3.5 mb-2.5">
          <InfoRow
            label="设定目标 / 实测温度"
            value={`目标 ${targetText} °C / 实测 ${innerText} °C`}
          />
          <InfoRow label="风量档位" value={windText} small />
          <InfoRow label="AUTO 恒温" value={autoText} small />
          <InfoRow label="座椅加热通风" value={seatText} small />
        </View>
        <View className="flex-row flex-wrap gap-2 mb-2.5">
          <CommandButton
            icon={ACTION_ICONS['hvac.on']}
            label="打开空调"
            state={st('hvac.on')}
            variant="solid"
            className="basis-[23%]"
            onPress={() => runId('hvac.on')}
          />
          <CommandButton
            icon={ACTION_ICONS['hvac.off']}
            label="关闭空调"
            state={st('hvac.off')}
            className="basis-[23%]"
            onPress={() => runId('hvac.off')}
          />
          <Pressable
            onPress={() => changeTemp(-1)}
            className="basis-[23%] flex-row items-center justify-center gap-1 py-3 px-1 rounded-lg bg-inset border border-hairline active:scale-95">
            <Text className="text-[16px] font-icon text-on-surface">{Icon.remove}</Text>
            <Text className="text-xs font-headline font-semibold text-on-surface">温度</Text>
          </Pressable>
          <Pressable
            onPress={() => changeTemp(1)}
            className="basis-[23%] flex-row items-center justify-center gap-1 py-3 px-1 rounded-lg bg-inset border border-hairline active:scale-95">
            <Text className="text-[16px] font-icon text-on-surface">{Icon.add}</Text>
            <Text className="text-xs font-headline font-semibold text-on-surface">温度</Text>
          </Pressable>
        </View>
        <View className="flex-row gap-2">
          <CommandButton
            icon={ACTION_ICONS['hvac.quickCool']}
            label="极速降温 (18°C)"
            state={st('hvac.quickCool')}
            tint="secondary"
            className="flex-1"
            onPress={() => runId('hvac.quickCool')}
          />
          <CommandButton
            icon={ACTION_ICONS['hvac.quickWarm']}
            label="极速升温 (32°C)"
            state={st('hvac.quickWarm')}
            tint="primary"
            className="flex-1"
            onPress={() => runId('hvac.quickWarm')}
          />
          <CommandButton
            icon={ACTION_ICONS['hvac.highTemp']}
            label="高温抑菌 (32°C)"
            state={st('hvac.highTemp')}
            tint="tertiary"
            className="flex-1"
            onPress={() => runId('hvac.highTemp')}
          />
        </View>
      </Card>

      <Card>
        <SectionHeader title="灯光与提示" />
        <View className="flex-row gap-3">
          <View className="flex-1">
            <CommandButton
              icon={ACTION_ICONS['light.flash']}
              label="闪灯（已响应态）"
              state={st('light.flash')}
              variant="solid"
              onPress={() => runId('light.flash')}
            />
          </View>
          <View className="flex-1">
            <CommandButton
              icon={ACTION_ICONS['light.horn']}
              label="鸣笛提示"
              state={st('light.horn')}
              onPress={() => runId('light.horn')}
            />
          </View>
        </View>
      </Card>

      <Card>
        <SectionHeader title="哨兵模式" />
        <View className="flex-row gap-2 mb-2.5">
          <ReadoutCell label="录像使能" value={videoText} />
          <ReadoutCell label="维修模式" value={repairText} />
          <ReadoutCell label="灵敏度" value={sensitivityText} />
        </View>
        <View className="flex-row gap-3">
          <View className="flex-1">
            <CommandButton
              icon={ACTION_ICONS['sentinel.on']}
              label="开启哨兵模式"
              state={st('sentinel.on')}
              onPress={() => runId('sentinel.on')}
            />
          </View>
          <View className="flex-1">
            <CommandButton
              icon={ACTION_ICONS['sentinel.off']}
              label="关闭哨兵模式"
              state={st('sentinel.off')}
              onPress={() => runId('sentinel.off')}
            />
          </View>
        </View>
      </Card>
    </ScreenScroll>
  );
}

function QuickAction({
  meta,
  highlighted,
  onPress,
}: {
  meta: { label: string; note: string; icon: IconName };
  highlighted: boolean;
  onPress: () => void;
}) {
  if (highlighted) {
    return (
      <Pressable
        onPress={onPress}
        className="flex-1 items-center justify-center p-3 rounded-box bg-primary-container/25 border border-primary-container active:scale-95">
        <View className="w-10 h-10 rounded-full bg-primary-container items-center justify-center mb-1.5">
          <Text className="text-[20px] font-icon text-on-primary-fixed">{Icon[meta.icon]}</Text>
        </View>
        <Text className="text-xs font-headline font-bold text-on-surface text-center">{meta.label}</Text>
        <Text className="text-[10px] font-body text-on-surface-variant mt-0.5 text-center">{meta.note}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 items-center justify-center p-3 rounded-box bg-inset active:scale-95">
      <View className="w-10 h-10 rounded-full bg-surface-container-lowest items-center justify-center mb-1.5">
        <Text className="text-[20px] font-icon text-on-surface">{Icon[meta.icon]}</Text>
      </View>
      <Text className="text-xs font-headline font-semibold text-on-surface text-center">{meta.label}</Text>
      <Text className="text-[10px] font-body text-on-surface-variant mt-0.5 text-center">{meta.note}</Text>
    </Pressable>
  );
}

function PillAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="px-3.5 py-2 rounded-full bg-surface border border-hairline active:scale-95">
      <Text className="text-xs font-headline font-semibold text-on-surface">{label}</Text>
    </Pressable>
  );
}
