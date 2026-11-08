import type * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import type { LinkState } from '../../core/car';
import type { SessionState } from '../../core/session';
import type { ThemeMode } from '../../core/theme';
import type { UpdateState } from '../../core/update';
import { Card, PrimaryButton, ScreenScroll, StatusStrip } from '../components';
import { SpinnerIcon } from '../atoms';
import { Icon, type IconName } from '../icons';

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

  /** SOC 进度条必须跟真实电量走；拿不到时停在 0 而不是假装半满。 */
  const socPct = (() => {
    const v = status?.instant.charge?.battery_soc;
    return typeof v === 'number' && v >= 0 && v <= 100 ? v : 0;
  })();

  const socValue = status?.instant.charge?.battery_soc;

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
      {/* 2. 副标题 + 车辆胶囊行 */}
      <View className="px-1 gap-2">
        <Text className="text-[13px] font-body font-normal text-on-surface-variant leading-snug">
          自研车控节点设置与车辆参数面板
        </Text>
        <View className="flex-row items-center justify-between pt-1">
          <View className="h-[26px] px-3 rounded-full bg-surface border border-hairline flex-row items-center gap-1.5">
            <View className="w-1.5 h-1.5 rounded-full bg-primary-container" />
            <Text className="text-[12px] font-semibold font-headline text-on-surface">
              {`车辆 ${vehicle.vehicleTypeName || '—'}`}
            </Text>
          </View>
          <View className="px-2.5 py-[3px] rounded-full bg-surface border border-hairline flex-row items-center gap-1.5">
            <View className="w-1.5 h-1.5 rounded-full bg-positive" />
            <Text className="text-[12px] font-body font-medium text-on-surface-variant">已同步</Text>
          </View>
        </View>
      </View>

      {/* 3. SOC 荷电状态（只读） */}
      <SettingsCard className="p-5 gap-4">
        <View className="flex-row items-center justify-between">
          <Text className="text-[14px] font-body font-semibold text-on-surface">SOC 荷电状态</Text>
          <Text className="text-[26px] font-headline font-semibold text-on-surface tracking-tight">
            {socValue === undefined ? '— %' : `${socValue} %`}
          </Text>
        </View>
        <View className="w-full gap-2">
          <View className="w-full h-2 rounded-full bg-inset relative flex-row items-center">
            <View className="h-full rounded-full bg-primary-container" style={{ width: `${socPct}%` }} />
            <View
              className="absolute rounded-full bg-primary-container border border-primary-fixed-dim"
              style={{ width: 18, height: 18, left: `${socPct}%`, marginLeft: -9, top: -5 }}
            />
          </View>
          <View className="w-full flex-row justify-between px-0.5">
            <Text className="text-[11px] font-headline font-medium text-on-surface-variant">0</Text>
            <Text className="text-[11px] font-headline font-medium text-on-surface-variant">50</Text>
            <Text className="text-[11px] font-headline font-medium text-on-surface-variant">100</Text>
          </View>
        </View>
      </SettingsCard>

      {/* 4. 状态清单 */}
      <SettingsCard className="p-5 gap-[14px]">
        <CardHeader icon="checklist" title="状态清单" />
        <RowList
          rows={[
            { label: '整车闭锁', value: lockText(status) },
            { label: '五门状态', value: doorsText(status) },
            { label: '哨兵录像', value: sentinelText(status) },
            { label: '远程启动只读', value: remoteStartText(status) },
          ]}
        />
      </SettingsCard>

      {/* 5. 账户信息 */}
      <SettingsCard className="p-5 gap-[14px]">
        <CardHeader icon="badge" title="账户信息" right={<StatusPill label="已登录" />} />
        <RowList
          rows={[
            { label: '车主昵称', value: vehicle.ownerInfo?.nickName || '—' },
            { label: '手机号', value: vehicle.ownerInfo?.mobile ? maskMobile(vehicle.ownerInfo.mobile) : '—' },
            { label: '令牌剩余', value: formatDuration(session.expiresAt - Date.now()) },
          ]}
        />
        <AxisButton label="退出登录" icon="logout" onPress={onLogout} />
      </SettingsCard>

      {/* 6. 车辆档案 */}
      <SettingsCard className="p-5 gap-[14px]">
        <CardHeader icon="directions_car" title="车辆档案" />
        <RowList
          rows={[
            { label: '车牌', value: vehicle.plateNo || '—' },
            { label: '车型代码', value: vehicle.vehicleTypeCode || '—' },
            { label: 'VIN 车架号', value: vehicle.vin || '—' },
            {
              label: '总里程',
              value: vehicle.totalMileage ? `${vehicle.totalMileage.toLocaleString()} km` : '— km',
            },
          ]}
        />
      </SettingsCard>

      {/* 7. 已就绪能力 */}
      <SettingsCard className="p-5 gap-[14px]">
        <CardHeader icon="check_circle" title="已就绪能力" />
        <CapabilityList labels={CAPABILITY_LABELS} />
      </SettingsCard>

      {/* 8. 通讯与遥测连接 */}
      <SettingsCard className="p-5 gap-[14px]">
        <CardHeader icon="hub" title="通讯与遥测连接" />
        <RowList
          rows={[
            { label: '云端状态', value: linkText },
            { label: '往返延迟', value: latencyMs === null ? '— ms' : `${latencyMs} ms` },
            {
              label: 'MQTT 凭据剩余',
              value:
                mqttExpireAt === null
                  ? '—'
                  : formatDuration(Math.max(0, mqttExpireAt - Date.now())),
            },
          ]}
        />
        <AxisButton label="重新连接" icon="sync" onPress={onReconnect} />
      </SettingsCard>

      {/* 9. 外观与主题 */}
      <SettingsCard className="p-5 gap-[14px]">
        <CardHeader icon="palette" title="外观与主题" />
        <View className="flex-row gap-2 mt-1">
          {THEME_OPTIONS.map((option) => (
            <ThemePill
              key={option.key}
              label={option.label}
              selected={theme === option.key}
              onPress={() => onThemeChange(option.key)}
            />
          ))}
        </View>
      </SettingsCard>

      {/* 10. 关于客户端 */}
      <SettingsCard className="p-5 gap-[14px]">
        <CardHeader icon="info" title="关于客户端" right={<StatusPill label="已最新" />} />
        <View className="w-full py-1">
          <View className="flex-row items-center justify-between">
            <Text className="text-[14px] font-body font-semibold text-on-surface">
              {`版本号 ${versionName === '—' ? '—' : versionName}`}
            </Text>
            <Text className="text-[16px] font-icon text-positive">{Icon.verified_user}</Text>
          </View>
          <Text className="text-[12px] font-headline font-normal text-on-surface-variant mt-[3px]">
            自研客户端 Releases
          </Text>
        </View>
        <AxisButton
          label="检查更新"
          icon="sync"
          busy={update.kind === 'checking'}
          disabled={update.kind === 'checking' || update.kind === 'downloading'}
          onPress={onCheckUpdate}
        />
        {renderUpdateBody(update, onCheckUpdate, onDownload)}
      </SettingsCard>
    </ScreenScroll>
  );
}

