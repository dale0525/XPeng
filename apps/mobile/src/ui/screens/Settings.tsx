import type * as React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import type { LinkState } from '../../core/car';
import type { SessionState } from '../../core/session';
import type { ThemeMode } from '../../core/theme';
import type { UpdateState } from '../../core/update';
import {
  CapsTag,
  Card,
  InfoRow,
  PrimaryButton,
  ReadoutCell,
  ScreenScroll,
  SectionHeader,
  StatusStrip,
} from '../components';
import { DotTag, SpinnerIcon } from '../atoms';
import { Icon, type IconName } from '../icons';

const CAR_IMAGE = require('../../assets/car/d55a.png');

const THEME_OPTIONS: Array<{ key: ThemeMode; label: string }> = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
];

const CAPABILITY_LABELS = ['远程车控', '哨兵模式', '胎压监测', '遮阳帘', '蓝牙钥匙'];

export function SettingsScreen(props: {
  bottomInset: number;
  session: Extract<SessionState, { kind: 'active' }>['session'];
  vehicle: Vehicle;
  status: VehicleStatus | null;
  linkState: LinkState;
  latencyMs: number | null;
  mqttExpireAt: number | null;
  theme: ThemeMode;
  onThemeChange: (m: ThemeMode) => void;
  onReconnect: () => void;
  onLogout: () => void;
  versionName: string;
  update: UpdateState;
  onCheckUpdate: () => void;
  onDownload: () => void;
}): React.JSX.Element {
  const {
    bottomInset,
    session,
    vehicle,
    status,
    linkState,
    latencyMs,
    mqttExpireAt,
    theme,
    onThemeChange,
    onReconnect,
    onLogout,
    versionName,
    update,
    onCheckUpdate,
    onDownload,
  } = props;

  const linkText =
    linkState === 'online'
      ? '已连接'
      : linkState === 'connecting'
        ? '连接中'
        : linkState === 'offline'
          ? '未连接'
          : '—';

  return (
    <ScreenScroll bottomInset={bottomInset}>
      <View className="pt-2 pb-1">
        <Text className="font-headline text-3xl font-bold tracking-tight text-on-surface">设置</Text>
        <Text className="mt-1 text-xs font-body font-medium text-on-surface-variant">
          自研车控节点设置与车辆参数面板
        </Text>
      </View>

      <Card>
        <View className="flex-row items-center justify-between pb-3 border-b border-hairline">
          <View className="flex-row items-center gap-2">
            <View className="w-2 h-2 rounded-full bg-primary-container" />
            <Text className="font-headline text-base font-semibold text-on-surface">
              {vehicle.plateNo ? `车辆：${vehicle.plateNo}` : '车辆：—'}
            </Text>
          </View>
          <DotPill label="已同步" compact />
        </View>

        <View className="mt-4 p-4 rounded-box bg-ink relative overflow-hidden">
          <Image
            source={CAR_IMAGE}
            className="absolute top-0 bottom-0 right-0 w-44"
            resizeMode="contain"
            style={{ opacity: 0.85 }}
          />
          <View>
            <Text className="text-xs font-body font-medium text-white" style={{ opacity: 0.7 }}>
              SOC 荷电状态
            </Text>
            <View className="flex-row items-baseline gap-1 mt-1">
              <Text className="font-headline text-4xl font-bold text-positive">—</Text>
              <Text className="font-headline text-lg font-semibold text-white">%</Text>
            </View>
            <View className="mt-3 w-52">
              <View className="h-2 w-full rounded-full bg-inset overflow-hidden">
                <View className="h-full rounded-full bg-primary-container w-0" />
              </View>
              <View className="flex-row justify-between mt-1">
                <Text className="text-[10px] font-headline text-white" style={{ opacity: 0.5 }}>
                  0
                </Text>
                <Text className="text-[10px] font-headline text-white" style={{ opacity: 0.5 }}>
                  50
                </Text>
                <Text className="text-[10px] font-headline text-white" style={{ opacity: 0.5 }}>
                  100
                </Text>
              </View>
            </View>
          </View>
        </View>
      </Card>

      <Card>
        <SectionHeader title="状态清单" right={<HeaderIcon name="checklist" />} />
        <View className="gap-2.5">
          <View className="flex-row gap-2.5">
            <ReadoutCell label="整车闭锁" value={lockText(status)} />
            <ReadoutCell label="五门状态" value={doorsText(status)} />
          </View>
          <View className="flex-row gap-2.5">
            <ReadoutCell label="哨兵录像" value={sentinelText(status)} />
            <ReadoutCell label="远程启动只读" value={remoteStartText(status)} />
          </View>
        </View>
      </Card>

      <Card>
        <View className="flex-row items-center justify-between mb-3.5">
          <Text className="font-headline text-base font-semibold text-on-surface">账户信息</Text>
          <DotPill label="已登录" compact />
        </View>
        <View className="border-b border-hairline">
          <InfoRow label="车主昵称" value={vehicle.ownerInfo.nickName || '—'} />
        </View>
        <View className="border-b border-hairline">
          <InfoRow label="手机号" value={maskMobile(vehicle.ownerInfo.mobile)} />
        </View>
        <InfoRow
          label="令牌剩余"
          value={formatDuration(session.expiresAt - Date.now())}
        />
        <View className="mt-3.5">
          <ActionButton label="退出登录" icon="logout" onPress={onLogout} />
        </View>
      </Card>

      <Card>
        <SectionHeader title="车辆档案" right={<HeaderIcon name="badge" />} />
        <View className="gap-2.5">
          <View className="flex-row gap-2.5">
            <ReadoutCell label="车牌" value={vehicle.plateNo || '—'} />
            <ReadoutCell label="车型代码" value={vehicle.vehicleTypeCode || '—'} />
          </View>
          <View className="flex-row gap-2.5">
            <ReadoutCell label="VIN 车架号" value={vehicle.vin || '—'} />
            <ReadoutCell
              label="总里程"
              value={vehicle.totalMileage ? `${vehicle.totalMileage.toLocaleString()} km` : '— km'}
            />
          </View>
        </View>
        <View className="mt-4 pt-3.5 border-t border-hairline">
          <CapsTag text="已就绪能力" />
          <View className="flex-row flex-wrap gap-2 mt-2.5">
            {CAPABILITY_LABELS.map((label) => (
              <DotPill key={label} label={label} />
            ))}
          </View>
        </View>
      </Card>

      <Card>
        <SectionHeader title="通讯与遥测连接" right={<HeaderIcon name="hub" />} />
        <View className="border-b border-hairline">
          <InfoRow label="云端状态" value={linkText} />
        </View>
        <View className="border-b border-hairline">
          <InfoRow label="往返延迟" value={latencyMs === null ? '— ms' : `${latencyMs} ms`} />
        </View>
        <InfoRow
          label="MQTT 凭据剩余"
          value={
            mqttExpireAt === null
              ? '—'
              : formatDuration(Math.max(0, mqttExpireAt - Date.now()))
          }
        />
        <View className="mt-3.5">
          <ActionButton label="重新连接" icon="sync" onPress={onReconnect} />
        </View>
      </Card>

      <Card>
        <SectionHeader title="外观与主题" right={<HeaderIcon name="palette" />} />
        <View className="flex-row items-center p-1 rounded-full bg-inset">
          {THEME_OPTIONS.map((option) => (
            <ThemeSegment
              key={option.key}
              label={option.label}
              selected={theme === option.key}
              onPress={() => onThemeChange(option.key)}
            />
          ))}
        </View>
      </Card>

      <Card>
        <View className="flex-row items-center justify-between mb-3.5">
          <Text className="font-headline text-base font-semibold text-on-surface">关于客户端</Text>
          <DotPill label="已最新" compact />
        </View>
        <View className="flex-row items-center justify-between py-2">
          <View className="flex-col flex-shrink">
            <Text className="font-headline text-sm font-semibold text-on-surface">
              {versionName === '—' ? '版本号 —' : `版本号 ${versionName}`}
            </Text>
            <View className="mt-0.5">
              <CapsTag text="自研客户端 Releases" />
            </View>
          </View>
          <View className="w-8 h-8 rounded-full bg-inset items-center justify-center">
            <Text className="text-lg font-icon text-positive">{Icon.verified_user}</Text>
          </View>
        </View>
        <View className="mt-3">
          <ActionButton
            label="检查更新"
            icon="sync"
            busy={update.kind === 'checking'}
            disabled={update.kind === 'checking' || update.kind === 'downloading'}
            onPress={onCheckUpdate}
          />
        </View>
        {renderUpdateBody(update, onCheckUpdate, onDownload)}
      </Card>
    </ScreenScroll>
  );
}

