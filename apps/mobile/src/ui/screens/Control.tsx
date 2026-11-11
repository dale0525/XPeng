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
import { isP5BleV2Vehicle } from '@xpeng/protocol/src/ble-v2-context';
import {
  CapsTag,
  Card,
  InfoRow,
  ReadoutCell,
  ScreenScroll,
  SectionHeader,
  StatusStrip,
  PendingSpinner,
  type CommandVisualState,
} from '../components';
import { LiveDot, SegmentBar } from '../atoms';
import { Icon, type IconName } from '../icons';
import { DARK_COLORS, LIGHT_COLORS } from '../../core/colors';
import { useThemeMode } from '../../core/theme';

const CAR_IMAGE = require('../../assets/car/d55a.png');
const DASH = '—';

type Outcome = CommandVisualState | 'unconfirmed';

const COMMAND_DEFS: Record<string, CommandDef> = Object.fromEntries(
  COMMANDS.map((def) => [def.id, def]),
);

const REAL_COMMANDS: Record<CustomCommandId, string | undefined> = {
  // 门锁格是状态切换，方向由当前锁止状态决定，见 runQuick。
  doorLock: undefined,
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
  // 尾门是单个切换键，方向由 runQuick 按当前开合状态决定；线上开/关共用 0x04，
  // 车端自己按当前状态动作（材料预签 300 条、不带动作参数，research §6.7 + 2026-11-10 复核）。
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
  flash: { label: '闪灯', note: '寻车提示', icon: 'highlight' },
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
  onRemoteView: () => void;
  onSummon: () => void;
  onConnectCharger: () => void;
  /** 当前登录账号是否为车主（远程查看仅车主可用）。由 App 依据当前登录账号 uid 与车主 uid 判定。 */
  isOwner: boolean;
}): React.JSX.Element {
  const {
    vehicle,
    status,
    onRefresh,
    bottomInset,
    quickCommands,
    onCustomize,
    onUnsupported,
    onRemoteView,
    onSummon,
    onConnectCharger,
    isOwner,
  } = props;
  const [states, setStates] = useState<Record<string, Outcome>>({});
  const [temp, setTemp] = useState<number | null>(null);
  const [bleState, setBleState] = useState(bleLink.uiState);
  // 充电水面波浪：稿子只有一条几乎看不出的 subtleWave，用户要求做成能看出来的「波浪曲线」。
  // 做法：一排细条按正弦函数起伏拼出波浪顶边，相位用循环 Animated.Value 当节拍驱动横向流动。
  const wavePhase = useRef(new Animated.Value(0)).current;
  // 卡片高度是 min-h 撑出来的（非定值），Yoga 里父容器百分比高度会解析成 0，
  // 所以水面高度必须按实测高度换算成像素，不能直接用 `74%`。
  const [heroHeight, setHeroHeight] = useState(0);
  // 波浪相位 0→1（一个周期 3s），每帧写进渲染状态供正弦计算用。
  const [renderClock, setRenderClock] = useState(0);
  /** 闪灯只响应一段时间：点过后 2.4 秒内才显示已响应态，与 run() 的回落时长一致。 */
  const [flashJustFired, setFlashJustFired] = useState(false);

  useEffect(() => bleLink.subscribe(setBleState), []);
  // 只有充电时才需要波浪；不充电时别让这个每帧 setState 的节拍空转重渲染整屏。
  const waveActive = (status?.instant?.charge?.time_to_complete_charge_min ?? 0) > 0;
  useEffect(() => {
    if (!waveActive) return;
    const id = wavePhase.addListener(({ value }) => setRenderClock(value));
    const loop = Animated.loop(
      Animated.timing(wavePhase, { toValue: 1, duration: 3000, easing: Easing.linear, useNativeDriver: false }),
    );
    loop.start();
    return () => {
      loop.stop();
      wavePhase.removeListener(id);
    };
  }, [wavePhase, waveActive]);

  async function run(def: CommandDef) {
    setStates((s) => ({ ...s, [def.id]: 'pending' }));
    const result = await sendVehicleCommand(vehicle, def, {
      send: (command) => carLink.send(command),
      executePreparedV2: (vin, code) => bleLink.executePreparedV2(vin, code),
    });
    if (!result.ok) console.warn(`[cmd] ${def.id}:`, result.error, 'msgId=', result.msgId);
    // 闪灯没有可读状态字段（只能靠人眼确认），所以「已响应」只跟这次下发成功挂钩，
    // 且限时显示，不能像状态字段那样常驻。
    if (def.id === 'light.flash' && result.ok) setFlashJustFired(true);
    const outcome: Outcome = result.ok
      ? 'success'
      : result.unconfirmed ? 'unconfirmed' : 'failed';
    setStates((s) => ({ ...s, [def.id]: outcome }));
    setTimeout(() => {
      setStates((s) => ({ ...s, [def.id]: 'idle' }));
      if (def.id === 'light.flash') setFlashJustFired(false);
    }, 3000);
    // 无论回执成败都回读：BLE 侧回执超时（实测 trunk.open 出现 BLE response timeout）
    // 或回执 163（车端已执行、官方语义未定）时物理动作都可能已生效，
    // 回执只说明「有没有收到答复」，不能作为「车有没有动」的判据。
    // 尾门/车窗这类机械动作要几秒才走完，立刻回读拿到的常是旧状态，所以补一次延迟回读。
    carLink.readStatus().catch(() => {});
    setTimeout(() => {
      carLink.readStatus().catch(() => {});
    }, 6000);
  }

  /** 某条指令是否还在等车端回执——按钮据此把图标与文字换成旋转圈。 */
  function isPending(id: string): boolean {
    return id !== '' && states[id] === 'pending';
  }

  function runId(id: string) {
    const def = COMMAND_DEFS[id];
    if (def) run(def);
  }

  function runQuick(id: CustomCommandId) {
    // 门锁格是设计稿里的状态切换按钮：已锁就发解锁，未锁就发锁车。
    if (id === 'doorLock') {
      runId(locked ? 'door.unlock' : 'door.lock');
      return;
    }
    // 尾门同上是切换键：当前已开就发关闭，否则发打开（线上两向共用 0x04）。
    // 只有 DF 车型有已验证的 BLE 路由，其他车型没有 MQTT 兜底，保持明确提示。
    if (id === 'tailgateOpen') {
      if (!bleV2) {
        onUnsupported('电动尾门');
        return;
      }
      runId(tailgateOpen ? 'trunk.close' : 'trunk.open');
      return;
    }
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
  // 只有 DF 车型有已验证的 BLE V2 路由；其他车型的后备箱没有 MQTT 证据，只能如实说不可用。
  const bleV2 = isP5BleV2Vehicle(vehicle);
  // 远程查看仅车主可用：车控指令按车主权限签发，子账号即使放开入口也会被服务端拒绝，
  // 因此在入口处拦截，点击给「仅车主可用」提示（设计稿不表现权限差异，只做代码拦截）。
  // isOwner 由 App 用「当前登录账号 uid === 车主 uid」判定；资料未取到时按非车主处理。
  const openRemoteView = () => {
    if (isOwner) onRemoteView();
    else onUnsupported('远程查看（仅车主可用）');
  };
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
  // `*_ajar_st` 是「未关闭程度」：0=全关，非 0=未关。实测尾门完全打开时 trunk_ajar_st=2、
  // 关闭时=0（2026-11-10 真机日志），所以判「开着」不能用 `=== 1`。
  const tailgateOpen = (d?.trunk_ajar_st ?? 0) > 0;
  const tailgateText = d?.trunk_ajar_st === undefined
    ? DASH
    : tailgateOpen ? '已开启' : '已关闭';
  const soc = c?.battery_soc === undefined ? DASH : String(c.battery_soc);
  const rangeKm = status?.instant?.odometer?.avalible_driving_distance === undefined
    ? DASH
    : String(Math.round(status.instant.odometer.avalible_driving_distance));
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
  // 充电遮罩只在真正充电时出现：`charging_state` 非 0 视为充电中（0=未充电）。
  // 拿不到回执时按「未知」处理，不画遮罩——宁可少一个效果，也不能在没充电的车上报充电中。
  // 充电态判定：`charging_state` 的枚举含义在文档里没有取值说明（只列了字段名），
// 真机上未充电时它也可能非 0——2026-11-08 真机就出现过车没充电却显示「充电中」。
// 因此只用一条正证据：`time_to_complete_charge_min > 0` 表示车端确实在算「还需多久充满」。
// 拿不到这个值时按未充电处理，宁可少画一次水面，也不能对没充电的车报充电中。
  const chargeMinNum = c?.time_to_complete_charge_min;
  const charging = chargeMinNum !== undefined && chargeMinNum > 0;
  // 水面高度直接取 SOC 百分比：绿色波纹覆盖卡片的比例就是充电进度。
  // 拿不到 SOC 时给一个象征性的三分之一，不假装具体电量。
  const socNum = c?.battery_soc;
  const waterPercent = socNum === undefined ? 33 : Math.max(0, Math.min(100, socNum));
  // onLayout 未回填时（首帧）按 380dp 兜底，避免水面高度算成 0 而整层不显示。
  const heroPx = heroHeight > 0 ? heroHeight : 380;
  const waterHeight = Math.round(heroPx * waterPercent / 100);
  // 两种水色：
  //  · WATER：真正的半透明绿，水体用它，车能从水里透出来；
  //  · WATER_SOLID：把同一种绿按比例预混进卡片底色 ink 得到的实色，只在「水面那一圈窄带」用，
  //    这样窄带细条互相重叠也不会 alpha 叠加出竖纹（半透明条重叠正是竖条纹的根因）。
  const [, , scheme] = useThemeMode();
  const inkRgb = (scheme === 'dark' ? DARK_COLORS : LIGHT_COLORS)['ink'];
  const hexToRgb = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const [inkR, inkG, inkB] = hexToRgb(inkRgb);
  const [gr, gg, gb] = [18, 206, 134];
  const WATER = (a: number) => `rgba(${gr},${gg},${gb},${a})`;
  const WATER_SOLID = (a: number) =>
    `rgb(${Math.round(inkR + (gr - inkR) * a)},${Math.round(inkG + (gg - inkG) * a)},${Math.round(inkB + (gb - inkB) * a)})`;
  const chargeHeadline = charging ? '充电中' : '未充电';
  // 波浪参数：一排细条按正弦计算「波浪顶边」高度，相位随 renderClock 推进形成横向流动。
  const WAVE_BARS = 120;     // 细条数，越多顶边越平滑（台阶不可见）
  const WAVE_AMP = 16;       // 波峰到波谷的起伏幅度（px）
  const WAVE_WAVES = 2;      // 整个宽度上出现几个波

  return (
    <ScreenScroll bottomInset={bottomInset}>
      {/* ===== 2. Vehicle Hero Main Card —— 照 a694：整卡 bg-ink、rounded-[28px]、p-5、min-h-380 ===== */}
      <Card padded={false} className="bg-ink rounded-[28px] overflow-hidden">
        <View className="relative min-h-[380px] justify-between p-5" onLayout={(e) => setHeroHeight(e.nativeEvent.layout.height)}>
          {/* 车图 + 上下压暗遮罩（稿子用 gradient-to-t，RN 无渐变库，用两层半透明黑等价模拟） */}
          <View className="absolute inset-x-0 top-0 items-center justify-center" style={{ bottom: 120 }}>
            <Image source={CAR_IMAGE} className="w-full h-full" resizeMode="contain" />
          </View>
          <View className="absolute inset-x-0 top-0 h-16 bg-ink/70" />
          {/* 底部压暗层只在未充电时盖；充电时它会把绿色水面压成接近黑色，等于又把波纹藏起来。 */}
          {charging ? null : <View className="absolute inset-x-0 h-24 bg-ink/70" style={{ bottom: 0 }} />}
          {/* 充电水面：绿色波纹覆盖卡片底部的比例=SOC，顶边是流动的正弦波浪（不是直边）。
              水体是单块半透明绿渐变（单 view 不会有竖纹，车能透出来）；
              水面那一圈窄带用预混实色细条拼出正弦波峰（实色重叠不加深，故不会出竖条纹）。 */}
          {charging ? (
            <View pointerEvents="none" className="absolute inset-x-0 overflow-hidden" style={{ bottom: 0, height: waterHeight + WAVE_AMP + 24 }}>
              {/* 水体：从波谷线往下铺满到卡片底，半透明绿，向下略微加深 */}
              <View style={{
                position: 'absolute', left: 0, right: 0, top: 24 + WAVE_AMP, bottom: 0,
                experimental_backgroundImage: `linear-gradient(to bottom, ${WATER(0.10)}, ${WATER(0.24)})`,
              } as unknown as import('react-native').ViewStyle} />
              {/* 水面波带：每条按 sin 从波峰线往下填一点，用预混实色拼出起伏波峰 */}
              {Array.from({ length: WAVE_BARS }).map((_, i) => {
                const t = i / (WAVE_BARS - 1);
                const crest = (Math.sin(t * Math.PI * 2 * WAVE_WAVES + renderClock * Math.PI * 2) + 1) / 2; // 0..1
                const crestTop = 24 + (1 - crest) * WAVE_AMP; // 顶端在 24 ~ 24+AMP 间摆动
                const bandBottom = 24 + WAVE_AMP + 8;          // 波带固定下探到波谷线下方，保证与水体衔接
                return (
                  <View key={i} style={{
                    position: 'absolute',
                    left: `${t * 100}%`,
                    width: `${100 / WAVE_BARS + 0.9}%`, // 略宽压住接缝（实色不透明，重叠不变色）
                    top: crestTop,
                    height: bandBottom - crestTop,
                    backgroundColor: WATER_SOLID(0.22),
                  }}>
                    {/* 亮绿波峰线，随波起伏 */}
                    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, backgroundColor: WATER_SOLID(0.5) }} />
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* Hero Header：车型名 + 锁止徽章；下方状态迷你标签 */}
          <View className="relative flex-row items-start justify-between">
            <View>
              <View className="flex-row items-center gap-2">
                <Text className="text-[18px] font-headline font-semibold text-white tracking-wide">
                  {vehicle.vehicleTypeName || DASH}
                </Text>
                <View className="flex-row items-center gap-1 rounded-full border border-white/10 bg-white/10 px-2 py-0.5">
                  <View className={locked ? 'w-1.5 h-1.5 rounded-full bg-positive' : 'w-1.5 h-1.5 rounded-full bg-on-surface-variant'} />
                  <Text className="text-[11px] font-body font-medium text-white/90">
                    {d === undefined ? DASH : locked ? '已锁止' : '未锁止'}
                  </Text>
                </View>
              </View>
              <View className="mt-1 flex-row items-center gap-1.5">
                <Text className="text-[11px] text-white/60">整车闭锁 {doorLockText}</Text>
                <Text className="text-[11px] text-white/60">·</Text>
                <Text className="text-[11px] text-white/60">五门 {fiveDoorText}</Text>
                <Text className="text-[11px] text-white/60">·</Text>
                <Text className="text-[11px] text-white/60">哨兵 {heroVideoText}</Text>
              </View>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Pressable onPress={onRefresh} aria-label="更多参数"
                className="h-8 w-8 items-center justify-center rounded-full bg-white/15 active:scale-95">
                <Text className="text-[18px] font-icon text-white">{Icon.tune}</Text>
              </Pressable>
              <Pressable onPress={() => onUnsupported('更多参数')} aria-label="菜单选项"
                className="h-8 w-8 items-center justify-center rounded-full bg-white/15 active:scale-95">
                <Text className="text-[18px] font-icon text-white">{Icon.more_vert}</Text>
              </Pressable>
            </View>
          </View>

          {/* Hero Bottom：剩余续航大字（km）+ 充电徽章；分隔线 + 充电详情 */}
          <View className="relative mt-28 justify-end">
            <View className="flex-row items-baseline gap-1">
              <Text className="text-[56px] font-headline font-bold tracking-tighter text-white tabular-nums">{rangeKm}</Text>
              <Text className="text-[30px] font-headline font-bold text-white/80">km</Text>
              {charging ? (
                <View className="ml-3 flex-row items-center gap-1 rounded-full border border-positive/40 bg-positive/20 px-2.5 py-1">
                  <Text className="text-[14px] font-icon text-positive">{Icon.bolt}</Text>
                  <Text className="text-[11px] font-body font-medium text-positive">充电中</Text>
                </View>
              ) : null}
            </View>
            <View className="mt-2 flex-row items-center justify-between border-t border-white/10 pt-2">
              <View className="flex-row items-center gap-1.5">
                <View className={charging ? 'w-1.5 h-1.5 rounded-full bg-positive' : 'w-1.5 h-1.5 rounded-full bg-on-surface-variant'} />
                <Text className="text-[12px] text-white/70">
                  {charging
                    ? (chargeMinutes === DASH ? '预计 — 分钟后充满' : `预计 ${chargeMinutes} 分钟后充满`)
                    : '未充电'}
                </Text>
              </View>
              <Text className="text-[12px] font-headline font-medium text-white/90">电量 {soc}%</Text>
            </View>
          </View>
        </View>
      </Card>

      {/* ===== 3. Shortcut Actions（快捷指令） ===== */}
      <View className="gap-2.5">
        <View className="flex-row items-center justify-between px-1">
          <Text className="text-[15px] font-headline font-semibold tracking-tight text-on-surface">快捷指令</Text>
          <Pressable onPress={onCustomize} className="flex-row items-center gap-0.5 active:scale-95">
            <Text className="text-[12px] font-body text-on-surface-variant">自定义</Text>
            <Text className="text-[14px] font-icon text-on-surface-variant">{Icon.chevron_right}</Text>
          </Pressable>
        </View>
        <View className="flex-row gap-2.5">
          {quickCommands.slice(0, 4).map((id) => (
            <QuickAction
              key={id}
              meta={id === 'tailgateOpen'
                ? { label: tailgateOpen ? '关闭尾门' : '打开尾门', note: '电动尾门', icon: tailgateOpen ? 'garage' : 'sensor_door' }
                : id === 'doorLock'
                  // 稿 a694：锁止时 lock + 「已锁车」，解锁时 lock_open + 「已解锁」；
                  // 电光黄图标圈只在解锁态出现（见下面 highlighted）。
                  ? { label: locked ? '已锁车' : '已解锁', note: '门锁', icon: locked ? 'lock' : 'lock_open' }
                  : QUICK_META[id]}
              highlighted={(id === 'doorLock' && !locked) || (id === 'tailgateOpen' && tailgateOpen)}
              pending={isPending(id === 'doorLock' ? (locked ? 'door.unlock' : 'door.lock')
                : id === 'tailgateOpen' ? (tailgateOpen ? 'trunk.close' : 'trunk.open')
                : REAL_COMMANDS[id] ?? '')}
              onPress={() => runQuick(id)}
            />
          ))}
        </View>
      </View>

      {/* ===== 4. Extended Feature Entry Points（三列卡片） ===== */}
      <View className="flex-row gap-2">
        <FeatureEntry icon={Icon.videocam} label="远程查看" note="车身全景环视" onPress={openRemoteView} />
        <FeatureEntry icon={Icon.swap_vertical_circle} label="直线召唤" note="前后遥控泊车" onPress={onSummon} />
        <FeatureEntry icon={Icon.ev_station} label="连接充电桩" note="智慧家充桩配对" onPress={onConnectCharger} />
      </View>

      {/* ===== 5. Doors & Central Locking（车门与中控锁） ===== */}
      <Card>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Text className="text-[20px] font-icon text-on-surface-variant">{Icon.lock_clock}</Text>
            <Text className="text-[16px] font-headline font-semibold text-on-surface">车门与中控锁</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <Text className="rounded-full bg-inset px-2 py-0.5 text-[12px] text-on-surface-variant">门锁 {doorLockText}</Text>
            <Text className="rounded-full bg-inset px-2 py-0.5 text-[12px] text-on-surface-variant">五门 {fiveDoorText}</Text>
          </View>
        </View>
        {/* 稿：卡片内部 space-y-4 —— 卡头与按钮网格间隔 16。 */}
        <View className="flex-row flex-wrap gap-2.5 pt-1">
          <View className="basis-[48%]">
            <Pill2
              title="中控门锁"
              note={d === undefined ? '读取中' : locked ? '车辆已锁止' : '车辆未锁止'}
              pending={isPending(locked ? 'door.unlock' : 'door.lock')}
              onPress={() => runId(locked ? 'door.unlock' : 'door.lock')}
            />
          </View>
          <View className="basis-[48%]">
            <Pill2 title="远程解锁" note="仅远程下发" onPress={() => onUnsupported('远程解锁')} />
          </View>
          <View className="basis-[48%]">
            <Pill2
              title={tailgateOpen ? '关闭尾门' : '打开尾门'}
              note={bleV2 ? 'BLE 直连' : '仅 DF 车型'}
              pending={isPending(tailgateOpen ? 'trunk.close' : 'trunk.open')}
              onPress={() => (bleV2 ? runId(tailgateOpen ? 'trunk.close' : 'trunk.open') : onUnsupported('电动尾门'))}
            />
          </View>
          <View className="basis-[48%]">
            <Pill2
              title="开启临停"
              note="单次触发"
              pending={isPending('temp.park')}
              onPress={() =>
                run({ id: 'temp.park', label: '开启临停', group: 'door', serviceType: 9, msgContent: { cmd_type: 3 } })
              }
            />
          </View>
        </View>
      </Card>

      {/* ===== 6. Windows & Sunshade（车窗与遮阳帘） ===== */}
      <Card>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Text className="text-[20px] font-icon text-on-surface-variant">{Icon.roller_shades}</Text>
            <Text className="text-[16px] font-headline font-semibold text-on-surface">车窗与遮阳帘</Text>
          </View>
        </View>
        <View className="mt-4 flex-row flex-wrap gap-2">
          <StatPill label="四窗开度" value={`${windowPercent}%`} />
          <StatPill label="天幕开度" value={`${shadePercent}%`} />
          <StatPill label="太阳能天窗" value={solarText} />
          <StatPill label="电动尾门状态" value={tailgateText} />
        </View>
        <View className="mt-4 flex-row flex-wrap gap-2.5 pt-1">
          <View className="basis-[48%]"><TextPill label="全车车窗通风" pending={isPending('window.down')} onPress={() => runId('window.down')} /></View>
          <View className="basis-[48%]"><TextPill label="全车车窗关闭" pending={isPending('window.up')} onPress={() => runId('window.up')} /></View>
          <View className="basis-[48%]"><TextPill label="打开遮阳帘" pending={isPending('shade.open')} onPress={() => runId('shade.open')} /></View>
          <View className="basis-[48%]"><TextPill label="关闭遮阳帘" pending={isPending('shade.close')} onPress={() => runId('shade.close')} /></View>
        </View>
      </Card>

      {/* ===== 7. Climate & Seats（空调与座椅） ===== */}
      <Card>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Text className="text-[20px] font-icon text-on-surface-variant">{Icon.ac_unit}</Text>
            <Text className="text-[16px] font-headline font-semibold text-on-surface">空调与座椅</Text>
          </View>
        </View>
        <View className="mt-4 flex-row flex-wrap gap-2">
          <StatPill label="目标/实测" value={`${targetText}°C / ${innerText}°C`} />
          <StatPill label="风量" value={windText} />
          <StatPill label="AUTO 模式" value={autoText} />
          <StatPill label="座椅加热通风" value={seatText} />
        </View>
        <View className="mt-4 gap-2 pt-1">
          <View className="flex-row gap-2.5">
            <Pressable onPress={() => runId('hvac.on')} disabled={isPending('hvac.on')}
              className="flex-1 flex-row items-center justify-center gap-1 rounded-full bg-on-surface px-3 py-2.5 active:scale-95">
              {isPending('hvac.on') ? (
                <PendingSpinner color="#FFFFFF" />
              ) : (
                <>
                  <Text className="text-[16px] font-icon text-surface">{Icon.power_settings_new}</Text>
                  <Text className="text-[12px] font-headline font-semibold text-surface">打开空调</Text>
                </>
              )}
            </Pressable>
            <Pressable onPress={() => runId('hvac.off')} disabled={isPending('hvac.off')}
              className="flex-1 items-center justify-center rounded-full bg-inset px-3 py-2.5 active:scale-95">
              {isPending('hvac.off')
                ? <PendingSpinner color="#111214" />
                : <Text className="text-[12px] font-headline font-semibold text-on-surface">关闭空调</Text>}
            </Pressable>
          </View>
          <View className="flex-row gap-2.5">
            <Pressable onPress={() => changeTemp(-1)} disabled={isPending('hvac.temp')}
              className="flex-1 flex-row items-center justify-center gap-1 rounded-full bg-inset px-3 py-2 active:scale-95">
              {isPending('hvac.temp') ? (
                <PendingSpinner color="#111214" />
              ) : (
                <>
                  <Text className="text-[16px] font-icon text-on-surface">{Icon.remove}</Text>
                  <Text className="text-[12px] font-headline font-semibold text-on-surface">温度 -</Text>
                </>
              )}
            </Pressable>
            <Pressable onPress={() => changeTemp(1)} disabled={isPending('hvac.temp')}
              className="flex-1 flex-row items-center justify-center gap-1 rounded-full bg-inset px-3 py-2 active:scale-95">
              {isPending('hvac.temp') ? (
                <PendingSpinner color="#111214" />
              ) : (
                <>
                  <Text className="text-[16px] font-icon text-on-surface">{Icon.add}</Text>
                  <Text className="text-[12px] font-headline font-semibold text-on-surface">温度 +</Text>
                </>
              )}
            </Pressable>
          </View>
          <View className="flex-row gap-2 pt-1">
            <Pressable onPress={() => runId('hvac.quickCool')} disabled={isPending('hvac.quickCool')}
              className="flex-1 items-center justify-center rounded-full bg-inset px-1 py-2 active:scale-95">
              {isPending('hvac.quickCool')
                ? <PendingSpinner color="#111214" />
                : <Text className="text-[11px] font-headline font-semibold text-center text-on-surface">极速降温 (18°C)</Text>}
            </Pressable>
            <Pressable onPress={() => runId('hvac.quickWarm')} disabled={isPending('hvac.quickWarm')}
              className="flex-1 items-center justify-center rounded-full bg-inset px-1 py-2 active:scale-95">
              {isPending('hvac.quickWarm')
                ? <PendingSpinner color="#111214" />
                : <Text className="text-[11px] font-headline font-semibold text-center text-on-surface">极速升温 (32°C)</Text>}
            </Pressable>
            <Pressable onPress={() => runId('hvac.highTemp')} disabled={isPending('hvac.highTemp')}
              className="flex-1 items-center justify-center rounded-full bg-inset px-1 py-2 active:scale-95">
              {isPending('hvac.highTemp')
                ? <PendingSpinner color="#111214" />
                : <Text className="text-[11px] font-headline font-semibold text-center text-on-surface">高温抑菌 (32°C)</Text>}
            </Pressable>
          </View>
        </View>
      </Card>

      {/* ===== 8. Lights & Horn（灯光与提示） ===== */}
      <Card>
        <View className="flex-row items-center gap-2">
          <Text className="text-[20px] font-icon text-on-surface-variant">{Icon.campaign}</Text>
          <Text className="text-[16px] font-headline font-semibold text-on-surface">灯光与提示</Text>
        </View>
        <View className="mt-4 flex-row gap-2.5">
          <Pressable onPress={() => runId('light.flash')} disabled={isPending('light.flash')}
            className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full bg-inset px-4 py-2.5 active:scale-95">
            {isPending('light.flash') ? (
              <PendingSpinner color="#111214" />
            ) : (
              <>
                <Text className="text-[18px] font-icon text-on-surface">{Icon.lightbulb}</Text>
                <Text className="text-[12px] font-headline font-bold text-on-surface">闪灯</Text>
              </>
            )}
          </Pressable>
          <Pressable onPress={() => runId('light.horn')} disabled={isPending('light.horn')}
            className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full bg-inset px-4 py-2.5 active:scale-95">
            {isPending('light.horn') ? (
              <PendingSpinner color="#111214" />
            ) : (
              <>
                <Text className="text-[18px] font-icon text-on-surface">{Icon.volume_up}</Text>
                <Text className="text-[12px] font-headline font-bold text-on-surface">鸣笛</Text>
              </>
            )}
          </Pressable>
        </View>
      </Card>

      {/* ===== 9. Sentry Mode（哨兵模式） ===== */}
      <Card className="mb-6">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Text className="text-[20px] font-icon text-on-surface-variant">{Icon.shield}</Text>
            <Text className="text-[16px] font-headline font-semibold text-on-surface">哨兵模式</Text>
          </View>
        </View>
        <View className="mt-4 flex-row gap-2">
          <Text className="flex-1 truncate rounded-full bg-inset px-2 py-1 text-center text-[11px] text-on-surface-variant">
            录像使能: <Text className="font-semibold text-on-surface">{videoText}</Text>
          </Text>
          <Text className="flex-1 truncate rounded-full bg-inset px-2 py-1 text-center text-[11px] text-on-surface-variant">
            维修模式: <Text className="font-semibold text-on-surface">{repairText}</Text>
          </Text>
          <Text className="flex-1 truncate rounded-full bg-inset px-2 py-1 text-center text-[11px] text-on-surface-variant">
            灵敏度: <Text className="font-semibold text-on-surface">{sensitivityText}</Text>
          </Text>
        </View>
        <View className="mt-4 flex-row gap-2.5 pt-1">
          <Pressable onPress={() => runId('sentinel.on')} disabled={isPending('sentinel.on')}
            className="flex-1 items-center justify-center rounded-full bg-on-surface px-3 py-2.5 active:scale-95">
            {isPending('sentinel.on')
              ? <PendingSpinner color="#FFFFFF" />
              : <Text className="text-[12px] font-headline font-bold text-surface">开启哨兵模式</Text>}
          </Pressable>
          <Pressable onPress={() => runId('sentinel.off')} disabled={isPending('sentinel.off')}
            className="flex-1 items-center justify-center rounded-full bg-inset px-3 py-2.5 active:scale-95">
            {isPending('sentinel.off')
              ? <PendingSpinner color="#111214" />
              : <Text className="text-[12px] font-headline font-bold text-on-surface">关闭哨兵模式</Text>}
          </Pressable>
        </View>
      </Card>
    </ScreenScroll>
  );
}

function QuickAction({
  meta,
  highlighted,
  pending,
  onPress,
}: {
  meta: { label: string; note: string; icon: IconName };
  highlighted: boolean;
  pending: boolean;
  onPress: () => void;
}) {
  // 照 a694：卡片恒为 bg-white/rounded-[22px]/p-3；「闪灯」的高亮只体现在图标圈底色（bg-[#F4EF00]），
  // 不是整卡变色。
  return (
    <Pressable
      onPress={onPress}
      disabled={pending}
      className="flex-1 items-center justify-center rounded-[22px] bg-surface p-3 active:scale-95">
      {pending ? (
        <View className="h-[64px] items-center justify-center">
          <PendingSpinner color="#111214" size={20} />
        </View>
      ) : (
        <>
          <View
            className={
              highlighted
                ? 'mb-2 h-11 w-11 items-center justify-center rounded-full bg-primary-container'
                : 'mb-2 h-11 w-11 items-center justify-center rounded-full bg-inset'
            }>
            <Text className="text-[20px] font-icon text-on-surface">{Icon[meta.icon]}</Text>
          </View>
          <Text className="text-center text-[12px] font-headline font-semibold text-on-surface">{meta.label}</Text>
        </>
      )}
    </Pressable>
  );
}

/** 双行胶囊按钮：照 a694 车门区——12px 粗体主文字 + 10px 次要副文字，rounded-full bg-inset。 */
/** 双行胶囊按钮：照 a694 车门区——12px 粗体主文字 + 10px 次要副文字，rounded-full bg-inset。 */
function Pill2({ title, note, pending, onPress }: { title: string; note: string; pending?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={pending}
      className="items-center justify-center rounded-full bg-inset px-4 py-2.5 active:scale-95">
      {pending ? (
        <View className="h-[28px] items-center justify-center">
          <PendingSpinner color="#111214" />
        </View>
      ) : (
        <>
          <Text className="text-[12px] font-headline font-bold text-on-surface">{title}</Text>
          <Text className="text-[10px] font-body text-on-surface-variant">{note}</Text>
        </>
      )}
    </Pressable>
  );
}

function TextPill({ label, pending, onPress }: { label: string; pending?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={pending}
      className="rounded-full bg-inset px-3 py-2.5 items-center justify-center active:scale-95">
      {pending
        ? <PendingSpinner color="#111214" />
        : <Text className="text-[12px] font-headline font-semibold text-on-surface">{label}</Text>}
    </Pressable>
  );
}

/** 扁平只读胶囊：稿子里车窗区的读数格就是这个样式，不是大方盒。 */
function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <View className="basis-[48%] flex-row items-center justify-between rounded-full bg-inset px-3 py-1">
      <Text className="text-[11px] font-body font-medium text-on-surface-variant">{label}</Text>
      <Text className="text-[11px] font-label font-semibold text-on-surface" numberOfLines={1}>
        {value}
      </Text>
    </View>
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

/** 扩展功能入口卡：图标 + 标题 + 副标题，照设计稿的三列卡片。 */
function FeatureEntry({
  icon,
  label,
  note,
  onPress,
}: {
  icon: string;
  label: string;
  note: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 min-h-[92px] rounded-[22px] bg-surface p-3 items-start justify-between active:scale-95">
      <View className="w-8 h-8 rounded-full bg-inset items-center justify-center">
        <Text className="text-[18px] font-icon text-on-surface">{icon}</Text>
      </View>
      <View className="mt-2 w-full">
        <Text className="text-xs font-headline font-bold text-on-surface leading-tight" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-[10px] font-body text-on-surface-variant mt-0.5" numberOfLines={1}>
          {note}
        </Text>
      </View>
    </Pressable>
  );
}
