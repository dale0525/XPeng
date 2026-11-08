import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { VehicleStatus } from '@xpeng/protocol/src/vehicles';
import { Icon, type IconName } from '../icons';

const EMPTY = '—';

type Scalar = number | string | null | undefined;

function readout(value: Scalar, unit = ''): string {
  const text = value === null || value === undefined || value === '' ? EMPTY : String(value);
  return unit ? `${text} ${unit}` : text;
}

/**
 * 分钟类字段：`0` 表示「车端还没开始算」，不是「0 分钟后充满」。
 * 直接输出 `0 分钟` 会被读成一充满即完成，与车控页的「未充电」自相矛盾。
 */
function minutes(value: Scalar): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${n} 分钟` : EMPTY;
}

function paired(first: Scalar, second: Scalar, separator = ' / '): string {
  const absent = (value: Scalar) => value === null || value === undefined || value === '';
  return absent(first) || absent(second) ? EMPTY : `${first}${separator}${second}`;
}

function pressureBar(kpa?: number): string {
  // 遥测胎压以 kPa 上报，稿中单位是 bar。
  return kpa === undefined ? readout(undefined, 'bar') : readout((kpa / 100).toFixed(1), 'bar');
}

function formatChargeDuration(ms?: number): string {
  return readout(ms === undefined || ms <= 0 ? undefined : Math.round(ms / 60000), 'min');
}

function formatCompleteTime(ts?: number): string {
  if (ts === undefined || ts <= 0) return EMPTY;
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 卡头：22px 图标 + 16px 标题，右槽可选。稿中没有圆形图标底。 */
function CardHeader({ icon, title, right }: { icon: IconName; title: string; right?: ReactNode }) {
  return (
    <View className="flex-row items-center justify-between mb-4">
      <View className="flex-row items-center gap-2">
        <Text className="text-[22px] font-icon text-on-surface">{Icon[icon]}</Text>
        <Text className="text-[16px] font-headline font-semibold text-on-surface tracking-tight">
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

/** 只读数据格：标签 12px 次要色，数值粗体；className / valueClass 由调用处给字面量。 */
function Cell({
  label,
  value,
  className,
  valueClass,
}: {
  label: string;
  value: string;
  className: string;
  valueClass: string;
}) {
  return (
    <View className={className}>
      <Text className="text-[12px] font-body text-on-surface-variant">{label}</Text>
      <Text className={`${valueClass} font-headline text-on-surface mt-1`}>{value}</Text>
    </View>
  );
}

/** 只读信息行：标签次要色、值加粗；className 决定上下留白与分隔线。 */
function Row({ label, value, className }: { label: string; value: string; className: string }) {
  return (
    <View className={`flex-row items-center justify-between ${className}`}>
      <Text className="text-[14px] font-body text-on-surface-variant">{label}</Text>
      <Text className="text-[14px] font-headline font-semibold text-on-surface">{value}</Text>
    </View>
  );
}

/** 只读进度轨道：全圆角 8px，底 `bg-inset`，填充强调色，百分位处一枚黄色滑块。 */
function ChargeLimitTrack({ percent }: { percent: number }) {
  return (
    <View>
      <View className="relative w-full h-8 justify-center my-1">
        <View className="w-full h-2 rounded-full bg-inset overflow-hidden">
          <View className="h-full rounded-full bg-primary-container" style={{ width: `${percent}%` }} />
        </View>
        <View
          className="absolute w-5 h-5 rounded-full bg-primary-container border border-primary-fixed-dim"
          style={{ left: `${percent}%`, marginLeft: -10, top: '50%', marginTop: -10 }}
        />
      </View>
      <View className="flex-row items-center justify-between mt-1 px-1">
        <Text className="text-[12px] font-headline text-on-surface-variant">0%</Text>
        <Text className="text-[12px] font-headline text-on-surface-variant">50%</Text>
        <Text className="text-[12px] font-headline text-on-surface-variant">100%</Text>
      </View>
    </View>
  );
}

/** 极简俯视车身线稿：只用 View 拼细线与圆点，不画写实车辆。 */
function CarWireframe() {
  return (
    <View className="w-28 h-36 relative">
      <View className="absolute inset-0 rounded-[44px] border-2 border-surface-variant opacity-50" />
      <View className="absolute left-4 right-4 top-6 h-px bg-surface-variant opacity-50" />
      <View className="absolute left-4 right-4 bottom-6 h-px bg-surface-variant opacity-50" />
      <View className="absolute left-4 top-10 bottom-10 w-px bg-surface-variant opacity-40" />
      <View className="absolute right-4 top-10 bottom-10 w-px bg-surface-variant opacity-40" />
      <View
        className="absolute w-2.5 h-2.5 rounded-full bg-surface-container-highest"
        style={{ left: -2, top: 26 }}
      />
      <View
        className="absolute w-2.5 h-2.5 rounded-full bg-surface-container-highest"
        style={{ right: -2, top: 26 }}
      />
      <View
        className="absolute w-2.5 h-2.5 rounded-full bg-surface-container-highest"
        style={{ left: -2, bottom: 26 }}
      />
      <View
        className="absolute w-2.5 h-2.5 rounded-full bg-surface-container-highest"
        style={{ right: -2, bottom: 26 }}
      />
    </View>
  );
}

export function StatusScreen({
  status,
  bottomInset,
}: {
  status: VehicleStatus | null;
  bottomInset: number;
}) {
  const charge = status?.instant?.charge;
  const odometer = status?.instant?.odometer;
  const tpms = status?.instant?.tpms;
  const power = status?.instant?.power;
  const stats = status?.instant?.chargeStatistics;
  const drive = status?.interval?.drive;
  const soc = charge?.battery_soc;
  const chargeLimit = charge?.max_range_charge;
  const usedElectricity = stats?.usageElectricity;
  const limitPct = chargeLimit === undefined ? 50 : Math.max(0, Math.min(100, chargeLimit));

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-5 pt-4 gap-4"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      showsVerticalScrollIndicator={false}>
      {/* 2. 电池状态卡 */}
      <View className="w-full bg-surface border border-hairline rounded-[28px] p-5">
        <CardHeader
          icon="battery_charging_full"
          title="电池状态"
          right={
            <View className="px-2.5 py-1 rounded-full bg-inset border border-hairline">
              <Text className="text-[11px] font-headline text-on-surface-variant">
                {`SOC: ${readout(soc, '%')}`}
              </Text>
            </View>
          }
        />

        <View className="gap-2.5 mb-2.5">
          <View className="flex-row gap-2.5">
            <Cell
              label="SOC"
              value={readout(soc, '%')}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[76px]"
              valueClass="text-[20px] font-bold"
            />
            <Cell
              label="剩余续航"
              value={readout(odometer?.avalible_driving_distance, 'km')}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[76px]"
              valueClass="text-[20px] font-bold"
            />
          </View>
          <View className="flex-row gap-2.5">
            <Cell
              label="总里程"
              value={readout(odometer?.total_mileage, 'km')}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[76px]"
              valueClass="text-[20px] font-bold"
            />
            <Cell
              label="充电枪连接"
              /* 该字段只有名字、没有取值语义（teardown §803），真机上见过 0 和 7 两种裸值；
                 直接输出数字像 bug 且不可读，故按无数据展示「—」。 */
              value={EMPTY}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[76px]"
              valueClass="text-[20px] font-bold"
            />
          </View>
        </View>

        <View className="gap-2.5">
          <View className="flex-row gap-2.5">
            <Cell
              label="快/慢充接口"
              value={paired(charge?.fast_charge_port_status, charge?.slow_charge_port_status)}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[68px]"
              valueClass="text-[15px] font-semibold"
            />
            <Cell
              label="预计充满"
              value={minutes(charge?.time_to_complete_charge_min)}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[68px]"
              valueClass="text-[15px] font-semibold"
            />
          </View>
          <View className="flex-row gap-2.5">
            <Cell
              label="预约充电"
              value={readout(charge?.reserve_charge_start_time)}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[68px]"
              valueClass="text-[15px] font-semibold"
            />
            <Cell
              label="电池保温"
              value={readout(charge?.battery_keep_warm_status)}
              className="flex-1 bg-inset rounded-[22px] p-3.5 justify-between min-h-[68px]"
              valueClass="text-[15px] font-semibold"
            />
          </View>
        </View>
      </View>

      {/* 3. 上次充电记录卡 */}
      <View className="w-full bg-surface border border-hairline rounded-[28px] p-5">
        <CardHeader icon="history" title="上次充电记录" />
        <View>
          <Row
            label="用电量"
            value={readout(usedElectricity === undefined ? undefined : usedElectricity.toFixed(1), 'kWh')}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="充电时长"
            value={formatChargeDuration(stats?.chargeTime)}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="完成时间"
            value={formatCompleteTime(stats?.completeTime)}
            className="py-3 border-b border-hairline"
          />
          <Row label="增加续航" value={readout(stats?.addedRange, 'km')} className="pt-3" />
        </View>
      </View>

      {/* 4. 充电限制卡 */}
      <View className="w-full bg-surface border border-hairline rounded-[28px] p-5">
        <CardHeader
          icon="tune"
          title="充电限制"
          right={
            <Text className="text-[20px] font-headline font-semibold text-on-surface">
              {readout(chargeLimit, '%')}
            </Text>
          }
        />
        <ChargeLimitTrack percent={limitPct} />
      </View>

      {/* 5. 胎压监测卡 */}
      <View className="w-full bg-surface border border-hairline rounded-[28px] p-5">
        <CardHeader icon="tire_repair" title="胎压监测" />
        <View className="h-44 w-full bg-ink rounded-[22px] items-center justify-center overflow-hidden mb-3">
          <CarWireframe />
        </View>
        <View className="gap-2.5">
          <View className="flex-row gap-2.5">
            <Cell
              label="左前轮"
              value={pressureBar(tpms?.tpms_pressure_fl)}
              className="flex-1 bg-inset rounded-[22px] p-3 justify-between"
              valueClass="text-[18px] font-bold"
            />
            <Cell
              label="右前轮"
              value={pressureBar(tpms?.tpms_pressure_fr)}
              className="flex-1 bg-inset rounded-[22px] p-3 justify-between"
              valueClass="text-[18px] font-bold"
            />
          </View>
          <View className="flex-row gap-2.5">
            <Cell
              label="左后轮"
              value={pressureBar(tpms?.tpms_pressure_rl)}
              className="flex-1 bg-inset rounded-[22px] p-3 justify-between"
              valueClass="text-[18px] font-bold"
            />
            <Cell
              label="右后轮"
              value={pressureBar(tpms?.tpms_pressure_rr)}
              className="flex-1 bg-inset rounded-[22px] p-3 justify-between"
              valueClass="text-[18px] font-bold"
            />
          </View>
        </View>
      </View>

      {/* 6. 里程与定位卡 */}
      <View className="w-full bg-surface border border-hairline rounded-[28px] p-5">
        <CardHeader icon="explore" title="里程与定位" />
        <View>
          <Row
            label="经纬度"
            value={paired(drive?.latitude, drive?.longitude, ', ')}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="航向角"
            value={readout(drive?.angle)}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="车速"
            value={readout(drive?.speed, 'km/h')}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="坐标系"
            value={readout(drive?.coordType)}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="电源/点火状态"
            value={paired(power?.car_power_state, power?.car_igon_state)}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="总里程"
            value={readout(odometer?.total_mileage, 'km')}
            className="py-3 border-b border-hairline"
          />
          <Row
            label="剩余可用综合续航"
            value={readout(odometer?.avalible_driving_distance, 'km')}
            className="pt-3"
          />
        </View>
      </View>
    </ScrollView>
  );
}