function HeaderIcon({ name }: { name: IconName }) {
  return (
    <View className="w-7 h-7 rounded-full bg-inset items-center justify-center">
      <Text className="text-[17px] font-icon text-on-surface">{Icon[name]}</Text>
    </View>
  );
}

function DotPill({ label, compact }: { label: string; compact?: boolean }) {
  const dot = <DotTag label={label} value="" dotClass="bg-positive" valueClass="text-positive" />;
  return compact ? (
    <View className="flex-row items-center rounded-full bg-inset px-2.5 py-0.5">{dot}</View>
  ) : (
    <View className="rounded-full bg-inset px-3 py-1.5">{dot}</View>
  );
}

function ActionButton({
  label,
  icon,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="w-full flex-row items-center justify-center gap-2 py-3 rounded-full bg-primary-container active:scale-95"
      style={disabled ? { opacity: 0.5 } : undefined}>
      {busy ? (
        <SpinnerIcon size={18} className="text-on-primary-fixed" />
      ) : (
        <Text className="text-lg font-icon text-on-primary-fixed">{Icon[icon]}</Text>
      )}
      <Text className="text-sm font-headline font-semibold text-on-primary-fixed">{label}</Text>
    </Pressable>
  );
}

function ThemeSegment({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} className="flex-1">
      {selected ? (
        <View className="py-2 rounded-full bg-surface-container-lowest items-center">
          <Text className="text-xs font-headline font-semibold text-on-surface">{label}</Text>
        </View>
      ) : (
        <View className="py-2 rounded-full items-center">
          <Text className="text-xs font-headline font-semibold text-on-surface-variant">
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function lockText(status: VehicleStatus | null): string {
  const lock = status?.instant?.door?.driver_door_lock_st;
  return lock === undefined ? '—' : lock === 1 ? '已闭锁' : '已解锁';
}

function doorsText(status: VehicleStatus | null): string {
  const door = status?.instant?.door;
  if (!door) return '—';
  const ajar = [
    door.driver_door_ajar_st,
    door.passenger_door_ajar_st,
    door.rear_left_door_ajar_st,
    door.rear_right_door_ajar_st,
    door.trunk_ajar_st,
  ];
  if (ajar.some((v) => typeof v !== 'number')) return '—';
  const open = ajar.filter((v) => v !== 0).length;
  return open === 0 ? '全闭合' : `${open} 处未关`;
}

function sentinelText(status: VehicleStatus | null): string {
  const enabled = status?.instant?.ext?.sentinel_mode_video_enable;
  return enabled === undefined ? '—' : enabled === 1 ? '已启用' : '已关闭';
}

function remoteStartText(status: VehicleStatus | null): string {
  const running = status?.instant?.power?.remote_start_status;
  return running === undefined ? '—' : running === 1 ? '运行中' : '未启动';
}

function renderUpdateBody(update: UpdateState, onCheck: () => void, onDownload: () => void) {
  if (update.kind === 'idle' || update.kind === 'checking') return null;

  if (update.kind === 'current') {
    return (
      <View className="mt-2.5">
        <StatusStrip label="已是最新版本" value={`v${update.version}`} />
      </View>
    );
  }

  if (update.kind === 'failed') {
    return (
      <View className="mt-2.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-[14px] font-icon text-error">{Icon.gpp_bad}</Text>
          <Text className="flex-1 text-xs text-error" numberOfLines={3}>
            {update.message}
          </Text>
        </View>
        <View className="mt-2">
          <PrimaryButton label="重试" tone="outline" icon="refresh" onPress={onCheck} />
        </View>
      </View>
    );
  }

  if (update.kind === 'downloading') {
    const pct =
      update.total > 0 ? Math.min(100, Math.round((update.done / update.total) * 100)) : null;
    return (
      <View className="mt-2.5">
        <View className="flex-row items-center justify-between">
          <Text className="text-xs font-headline font-bold text-on-surface">
            正在下载 v{update.release.version}
          </Text>
          <Text className="font-mono text-xs text-on-surface-variant">
            {pct === null ? formatBytes(update.done) : `${pct}%`}
          </Text>
        </View>
        <View className="mt-1.5 h-1.5 rounded-full bg-inset overflow-hidden">
          <View
            className="h-full bg-primary-container rounded-full"
            style={{ width: pct === null ? '30%' : `${pct}%` }}
          />
        </View>
        <Text className="mt-1 text-[11px] text-outline font-mono">
          {pct === null
            ? formatBytes(update.done)
            : `${formatBytes(update.done)} / ${formatBytes(update.total)}`}
        </Text>
      </View>
    );
  }

  if (update.kind === 'installing') {
    return (
      <View className="mt-2.5 flex-row items-center gap-1.5">
        <SpinnerIcon size={14} className="text-secondary" />
        <Text className="text-xs text-on-surface-variant">正在唤起系统安装器…</Text>
      </View>
    );
  }

  const { release, asset } = update;
  return (
    <View className="mt-2.5">
      <View className="flex-row items-center gap-1.5">
        <Text className="text-[14px] font-icon text-primary">{Icon.vertical_align_bottom}</Text>
        <Text className="text-xs font-headline font-bold text-on-surface">
          发现新版本 v{release.version}
        </Text>
        <Text className="text-[11px] font-mono text-outline">{asset.name}</Text>
      </View>
      {release.notes ? (
        <Text className="mt-1 text-[11px] text-on-surface-variant leading-relaxed" numberOfLines={4}>
          {release.notes}
        </Text>
      ) : null}
      <View className="mt-2">
        <PrimaryButton label="下载并安装" icon="vertical_align_bottom" onPress={onDownload} />
      </View>
    </View>
  );
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function maskMobile(mobile: string): string {
  if (!mobile || mobile.length < 11) return mobile || '—';
  return `${mobile.slice(0, 3)}******${mobile.slice(-2)}`;
}

function formatDuration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return '不足 1 分';
  if (min < 60) return `${min} 分`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}
