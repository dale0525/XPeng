/**
 * 设置页（对应 `docs/design/settings-light.html` / `settings-dark.html`）。
 *
 * 五张卡片照抄设计稿：账户、车辆、连接、外观、关于。车型能力徽章来自
 * `vehicle.function`（服务端下发的布尔位），不硬编码——换车型时自动跟着变。
 */
import { Pressable, Text, View } from 'react-native';
import type { Session } from '@xpeng/protocol/src/session';
import type { Vehicle } from '@xpeng/protocol/src/vehicles';
import { Card, InfoRow, PrimaryButton, ScreenScroll } from '../components';
import type { ThemeMode } from '../../core/theme';
import type { UpdateState } from '../../core/update';
import { Icon } from '../icons';

/** 能力位 → 中文名。只列本项目实际会用到的几项。 */
const CAPABILITIES: Array<{ key: string; label: string }> = [
  { key: 'remoteControl', label: '远程车控' },
  { key: 'sentinelMode', label: '哨兵模式' },
  { key: 'tpms', label: '胎压监测' },
  { key: 'sunShade', label: '遮阳帘' },
  { key: 'bluetoothKey', label: '蓝牙钥匙' },
];

export function SettingsScreen({
  session,
  vehicle,
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
  bottomInset,
}: {
  session: Session;
  vehicle: Vehicle;
  linkState: string;
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
  bottomInset: number;
}) {
  const caps = CAPABILITIES.filter((c) => vehicle.function[c.key] !== false);
  const mqttLeft = mqttExpireAt === null ? null : Math.max(0, mqttExpireAt - Date.now());

  return (
    <ScreenScroll bottomInset={bottomInset}>
      {/* 1. 账户 */}
      <Card className="relative overflow-hidden">
        <View className="absolute top-0 left-0 w-1.5 h-full bg-primary" />
        <View className="pl-1.5">
          <View className="flex-row items-start justify-between">
            <View>
              <View className="flex-row items-center gap-2">
                <Text className="font-headline font-bold text-lg text-on-surface">
                  {vehicle.ownerInfo.nickName || '车主'}
                </Text>
                <View className="bg-primary px-2 py-0.5 rounded-sm">
                  <Text className="text-[10px] font-headline font-extrabold text-on-primary">
                    车主
                  </Text>
                </View>
              </View>
              <Text className="font-mono text-xs text-on-surface-variant font-medium tracking-wide mt-1">
                {maskMobile(vehicle.ownerInfo.mobile)}
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5 bg-surface-container-low px-2.5 py-1 rounded-full border border-outline-variant/40">
              <View className="w-2 h-2 rounded-full bg-success" />
              <Text className="text-xs font-medium text-success">已登录</Text>
            </View>
          </View>

          <View className="mt-4 pt-3 border-t border-outline-variant/20 flex-row items-center justify-between">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-[16px] font-icon text-outline">{Icon.schedule}</Text>
              <Text className="font-mono text-xs text-on-surface-variant">
                剩余 {formatDuration(session.issuedAt + 9000_000 - Date.now())}
              </Text>
            </View>
            <Pressable
              onPress={onLogout}
              className="px-3 py-1.5 bg-surface-container-high rounded-sm active:scale-95">
              <Text className="text-xs font-headline font-bold text-on-surface">退出登录</Text>
            </Pressable>
          </View>
        </View>
      </Card>

      {/* 2. 车辆 */}
      <Card className="relative overflow-hidden">
        <View className="absolute top-0 left-0 w-1.5 h-full bg-secondary" />
        <View className="pl-1.5">
          <View className="flex-row items-baseline justify-between">
            <View className="flex-row items-center gap-2">
              <Text className="font-headline font-extrabold text-xl text-on-surface tracking-tight">
                {vehicle.plateNo}
              </Text>
              <View className="px-2 py-0.5 bg-surface-container rounded-sm border border-secondary/30">
                <Text className="font-headline font-bold text-xs text-secondary">
                  {vehicle.vehicleTypeCode || vehicle.vehicleTypeName}
                </Text>
              </View>
            </View>
            <Text className="text-[11px] font-mono text-outline font-medium">
              {vehicle.vehicleTypeName}
            </Text>
          </View>

          <View className="mt-3 bg-surface-container-low p-2.5 rounded-lg border border-outline-variant/30">
            <InfoRow label="VIN" value={vehicle.vin} />
            <InfoRow
              label="总里程"
              value={`${vehicle.totalMileage.toLocaleString()} 公里`}
              valueClass="text-secondary"
            />
          </View>

          <View className="mt-3 flex-row flex-wrap gap-1.5">
            {caps.map((c) => (
              <View
                key={c.key}
                className="px-2 py-1 bg-surface-container rounded border border-outline-variant/30">
                <Text className="text-[11px] font-medium text-on-surface-variant">{c.label}</Text>
              </View>
            ))}
          </View>
        </View>
      </Card>

      {/* 3. 连接 */}
      <Card>
        <View className="flex-row items-center justify-between mb-3">
          <View className="flex-row items-center gap-2">
            <View
              className={`w-2.5 h-2.5 rounded-full ${
                linkState === 'online' ? 'bg-success' : 'bg-outline'
              }`}
            />
            <Text className="font-headline font-bold text-sm text-on-surface tracking-tight">
              云端连接：
              {linkState === 'online' ? '已连接' : linkState === 'connecting' ? '连接中' : '未连接'}
            </Text>
          </View>
          <View className="px-2 py-0.5 rounded bg-success/10">
            <Text className="font-mono text-xs font-bold text-success">
              {latencyMs === null ? '— ms' : `${latencyMs} ms`}
            </Text>
          </View>
        </View>
        <View className="bg-surface-container-low rounded-lg p-3 border border-outline-variant/30 flex-row items-center justify-between">
          <View>
            <Text className="text-[11px] text-outline font-medium">MQTT 凭据到期时间</Text>
            <Text className="font-mono text-xs font-bold text-on-surface mt-0.5">
              {mqttLeft === null ? '未签发' : `剩余 ${formatDuration(mqttLeft)}`}
            </Text>
          </View>
          <Pressable
            onPress={onReconnect}
            className="px-3 py-1.5 bg-secondary rounded active:scale-95">
            <Text className="text-white font-headline font-bold text-xs">重新连接</Text>
          </Pressable>
        </View>
      </Card>

      {/* 4. 外观 */}
      <Card>
        <View className="flex-row items-center justify-between mb-3">
          <Text className="font-headline font-bold text-sm text-on-surface tracking-tight">外观</Text>
          <Text className="text-[11px] text-outline font-mono">THEME</Text>
        </View>
        <View className="flex-row p-1 bg-surface-container rounded-lg border border-outline-variant/40 gap-1">
          {(
            [
              ['system', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ] as const
          ).map(([key, label]) => {
            const on = theme === key;
            return (
              <Pressable
                key={key}
                onPress={() => onThemeChange(key)}
                className={`flex-1 py-2 items-center rounded ${
                  on ? 'bg-surface border border-outline-variant/30' : ''
                }`}>
                <Text
                  className={`text-xs font-headline font-bold ${
                    on ? 'text-secondary' : 'text-on-surface-variant'
                  }`}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      {/* 5. 关于 */}
      <Card>
        <View className="flex-row items-center justify-between">
          <Text className="font-headline font-bold text-sm text-on-surface tracking-tight">关于</Text>
          <Pressable
            onPress={onCheckUpdate}
            disabled={update.kind === 'checking' || update.kind === 'downloading'}
            className="px-2 py-0.5 bg-surface-container-high rounded border border-outline-variant/40 active:scale-95">
            <Text className="font-mono text-xs font-bold text-on-surface-variant">
              {update.kind === 'checking' ? '检查中…' : `v${versionName}`}
            </Text>
          </Pressable>
        </View>

        {renderUpdateBody(update, onCheckUpdate, onDownload)}

        <Text className="mt-2.5 text-xs text-on-surface-variant leading-relaxed">
          登录一次后自动续期，续期失败时会提示重新登录
        </Text>
      </Card>
    </ScreenScroll>
  );
}

/**
 * 关于卡片里随更新状态变化的那一块。四种状态各给一行结果 + 一个动作：
 * 检查中/已最新/有新版（下载按钮）/下载中（进度条）/失败（原因 + 重试）。
 */
function renderUpdateBody(update: UpdateState, onCheck: () => void, onDownload: () => void) {
  if (update.kind === 'idle' || update.kind === 'checking') return null;

  if (update.kind === 'current') {
    return (
      <View className="mt-2.5 flex-row items-center gap-1.5">
        <Text className="text-[14px] font-icon text-success">{Icon.check_circle}</Text>
        <Text className="text-xs text-on-surface-variant">已是最新版本 v{update.version}</Text>
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
        <View className="mt-1.5 h-1.5 rounded-full bg-surface-container-high overflow-hidden">
          <View
            className="h-full bg-primary rounded-full"
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
        <Text className="text-[14px] font-icon text-secondary">{Icon.sync}</Text>
        <Text className="text-xs text-on-surface-variant">正在唤起系统安装器…</Text>
      </View>
    );
  }

  // available
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