/** 设计稿卡片：白底 / 28px 圆角 / 1px hairline 描边，内边距 20px。 */
function SettingsCard({
  children,
  className = 'p-5 gap-[14px]',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card padded={false}>
      <View className={className}>{children}</View>
    </Card>
  );
}

/** 卡片标题栏：左侧 16px 图标 + 14px semibold 标题，可选右侧胶囊。 */
function CardHeader({
  icon,
  title,
  right,
}: {
  icon: IconName;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <View className="flex-row items-center gap-2">
        <Text className="text-[16px] font-icon text-on-surface">{Icon[icon]}</Text>
        <Text className="text-[14px] font-headline font-semibold text-on-surface">{title}</Text>
      </View>
      {right}
    </View>
  );
}

/** 只读信息行：14px 标签次要色、值加粗，行间一条 hairline。 */
function RowList({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <View>
      {rows.map((row, index) => (
        <View key={row.label}>
          <View className="flex-row items-center justify-between py-3">
            <Text className="text-[14px] font-body font-normal text-on-surface-variant">{row.label}</Text>
            <Text className="text-[14px] font-headline font-medium text-on-surface">{row.value}</Text>
          </View>
          {index < rows.length - 1 ? <View className="h-px bg-hairline" /> : null}
        </View>
      ))}
    </View>
  );
}

/** 已就绪能力清单：每项绿色对勾 + 名称，右侧「就绪」。 */
function CapabilityList({ labels }: { labels: string[] }) {
  return (
    <View>
      {labels.map((label, index) => (
        <View key={label}>
          <View className="flex-row items-center justify-between py-3">
            <View className="flex-row items-center gap-2.5">
              <Text className="text-[18px] font-icon text-positive">{Icon.check}</Text>
              <Text className="text-[14px] font-body font-medium text-on-surface">{label}</Text>
            </View>
            <Text className="text-[12px] font-body font-medium text-positive">就绪</Text>
          </View>
          {index < labels.length - 1 ? <View className="h-px bg-hairline" /> : null}
        </View>
      ))}
    </View>
  );
}

/** 小号状态胶囊：绿点 + 灰字。 */
function StatusPill({ label }: { label: string }) {
  return (
    <View className="flex-row items-center gap-1 px-2.5 py-1 rounded-full bg-inset border border-hairline">
      <View className="w-[5px] h-[5px] rounded-full bg-positive" />
      <Text className="text-[11px] font-body font-medium text-on-surface-variant">{label}</Text>
    </View>
  );
}

/** 浅灰底胶囊按钮：近黑字，用于退出登录 / 重新连接 / 检查更新。 */
function AxisButton({
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
      className="w-full h-[46px] flex-row items-center justify-center gap-[6px] rounded-full bg-inset border border-hairline active:scale-95"
      style={disabled ? { opacity: 0.5 } : undefined}>
      {busy ? (
        <SpinnerIcon size={16} className="text-on-surface" />
      ) : (
        <Text className="text-[16px] font-icon text-on-surface">{Icon[icon]}</Text>
      )}
      <Text className="text-[14px] font-headline font-semibold text-on-surface">{label}</Text>
    </Pressable>
  );
}

/** 主题段：选中态黄底近黑字，未选中态浅灰底灰字。 */
function ThemePill({
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
        <View className="h-[42px] rounded-full bg-primary-container items-center justify-center">
          <Text className="text-[13px] font-headline font-semibold text-ink">{label}</Text>
        </View>
      ) : (
        <View className="h-[42px] rounded-full bg-inset border border-hairline items-center justify-center">
          <Text className="text-[13px] font-headline font-medium text-on-surface-variant">{label}</Text>
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
