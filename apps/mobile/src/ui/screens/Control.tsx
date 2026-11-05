/**
 * 车控页（对应 `docs/design/control-light.html` / `control-dark.html`）。
 *
 * 设计稿把原来的首页、车控、状态三屏合成一屏，九个模块从上到下排到「里程与定位」。
 * 这里逐模块照抄设计稿的顺序与字段，不做删减，也不自行加设计稿没有的模块。
 *
 * 按钮不硬编码：全部从 `COMMANDS` 表按 `group` 渲染。加一条指令只需往那张表里加一项，
 * 这个文件不用动——这是「后续可扩展」的具体落点。
 *
 * 三处与设计稿不同的地方（设计稿的写法取不到数据，按实测语义改）：
 * 1. 舞台徽章只写「整车已闭锁」，去掉「防盗已布防」——没有对应的布防字段；
 * 2. 哨兵徽章按 `sentinel_mode_video_enable` 显示「录像已启用/已关闭」，不写「防御监视中」；
 * 3. 「上次充电」四项来自 `chargeStatistics`，是最近一次充电的记录，不是累计值。
 */
import { useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import {
  COMMANDS,
  setSentinelSensitivity,
  setTemperature,
  type CommandDef,
} from '@xpeng/protocol/src/commands';
import type { Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import { carLink } from '../../core/car';
import { bleLink } from '../../core/ble';
import { isP5BleV2Vehicle } from '@xpeng/protocol/src/ble-v2-context';
import { BLE_ONLY_V2_COMMAND_IDS, sendVehicleCommand } from '@xpeng/protocol/src/ble-v2-routing';
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
import { SegmentBar } from '../atoms';
import { Icon, type IconName } from '../icons';

const CAR_IMAGE = require('../../assets/car/d55a.png');

type GroupKey = CommandDef['group'];

/** 分组标题、右上角英文小标与短条配色，照抄设计稿 2–6 区的写法。 */
const GROUP_META: Record<
  GroupKey,
  { title: string; caps: string; accent: 'primary' | 'secondary' | 'tertiary' }
> = {
  door: { title: '车门与锁', caps: 'DOOR SYSTEM', accent: 'primary' },
  window: { title: '车窗与遮阳帘', caps: '', accent: 'secondary' },
  hvac: { title: '空调与座椅', caps: '', accent: 'primary' },
  light: { title: '灯光与寻车', caps: 'LOCATE VEHICLE', accent: 'primary' },
  sentinel: { title: '哨兵模式', caps: '', accent: 'tertiary' },
};

/** 每条指令的图标，照抄设计稿按钮上的字形。 */
const CMD_ICONS: Record<string, IconName> = {
  'door.unlock': 'lock_open',
  'door.lock': 'lock',
  'shade.open': 'expand_less',
  'shade.close': 'expand_more',
  'window.down': 'air',
  'window.up': 'check_box_outline_blank',
  'hvac.on': 'power_settings_new',
  'hvac.off': 'mode_standby',
  'hvac.quickCool': 'ac_unit',
  'hvac.quickWarm': 'whatshot',
  'hvac.highTemp': 'clean_hands',
  'light.flash': 'lightbulb',
  'light.horn': 'volume_up',
  'sentinel.on': 'security',
  'sentinel.off': 'gpp_bad',
};

type CommandOutcome = CommandVisualState | 'unconfirmed';
type States = Record<string, CommandOutcome>;

export function ControlScreen({
  vehicle,
  status,
  onRefresh,
  bottomInset,
}: {
  vehicle: Vehicle;
  status: VehicleStatus | null;
  onRefresh: () => void;
  bottomInset: number;
}) {
  const [states, setStates] = useState<States>({});
  const [temp, setTemp] = useState<number | null>(null);
  const [bleState, setBleState] = useState(bleLink.uiState);

  useEffect(() => bleLink.subscribe(setBleState), []);

  async function run(def: CommandDef) {
    setStates((s) => ({ ...s, [def.id]: 'pending' }));
    const result = await sendVehicleCommand(vehicle, def, {
      send: (command) => carLink.send(command),
      executePreparedV2: (vin, code) => bleLink.executePreparedV2(vin, code),
    });
    if (!result.ok) console.warn(`[cmd] ${def.id}:`, result.error, 'msgId=', result.msgId);
    const outcome: CommandOutcome = result.ok ? 'success'
      : result.unconfirmed ? 'unconfirmed' : 'failed';
    setStates((s) => ({ ...s, [def.id]: outcome }));
    setTimeout(() => {
      setStates((s) => ({ ...s, [def.id]: 'idle' }));
    }, 3000);
    if (result.ok) carLink.readStatus().catch(() => {});
  }

  async function changeTemp(delta: number) {
    const current = temp ?? status?.instant.hvac.hvac_temp ?? 22;
    const next = Math.min(30, Math.max(16, current + delta));
    setTemp(next);
    const { serviceType, msgContent } = setTemperature(next);
    await carLink.send({ id: 'hvac.temp', label: '设定温度', group: 'hvac', serviceType, msgContent });
    carLink.readStatus().catch(() => {});
  }

  async function changeSensitivity(level: 1 | 2 | 3) {
    const { serviceType, msgContent } = setSentinelSensitivity(level);
    await carLink.send({
      id: `sentinel.sens${level}`,
      label: `灵敏度${['低', '中', '高'][level - 1]}`,
      group: 'sentinel',
      serviceType,
      msgContent,
    });
    carLink.readStatus().catch(() => {});
  }

  const i = status?.instant;
  const d = i?.door;
  const w = i?.window;
  const h = i?.hvac;
  const c = i?.charge;
  const o = i?.odometer;
  const t = i?.tpms;
  const seat = i?.seat;
  const solar = i?.solarRoof;
  const trunk = i?.trunkPower;
  const ext = i?.ext;
  const stats = i?.chargeStatistics;
  const drive = status?.interval?.drive;

  const locked = d?.driver_door_lock_st === 1;
  const shadePos = w?.sky_sun_shade_position ?? 0;
  const displayTemp = temp ?? h?.hvac_temp ?? 24;
  const p5Ble = isP5BleV2Vehicle(vehicle);
  const defs = (g: GroupKey) => COMMANDS.filter((x) =>
    x.group === g && (p5Ble || !BLE_ONLY_V2_COMMAND_IDS.includes(x.id as typeof BLE_ONLY_V2_COMMAND_IDS[number])));
  const st = (id: string): CommandOutcome => states[id] ?? 'idle';

  const doorCells = [
    { label: '主驾门', v: d?.driver_door_ajar_st },
    { label: '副驾门', v: d?.passenger_door_ajar_st },
    { label: '左后门', v: d?.rear_left_door_ajar_st },
    { label: '右后门', v: d?.rear_right_door_ajar_st },
    { label: '后备箱', v: d?.trunk_ajar_st },
  ];

  const windowCells = [
    { label: '左前窗', v: w?.front_left_window_position },
    { label: '右前窗', v: w?.front_right_window_position },
    { label: '左后窗', v: w?.rear_left_window_position },
    { label: '右后窗', v: w?.rear_right_window_position },
  ];

  return (
    <ScreenScroll bottomInset={bottomInset}>
      {/* 1. 车辆舞台 */}
      <Card>
        <View className="flex-row items-center justify-between mb-2">
          <View className="flex-row items-center gap-1 px-2.5 py-1 rounded bg-surface-container border border-outline-variant/50">
            <Text className="text-[13px] font-icon text-secondary">{Icon.verified_user}</Text>
            <Text className="text-xs font-semibold text-on-surface">
              {locked === undefined ? '整车状态未知' : locked ? '整车已闭锁' : '整车已解锁'}
            </Text>
          </View>
          <Text className="text-[10px] font-mono font-bold tracking-wider text-secondary uppercase">
            TELEMETRICS READY
          </Text>
        </View>

        <View className="relative w-full rounded-lg overflow-hidden bg-surface-container-low items-center justify-center py-2">
          <Image source={CAR_IMAGE} className="w-full h-44" resizeMode="contain" />
          {/* 五个部位浮标：位置照抄设计稿的四角 + 底部居中 */}
          <DoorTag label="左前门" ajar={d?.driver_door_ajar_st} pos="top-2 left-2" />
          <DoorTag label="右前门" ajar={d?.passenger_door_ajar_st} pos="top-2 right-2" />
          <DoorTag label="左后门" ajar={d?.rear_left_door_ajar_st} pos="bottom-9 left-2" />
          <DoorTag label="右后门" ajar={d?.rear_right_door_ajar_st} pos="bottom-9 right-2" />
          <DoorTag label="后备箱" ajar={d?.trunk_ajar_st} pos="bottom-2 center" />
        </View>

        <View className="mt-2.5 pt-2 border-t border-outline-variant/40 flex-row items-center justify-between">
          <View className="flex-row items-center gap-1">
            <Text className="text-[13px] font-icon text-secondary">{Icon.check_circle}</Text>
            <Text className="text-xs text-on-surface">4门+后备箱防盗闭锁就绪</Text>
          </View>
          <View className="flex-row items-center gap-1">
            <View className="w-1.5 h-1.5 rounded-full bg-primary" />
            <Text className="text-[11px] font-mono font-bold text-primary">
              哨兵模式：{ext?.sentinel_mode_video_enable === 1 ? '已启用' : '已关闭'}
            </Text>
          </View>
        </View>
      </Card>

      {/* 2. 车门与锁 */}
      <Card>
        <SectionHeader
          title={GROUP_META.door.title}
          accent={GROUP_META.door.accent}
          right={<CapsTag text={GROUP_META.door.caps} />}
        />
        <View className="flex-row gap-2.5 mb-2.5">
          {defs('door').map((def) => (
            <View key={def.id} className="flex-1">
              <CommandButton
                icon={CMD_ICONS[def.id] ?? 'lock'}
                label={def.label}
                state={st(def.id) !== 'idle' ? st(def.id) : def.id === 'door.lock' && locked ? 'primary' : 'idle'}
                variant={def.id === 'door.lock' ? 'solid' : 'soft'}
                tint="primary"
                onPress={() => run(def)}
              />
            </View>
          ))}
        </View>
        <StatusStrip
          label="当前门锁状态"
          value={locked === undefined ? '—' : locked ? '已锁止 · 全部安全' : '已解锁'}
          className="mb-2.5"
        />
        <StatusStrip
          label="数字钥匙 / 蓝牙"
          value={Object.values(states).includes('unconfirmed')
            ? '指令已发送 · 请核对车况'
            : bleState.error ? `${bleState.label} · ${bleState.error}` : bleState.label}
          valueClass={bleState.connected ? 'text-primary' : bleState.phase === 'error' ? 'text-error' : 'text-secondary'}
          className="mb-2.5"
        />
        <View className="flex-row gap-1.5">
          {doorCells.map((cell) => (
            <ReadoutCell
              key={cell.label}
              label={cell.label}
              value={cell.v === undefined ? '—' : cell.v === 0 ? '闭合' : '未关'}
              valueClass={cell.v === 0 ? 'text-on-surface' : 'text-error'}
            />
          ))}
        </View>
        <View className="mt-2">
          <InfoRow
            label="临时锁车"
            value={d?.temp_lock_st === undefined ? '—' : d.temp_lock_st === 1 ? '已启用' : '未启用'}
            small
          />
        </View>
      </Card>

      {/* 3. 车窗与遮阳帘 */}
      <Card>
        <SectionHeader
          title={GROUP_META.window.title}
          accent={GROUP_META.window.accent}
          right={
            <Text className="text-xs font-mono font-medium text-on-surface-variant">
              天幕开度：{shadePos}%（{shadePos >= 100 ? '完全打开' : shadePos <= 0 ? '完全关闭' : '部分打开'}）
            </Text>
          }
        />
        <View className="flex-row flex-wrap gap-2 mb-2.5">
          {defs('window').map((def) => (
            <View key={def.id} style={{ width: '48%' }}>
              <CommandButton
                icon={CMD_ICONS[def.id] ?? 'air'}
                label={def.label}
                state={st(def.id)}
                variant="soft"
                tint={def.id === 'window.down' ? 'secondary' : 'primary'}
                onPress={() => run(def)}
              />
            </View>
          ))}
        </View>
        <View className="flex-row gap-1.5 mb-2.5">
          {windowCells.map((cell) => {
            // 100 = 完全关闭，0 = 完全打开；设计稿写「0% (已闭)」，按关闭程度换算
            const closed = cell.v === undefined ? undefined : cell.v;
            return (
              <ReadoutCell
                key={cell.label}
                label={cell.label}
                value={closed === undefined ? '—' : `${closed}%`}
                sub={closed === undefined ? undefined : closed >= 100 ? '(已闭)' : '(开启)'}
                valueClass={closed !== undefined && closed >= 100 ? 'text-on-surface' : 'text-secondary'}
              />
            );
          })}
        </View>
        <View className="flex-row gap-2">
          <View className="flex-1 bg-surface-container-low border border-outline-variant/50 p-2.5 rounded-lg">
            <View className="flex-row items-center gap-1 mb-1">
              <Text className="text-[13px] font-icon text-primary">{Icon.solar_power}</Text>
              <Text className="text-xs font-bold text-on-surface">太阳能天窗</Text>
            </View>
            <InfoRow
              label="工作状态"
              value={solar === undefined ? '—' : solar.solarWorkStatus === 1 ? '采光发电中' : '待机'}
              valueClass="text-secondary"
              small
            />
            <InfoRow
              label="故障状态"
              value={solar === undefined ? '—' : solar.solarFaultStatus === 0 ? '无故障（正常）' : '有故障'}
              small
            />
            <InfoRow label="今日通风次数" value={`${solar?.solarVentilateToday ?? '—'} 次`} small />
            <InfoRow label="今日通风时长" value={`${solar?.solarVentilateLengthToday ?? '—'} 分钟`} small />
            <InfoRow
              label="通风状态"
              value={
                solar === undefined ? '—' : solar.solarVentilateStatus === 1 ? '通风中' : '未通风'
              }
              valueClass={solar?.solarVentilateStatus === 1 ? 'text-secondary' : 'text-on-surface-variant'}
              small
            />
          </View>
          <View className="flex-1 bg-surface-container-low border border-outline-variant/50 p-2.5 rounded-lg">
            <View className="flex-row items-center gap-1 mb-1">
              <Text className="text-[13px] font-icon text-secondary">{Icon.sensor_door}</Text>
              <Text className="text-xs font-bold text-on-surface">电动尾门</Text>
            </View>
            <InfoRow
              label="尾门开关"
              value={trunk === undefined ? '—' : trunk.powerSwitch === 1 ? '已开启' : '已关闭'}
              valueClass="text-secondary"
              small
            />
            <InfoRow
              label="自动关闭倒计时"
              value={
                trunk === undefined
                  ? '—'
                  : trunk.timeToPowerOffInMin > 0
                    ? `${trunk.timeToPowerOffInMin} 分钟`
                    : '--（闭锁正常）'
              }
              small
            />
          </View>
        </View>
      </Card>

      {/* 4. 空调与座椅 */}
      <Card>
        <SectionHeader
          title={GROUP_META.hvac.title}
          accent={GROUP_META.hvac.accent}
          right={
            <View className="px-2 py-0.5 rounded bg-surface-container">
              <Text className="text-xs font-mono font-bold text-secondary">
                车内温度 {h?.hvac_inner_temp ?? '—'}°C
              </Text>
            </View>
          }
        />
        <View className="flex-row gap-1 mb-3">
          {defs('hvac').map((def) => (
            <CommandButton
              key={def.id}
              icon={CMD_ICONS[def.id] ?? 'power_settings_new'}
              label={def.label}
              state={
                st(def.id) !== 'idle'
                  ? st(def.id)
                  : def.id === 'hvac.on' && h?.hvac_on === 1
                    ? 'primary'
                    : 'idle'
              }
              variant="tile"
              tint={
                def.id === 'hvac.quickCool'
                  ? 'secondary'
                  : def.id === 'hvac.quickWarm'
                    ? 'primary'
                    : def.id === 'hvac.highTemp'
                      ? 'tertiary'
                      : undefined
              }
              onPress={() => run(def)}
            />
          ))}
        </View>

        <View className="bg-surface-container-low rounded-lg p-3 border border-outline-variant/50 flex-row items-center justify-between mb-2.5">
          <Pressable
            onPress={() => changeTemp(-1)}
            accessibilityLabel="调低温度"
            className="w-10 h-10 rounded-full bg-surface border border-outline-variant/70 items-center justify-center active:scale-95">
            <Text className="text-[20px] font-icon text-on-surface">{Icon.remove}</Text>
          </Pressable>
          <View className="items-center">
            <Text className="font-mono text-3xl font-extrabold text-on-surface tracking-tight">
              {displayTemp}°C
            </Text>
            <Text className="text-[11px] text-on-surface-variant mt-0.5">
              {h?.hvac_auto === 1 ? '双温区同步 · 自动模式' : '双温区同步 · 手动模式'}
            </Text>
          </View>
          <Pressable
            onPress={() => changeTemp(1)}
            accessibilityLabel="调高温度"
            className="w-10 h-10 rounded-full bg-surface border border-outline-variant/70 items-center justify-center active:scale-95">
            <Text className="text-[20px] font-icon text-on-surface">{Icon.add}</Text>
          </Pressable>
        </View>

        <View className="flex-row bg-surface-container/60 p-1.5 rounded-md border border-outline-variant/40 mb-2.5">
          <MicroStat label="风量" value={`${h?.hvac_wind_speed ?? '—'}档`} />
          <MicroStat label="AUTO" value={h?.hvac_auto === 1 ? '开启' : '关闭'} on={h?.hvac_auto === 1} />
          <MicroStat label="除霜" value={h?.hvac_defrost === 1 ? '开启' : '关闭'} on={h?.hvac_defrost === 1} />
          <MicroStat
            label="极速升温"
            value={h?.hvac_quick_warm_mode === 1 ? '开启' : '关闭'}
            on={h?.hvac_quick_warm_mode === 1}
          />
          <MicroStat
            label="极速降温"
            value={h?.hvac_quick_cool_mode === 1 ? '开启' : '关闭'}
            on={h?.hvac_quick_cool_mode === 1}
          />
          <MicroStat
            label="高温抑菌"
            value={h?.hvac_high_temp_mode === 1 ? '开启' : '关闭'}
            on={h?.hvac_high_temp_mode === 1}
          />
        </View>

        <View className="bg-surface-container-low p-2.5 rounded-lg border border-outline-variant/50">
          <View className="flex-row items-center justify-between border-b border-outline-variant/40 pb-1.5 mb-2">
            <View className="flex-row items-center gap-1">
              <Text className="text-[13px] font-icon text-primary">{Icon.airline_seat_recline_extra}</Text>
              <Text className="text-xs font-semibold text-on-surface">座椅加热与通风</Text>
            </View>
            <Text className="text-[11px] font-mono text-outline">COMFORT MATRIX</Text>
          </View>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <InfoRow label="主驾加热" value={`${seat?.driver_seat_heat ?? '—'}档`} small />
              <InfoRow label="副驾加热" value={`${seat?.passenger_seat_heat ?? '—'}档`} small />
              <InfoRow
                label="后排加热"
                value={`左${seat?.left_rear_seat_heat ?? '—'} / 右${seat?.right_rear_seat_heat ?? '—'}`}
                small
              />
            </View>
            <View className="flex-1 pl-2 border-l border-outline-variant/50">
              <InfoRow
                label="主驾通风"
                value={`${seat?.driver_seat_ventilation ?? '—'}档`}
                valueClass={seat?.driver_seat_ventilation ? 'text-secondary' : 'text-on-surface-variant'}
                small
              />
              <InfoRow
                label="副驾通风"
                value={`${seat?.passenger_seat_ventilation ?? '—'}档`}
                valueClass={seat?.passenger_seat_ventilation ? 'text-secondary' : 'text-on-surface-variant'}
                small
              />
              <InfoRow
                label="后排通风"
                value={`左${seat?.left_rear_seat_ventilation ?? '—'} / 右${seat?.right_rear_seat_ventilation ?? '—'}`}
                small
              />
              <InfoRow
                label="主驾坐姿"
                value={seat === undefined ? '—' : seat.driver_seat_state === 1 ? '已占用' : '未占用'}
                small
              />
            </View>
          </View>
        </View>
      </Card>

      {/* 5. 灯光与寻车 */}
      <Card>
        <SectionHeader
          title={GROUP_META.light.title}
          accent={GROUP_META.light.accent}
          right={<CapsTag text={GROUP_META.light.caps} />}
        />
        <View className="flex-row gap-2.5">
          {defs('light').map((def) => (
            <View key={def.id} className="flex-1">
              <CommandButton
                icon={CMD_ICONS[def.id] ?? 'lightbulb'}
                label={def.label}
                state={st(def.id)}
                variant="soft"
                tint="primary"
                onPress={() => run(def)}
              />
            </View>
          ))}
        </View>
      </Card>

      {/* 6. 哨兵模式 */}
      <Card>
        <SectionHeader
          title={GROUP_META.sentinel.title}
          accent={GROUP_META.sentinel.accent}
          right={
            <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-tertiary/10">
              <View className="w-1.5 h-1.5 rounded-full bg-tertiary" />
              <Text className="text-[11px] font-bold font-mono text-tertiary">
                录像{ext?.sentinel_mode_video_enable === 1 ? '已启用' : '已关闭'}
              </Text>
            </View>
          }
        />
        <View className="flex-row gap-2 mb-3">
          {defs('sentinel').map((def) => {
            const on = def.id === 'sentinel.on';
            return (
              <View key={def.id} className="flex-1">
                <CommandButton
                  icon={CMD_ICONS[def.id] ?? 'security'}
                  label={def.label}
                  state={
                    st(def.id) !== 'idle'
                      ? st(def.id)
                      : on && ext?.sentinel_mode_video_enable === 1
                        ? 'primary'
                        : 'idle'
                  }
                  variant="soft"
                  onPress={() => run(def)}
                />
              </View>
            );
          })}
        </View>

        <View className="bg-surface-container-low p-2.5 rounded-lg border border-outline-variant/50 mb-2.5">
          <Text className="text-xs text-on-surface-variant mb-1.5 font-medium">
            碰撞与靠近感应灵敏度
          </Text>
          <View className="flex-row gap-1 bg-surface-container p-1 rounded-md">
            {(['低', '中', '高'] as const).map((label, idx) => {
              const on = ext?.sentinel_mode_sensitivity === idx + 1;
              return (
                <Pressable
                  key={label}
                  onPress={() => changeSensitivity((idx + 1) as 1 | 2 | 3)}
                  className={`flex-1 py-1 items-center rounded ${on ? 'bg-secondary' : ''} active:scale-95`}>
                  <Text
                    className={`text-xs font-medium ${
                      on ? 'text-white font-bold' : 'text-on-surface-variant'
                    }`}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View className="flex-row gap-1.5">
          <SmallStat
            label="哨兵影像开关"
            value={ext?.soldier_camera_status === 1 ? '开启' : '关闭'}
            on={ext?.soldier_camera_status === 1}
          />
          <SmallStat
            label="录像使能"
            value={ext?.sentinel_mode_video_enable === 1 ? '开启' : '关闭'}
            on={ext?.sentinel_mode_video_enable === 1}
          />
          <SmallStat label="维修模式" value={ext?.repairMode === 1 ? '开启' : '关闭'} on={ext?.repairMode === 1} />
        </View>
      </Card>

      {/* 7. 电池与充电 */}
      <Card>
        <SectionHeader title="电池与充电" accent="primary" />
        <View className="bg-surface-container-low rounded-lg p-3 border border-outline-variant/50 mb-3">
          <View className="flex-row items-baseline justify-between">
            <View className="flex-row items-baseline gap-1">
              <Text className="font-mono text-3xl font-black text-on-surface tracking-tight">
                {c?.battery_soc ?? '—'}%
              </Text>
              <Text className="text-xs text-on-surface-variant">剩余电量</Text>
            </View>
            <View className="flex-row items-baseline gap-1">
              <Text className="font-mono text-2xl font-black text-primary tracking-tight">
                {o?.avalible_driving_distance ?? '—'}
              </Text>
              <Text className="text-xs font-mono text-on-surface-variant">km 续航</Text>
            </View>
          </View>
          <View className="my-2">
            <SegmentBar
              total={10}
              filled={Math.round((c?.battery_soc ?? 0) / 10)}
              fillClass="bg-primary-container"
              emptyClass="bg-surface-container-highest"
              height={8}
            />
          </View>
          <View className="flex-row justify-between pt-1 border-t border-outline-variant/40">
            <Text className="text-[11px] font-mono text-on-surface-variant">
              总里程：{(o?.total_mileage ?? 0).toLocaleString()} km
            </Text>
            <Text className="text-[11px] font-mono text-on-surface-variant">
              充电限值：{c?.max_range_charge ?? '—'}%
            </Text>
          </View>
        </View>

        <View className="bg-surface-container/60 p-2.5 rounded-lg border border-outline-variant/40 mb-3">
          <View className="flex-row flex-wrap">
            <HalfRow label="充电状态" value={chargeStateText(c?.charging_state)} />
            <HalfRow label="充电枪连接" value={c?.charge_connector_status === 1 ? '已连接' : '未连接'} />
            <HalfRow label="充电枪锁" value={c?.charge_gun_lock_status === 1 ? '已锁' : '未锁'} />
            <HalfRow label="充电枪状态" value={c?.charge_gun_status === 1 ? '已插枪' : '未插枪'} />
            <HalfRow label="慢充口" value={c?.slow_charge_port_status === 1 ? '开启' : '关闭'} />
            <HalfRow label="快充口" value={c?.fast_charge_port_status === 1 ? '开启' : '关闭'} />
            <HalfRow
              label="预计充满时间"
              value={
                c === undefined
                  ? '—'
                  : c.time_to_complete_charge_min > 0 ? `${c.time_to_complete_charge_min} 分钟` : '--'
              }
            />
            <HalfRow
              label="预约充电开始"
              value={c?.reserve_charge_start_time ? c.reserve_charge_start_time : '--'}
            />
            <HalfRow
              label="重复周期"
              value={c === undefined ? '—' : c.repeat_type === 0 ? '单次' : `类型 ${c.repeat_type}`}
            />
          </View>
          <View className="pt-1 mt-1 border-t border-outline-variant/30">
            <InfoRow
              label="电池保温"
              value={c?.battery_keep_warm_status === 1 ? '开启' : '关闭'}
            />
          </View>
        </View>

        <View className="bg-surface-container-low rounded-lg p-2.5 border border-outline-variant/50">
          <View className="flex-row items-center gap-1 mb-2">
            <Text className="text-[13px] font-icon text-secondary">{Icon.analytics}</Text>
            <Text className="text-[11px] font-bold text-on-surface">上次充电</Text>
          </View>
          <View className="flex-row flex-wrap gap-2">
            <StatBox label="上次充电用电量" value={`${stats?.usageElectricity?.toFixed(1) ?? '—'} kWh`} />
            <StatBox label="上次充电时长" value={formatChargeDuration(stats?.chargeTime)} />
            <StatBox label="上次充电完成时间" value={formatTime(stats?.completeTime)} />
            <StatBox
              label="上次充电增加续航"
              value={`${stats?.addedRange?.toLocaleString() ?? '—'} km`}
              valueClass="text-secondary"
            />
          </View>
        </View>
      </Card>

      {/* 8. 胎压监测 */}
      <Card>
        <SectionHeader
          title="胎压监测 (TPMS)"
          accent="secondary"
          right={
            <View className="px-2 py-0.5 rounded bg-secondary/10">
              <Text className="text-[11px] font-mono font-bold text-secondary">四轮气压均衡 / 正常</Text>
            </View>
          }
        />
        <View className="flex-row flex-wrap gap-2">
          <TireCell label="左前轮 FL" kpa={t?.tpms_pressure_fl} warn={t?.tpms_pressure_fl_warn} />
          <TireCell label="右前轮 FR" kpa={t?.tpms_pressure_fr} warn={t?.tpms_pressure_fr_warn} />
          <TireCell label="左后轮 RL" kpa={t?.tpms_pressure_rl} warn={t?.tpms_pressure_rl_warn} />
          <TireCell label="右后轮 RR" kpa={t?.tpms_pressure_rr} warn={t?.tpms_pressure_rr_warn} />
        </View>
      </Card>

      {/* 9. 里程与定位 */}
      <Card>
        <SectionHeader
          title="里程与定位"
          accent="primary"
          right={
            <View className="flex-row items-center gap-1">
              <Text className="text-[11px] font-icon text-secondary">{Icon.gps_fixed}</Text>
              <Text className="text-[11px] font-mono text-secondary">
                {drive?.coordValid === 1 ? '高精度定位活跃' : '定位无效'}
              </Text>
            </View>
          }
        />
        <View className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/50 mb-2.5">
          <InfoRow
            label="当前坐标"
            value={
              drive === undefined
                ? '—'
                : `${drive.latitude.toFixed(4)}° N, ${drive.longitude.toFixed(4)}° E`
            }
          />
          <InfoRow
            label="航向角"
            value={drive === undefined ? '—' : `${drive.angle.toFixed(0)}° (${headingText(drive.angle)})`}
          />
          <InfoRow
            label="当前车速"
            value={drive === undefined ? '—' : `${Math.round(Number(drive.speed))} km/h`}
            valueClass="text-secondary"
          />
          <InfoRow
            label="坐标系"
            value={drive === undefined ? '—' : coordTypeText(drive.coordType)}
          />
          <InfoRow
            label="续航工况编号"
            value={o === undefined ? '—' : String(o.range_type)}
          />
        </View>
        <View className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/50 mb-2.5">
          <InfoRow
            label="车辆电源"
            value={
              i?.power === undefined
                ? '—'
                : i.power.car_power_state === 1 ? '已上电' : '未上电'
            }
          />
          <InfoRow
            label="点火状态"
            value={
              i?.power === undefined ? '—' : i.power.car_igon_state === 1 ? '已点火' : '未点火'
            }
          />
          <InfoRow
            label="远程启动"
            value={
              i?.power === undefined
                ? '—'
                : i.power.remote_start_status === 1 ? '运行中' : '未启动'
            }
          />
        </View>
        <View className="flex-row gap-2 pt-1 border-t border-outline-variant/40">
          <SummaryCell label="总里程" value={`${(o?.total_mileage ?? 0).toLocaleString()} km`} />
          <SummaryCell
            label="剩余续航"
            value={`${o?.avalible_driving_distance ?? '—'} km`}
            valueClass="text-primary"
          />
        </View>
      </Card>
    </ScreenScroll>
  );
}

/** 舞台上的部位浮标。`pos` 是设计稿里的绝对定位类名。 */
function DoorTag({ label, ajar, pos }: { label: string; ajar?: number; pos: string }) {
  const closed = ajar === 0;
  const centered = pos.includes('center');
  return (
    <View
      className={`absolute ${pos} flex-row items-center gap-1 px-2 py-0.5 rounded bg-surface/90 border border-outline-variant/60`}
      style={centered ? { left: '50%', marginLeft: -46 } : undefined}>
      <View className={`w-1.5 h-1.5 rounded-full ${closed ? 'bg-secondary' : 'bg-error'}`} />
      <Text className="text-[11px] font-medium text-on-surface">{label}</Text>
      <Text
        className={`text-[11px] font-mono font-semibold ${closed ? 'text-secondary' : 'text-error'}`}>
        {ajar === undefined ? '—' : closed ? '闭合' : '未关'}
      </Text>
    </View>
  );
}

function MicroStat({ label, value, on }: { label: string; value: string; on?: boolean }) {
  return (
    <View className="flex-1 items-center">
      <Text className="text-[9px] text-on-surface-variant">{label}</Text>
      <Text
        className={`text-[10px] font-mono font-bold ${on ? 'text-secondary' : 'text-on-surface-variant'}`}>
        {value}
      </Text>
    </View>
  );
}

function SmallStat({ label, value, on }: { label: string; value: string; on?: boolean }) {
  return (
    <View className="flex-1 bg-surface-container py-1.5 rounded border border-outline-variant/40 items-center">
      <Text className="text-[10px] text-on-surface-variant">{label}</Text>
      <Text
        className={`font-mono text-[11px] font-medium mt-0.5 ${on ? 'text-secondary font-bold' : 'text-on-surface'}`}>
        {value}
      </Text>
    </View>
  );
}

function HalfRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="w-1/2 flex-row justify-between items-center py-1 pr-2">
      <Text className="text-[11px] text-on-surface-variant">{label}</Text>
      <Text className="font-mono text-[11px] font-medium text-on-surface">{value}</Text>
    </View>
  );
}

function StatBox({
  label,
  value,
  valueClass = 'text-on-surface',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <View style={{ width: '48%' }} className="bg-surface p-2 rounded border border-outline-variant/30">
      <Text className="text-[10px] text-on-surface-variant">{label}</Text>
      <Text className={`font-mono text-sm font-bold ${valueClass}`} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function SummaryCell({
  label,
  value,
  valueClass = 'text-on-surface',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <View className="flex-1 items-center">
      <Text className="text-[10px] text-on-surface-variant">{label}</Text>
      <Text className={`font-mono text-sm font-bold ${valueClass}`}>{value}</Text>
    </View>
  );
}

/** 胎压格：接口给 kPa，设计稿显示 bar，除以 100。 */
function TireCell({ label, kpa, warn }: { label: string; kpa?: number; warn?: number }) {
  return (
    <View
      style={{ width: '48%' }}
      className="bg-surface-container-low p-2.5 rounded-lg border border-outline-variant/50 flex-row items-center justify-between">
      <View>
        <Text className="text-[11px] text-on-surface-variant font-mono">{label}</Text>
        <Text className="font-mono text-lg font-bold text-on-surface">
          {kpa === undefined ? '—' : (kpa / 100).toFixed(1)}
          <Text className="text-xs font-normal"> bar</Text>
        </Text>
      </View>
      <View className="px-2 py-1 rounded bg-surface border border-outline-variant/40">
        <Text className={`text-xs font-medium ${warn === 0 ? 'text-secondary' : 'text-error'}`}>
          {warn === undefined ? '—' : warn === 0 ? '正常' : '异常'}
        </Text>
      </View>
    </View>
  );
}

/**
 * `charging_state` 的取值表。
 *
 * 15 = 未充电，来自 `work/live/st19_full.json` 实测；其余取值按 App 字符串池里的
 * 「充电中 / 充电完成 / 充电故障 / 充电暂停 / 充电预约生效」顺序推断，未逐一实测。
 */
function chargeStateText(state?: number): string {
  if (state === undefined) return '—';
  const table: Record<number, string> = {
    0: '未充电',
    1: '充电中',
    2: '充电完成',
    3: '充电故障',
    4: '充电暂停',
    15: '未充电',
  };
  return table[state] ?? `状态 ${state}`;
}

/** `chargeTime` 单位是毫秒（20789000 → 5.8 小时），不是秒也不是小时。 */
function formatChargeDuration(ms?: number): string {
  if (ms === undefined || ms <= 0) return '—';
  const totalMin = Math.round(ms / 1000 / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

/** `completeTime` 是毫秒时间戳。 */
function formatTime(ts?: number): string {
  if (ts === undefined || ts <= 0) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function headingText(angle: number): string {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return dirs[Math.round(angle / 45) % 8];
}

/**
 * 坐标系取值。APK 里 `coordType` 只找到 1/2 两个分支的字符串，未逐一实测，
 * 这里按常见约定给中文名，未知值原样显示数字，不猜。
 */
function coordTypeText(type: number): string {
  const table: Record<number, string> = { 1: 'WGS-84', 2: 'GCJ-02' };
  return table[type] ?? `类型 ${type}`;
}
