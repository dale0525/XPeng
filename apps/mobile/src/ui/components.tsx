import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { glowStyle, insetWell, plateShadow } from './atoms';
import { Icon, type IconName } from './icons';

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  if (className) {
    // 外部传了 className 时不能在里层再写死 `bg-surface`：里层会把外层的底色整个盖住，
    // 于是 `bg-ink` 这类深色卡片渲染成白底，上面白色大字（电量数字）就看不见了。
    // 底色与圆角/描边交给调用方，里层只保留裁切。
    return (
      <View className={className} style={plateShadow}>
        {padded ? (
          <View className="rounded-card overflow-hidden p-5">
            {children}
          </View>
        ) : (
          <View className="rounded-card overflow-hidden">
            {children}
          </View>
        )}
      </View>
    );
  }
  return padded ? (
    <View
      className="bg-surface rounded-card border border-hairline overflow-hidden p-3.5"
      style={plateShadow}>
      {children}
    </View>
  ) : (
    <View
      className="bg-surface rounded-card border border-hairline overflow-hidden"
      style={plateShadow}>
      {children}
    </View>
  );
}

export function SectionHeader({
  title,
  accent = 'primary',
  right,
  icon,
}: {
  title: string;
  accent?: 'primary' | 'secondary' | 'tertiary';
  right?: ReactNode;
  icon?: IconName;
}) {
  return (
    <View className="flex-row items-center justify-between mb-2.5">
      <View className="flex-row items-center gap-1.5">
        {icon ? (
          <View className="w-7 h-7 rounded-full bg-inset items-center justify-center">
            {/* 设计稿分区图标 20px、用次要文字色，不是主题主色。 */}
            <Text className="text-[20px] font-icon text-on-surface-variant">{Icon[icon]}</Text>
          </View>
        ) : accent === 'secondary' ? (
          <View className="w-1.5 h-3.5 rounded-full bg-secondary" />
        ) : accent === 'tertiary' ? (
          <View className="w-1.5 h-3.5 rounded-full bg-tertiary" />
        ) : (
          <View className="w-1.5 h-3.5 rounded-full bg-primary" />
        )}
        {/* 设计稿分区标题为 16px（text-[16px] font-semibold），不是 headline-sm(20px)。 */}
        <Text className="font-headline text-[16px] font-semibold text-on-surface">{title}</Text>
      </View>
      {right}
    </View>
  );
}

export function CapsTag({ text }: { text: string }) {
  return <Text className="font-label text-label-mono text-on-surface-variant">{text}</Text>;
}

export function InfoRow({
  label,
  value,
  valueClass = 'text-on-surface',
  small,
}: {
  label: string;
  value: string;
  valueClass?: string;
  small?: boolean;
}) {
  // 设计稿信息行：14px，行间距靠 pt-3 分隔；标签次要色、值加粗。
  return (
    <View className="flex-row justify-between items-center pt-3">
      {small ? (
        <Text className="text-[12px] font-body text-on-surface-variant">{label}</Text>
      ) : (
        <Text className="text-[14px] font-body text-on-surface-variant">{label}</Text>
      )}
      {small ? (
        <Text className="text-[12px] font-label font-semibold">
          <Text className={valueClass}>{value}</Text>
        </Text>
      ) : (
        <Text className="text-[14px] font-label font-semibold">
          <Text className={valueClass}>{value}</Text>
        </Text>
      )}
    </View>
  );
}

export type CommandVisualState = 'idle' | 'primary' | 'pending' | 'success' | 'failed' | 'unconfirmed' | 'disabled';

type FaceKey = 'on-primary' | 'primary' | 'secondary' | 'tertiary' | 'success' | 'error' | 'variant';

function faceKeyFor(
  state: CommandVisualState,
  variant: 'solid' | 'soft' | 'tile',
  tint?: 'primary' | 'secondary' | 'tertiary',
): FaceKey {
  if (state === 'primary' || (variant === 'solid' && state === 'idle')) return 'on-primary';
  if (state === 'pending' || state === 'unconfirmed') return 'secondary';
  if (state === 'success') return 'success';
  if (state === 'failed') return 'error';
  if (tint === 'primary') return 'primary';
  if (tint === 'secondary') return 'secondary';
  if (tint === 'tertiary') return 'tertiary';
  return 'variant';
}

function CommandFace({
  glyph,
  label,
  face,
  tile,
}: {
  glyph: string;
  label: string;
  face: FaceKey;
  tile: boolean;
}) {
  const iconSize = tile ? 16 : 18;
  // 设计稿里这类胶囊按钮文字是 text-xs(12px) semibold；原来非 tile 给 15px，视觉上明显偏大。
  const textSize = tile ? 11 : 12;
  switch (face) {
    case 'on-primary':
      return (
        <>
          <Text className="font-icon text-on-primary" style={{ fontSize: iconSize }}>
            {glyph}
          </Text>
          <Text className="font-label font-bold text-on-primary mt-0.5" style={{ fontSize: textSize }}>
            {label}
          </Text>
        </>
      );
    case 'primary':
      return (
        <>
          <Text className="font-icon text-primary" style={{ fontSize: iconSize }}>
            {glyph}
          </Text>
          <Text className="font-label font-bold text-primary mt-0.5" style={{ fontSize: textSize }}>
            {label}
          </Text>
        </>
      );
    case 'secondary':
      return (
        <>
          <Text className="font-icon text-secondary" style={{ fontSize: iconSize }}>
            {glyph}
          </Text>
          <Text className="font-label font-bold text-secondary mt-0.5" style={{ fontSize: textSize }}>
            {label}
          </Text>
        </>
      );
    case 'tertiary':
      return (
        <>
          <Text className="font-icon text-tertiary" style={{ fontSize: iconSize }}>
            {glyph}
          </Text>
          <Text className="font-label font-bold text-tertiary mt-0.5" style={{ fontSize: textSize }}>
            {label}
          </Text>
        </>
      );
    case 'success':
      return (
        <>
          <Text className="font-icon text-success" style={{ fontSize: iconSize }}>
            {glyph}
          </Text>
          <Text className="font-label font-bold text-success mt-0.5" style={{ fontSize: textSize }}>
            {label}
          </Text>
        </>
      );
    case 'error':
      return (
        <>
          <Text className="font-icon text-error" style={{ fontSize: iconSize }}>
            {glyph}
          </Text>
          <Text className="font-label font-bold text-error mt-0.5" style={{ fontSize: textSize }}>
            {label}
          </Text>
        </>
      );
    default:
      return (
        <>
          <Text className="font-icon text-on-surface-variant" style={{ fontSize: iconSize }}>
            {glyph}
          </Text>
          <Text className="font-label font-bold text-on-surface mt-0.5" style={{ fontSize: textSize }}>
            {label}
          </Text>
        </>
      );
  }
}

function CommandBackdrop({
  state,
  variant,
}: {
  state: CommandVisualState;
  variant: 'solid' | 'soft' | 'tile';
}) {
  switch (state) {
    case 'pending':
    case 'unconfirmed':
      return <View className="absolute inset-0 rounded-box bg-surface-container border-2 border-secondary" />;
    case 'success':
      return <View className="absolute inset-0 rounded-box bg-surface-container border-2 border-success" />;
    case 'failed':
      return <View className="absolute inset-0 rounded-box bg-error-container border-2 border-error" />;
    case 'primary':
      return <View className="absolute inset-0 rounded-box bg-primary border border-primary" />;
    case 'disabled':
      return <View className="absolute inset-0 rounded-box bg-surface-container border border-hairline" />;
    default:
      return variant === 'solid' ? (
        <View className="absolute inset-0 rounded-box bg-surface-tint border border-surface-tint" />
      ) : (
        <View className="absolute inset-0 rounded-box bg-surface-container border border-hairline" />
      );
  }
}

// `success` 仅表示客户端已收到指令响应，车端是否执行由 `unconfirmed` 表达。
export function CommandButton({
  icon,
  label,
  state = 'idle',
  onPress,
  variant = 'soft',
  tint,
  className = '',
}: {
  icon: IconName;
  label: string;
  state?: CommandVisualState;
  onPress?: () => void;
  variant?: 'solid' | 'soft' | 'tile';
  tint?: 'primary' | 'secondary' | 'tertiary';
  className?: string;
}) {
  const face = <CommandFace glyph={Icon[icon]} label={label} face={faceKeyFor(state, variant, tint)} tile={variant === 'tile'} />;
  const backdrop = <CommandBackdrop state={state} variant={variant} />;
  const disabled = state === 'pending' || state === 'disabled';
  const opacity = state === 'disabled' ? { opacity: 0.45 } : undefined;

  const button = variant === 'tile' ? (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="flex-1 flex-col items-center justify-center py-2 px-1 rounded-box overflow-hidden"
      style={opacity}>
      {backdrop}
      {face}
    </Pressable>
  ) : (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="flex-row items-center justify-center gap-2 py-3 px-3 rounded-box overflow-hidden"
      style={opacity}>
      {backdrop}
      {face}
    </Pressable>
  );

  return className ? <View className={className}>{button}</View> : button;
}

export function StatusStrip({
  label,
  value,
  valueClass = 'text-secondary',
  className = '',
}: {
  label: string;
  value: string;
  valueClass?: string;
  className?: string;
}) {
  const body = (
    <View className="flex-row items-center justify-between px-3 py-1.5 rounded-box bg-surface-container-low border border-hairline">
      <Text className="text-body-sm font-body text-on-surface-variant">{label}</Text>
      <Text className="text-body-sm font-label font-semibold">
        <Text className={valueClass}>{value}</Text>
      </Text>
    </View>
  );
  return className ? <View className={className}>{body}</View> : body;
}

export function ReadoutCell({
  label,
  value,
  sub,
  valueClass = 'text-on-surface',
  active,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  active?: boolean;
}) {
  const body = (
    <>
      {/* 设计稿只读数据格：标签 12px 次要色，数值 20px 粗体（font-num）。 */}
      <Text className="text-[12px] font-body text-on-surface-variant" numberOfLines={1}>
        {label}
      </Text>
      <Text className="text-[20px] font-label font-bold mt-0.5" numberOfLines={1}>
        <Text className={valueClass}>{value}</Text>
      </Text>
      {sub ? (
        <Text className="text-[9px] font-body text-on-surface-variant mt-0.5" numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </>
  );
  return active ? (
    <View className="flex-1 p-3.5 min-h-[76px] justify-between rounded-[22px] bg-surface-container-high border border-hairline">
      {body}
    </View>
  ) : (
    <View className="flex-1 p-3.5 min-h-[76px] justify-between rounded-[22px] bg-inset">
      {body}
    </View>
  );
}

export type TabKey = 'control' | 'status' | 'settings';

const TABS: Array<{ key: TabKey; label: string; icon: IconName }> = [
  { key: 'control', label: '车控', icon: 'tune' },
  { key: 'status', label: '状态', icon: 'speed' },
  { key: 'settings', label: '设置', icon: 'settings' },
];

export function BottomNav({
  active,
  onChange,
  insetBottom,
}: {
  active: TabKey;
  onChange: (k: TabKey) => void;
  insetBottom: number;
}) {
  return (
    /* 照稿子：nav 本身 `flex justify-around items-center py-2.5` 垂直居中每个入口。
       之前把安全区 inset 当成 nav 的 paddingBottom，多出来的底部内边距把按钮顶成偏上。
       安全区只应作用在 nav 之外的外层留白上，nav 内边距保持稿子的 py-2.5。 */
    <View
      className="absolute bottom-0 left-0 right-0"
      style={{ paddingBottom: Math.max(insetBottom, 8) }}>
      <View className="mx-4 mb-3 flex-row items-center justify-around rounded-full bg-inverse-surface px-4 py-2.5">
        {TABS.map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={t.label}
            className="items-center justify-center active:scale-95">
            {/* 设计稿：选中项是「图标+文字」整体包成一个胶囊（px-4 py-1.5 rounded-full），
                不是只把图标套个圆；图标 19px、文字 12px（text-xs）。 */}
            <View
              className={
                on
                  ? 'items-center justify-center rounded-full bg-primary-container px-4 py-1.5'
                  : 'items-center justify-center px-3 py-1.5'
              }>
              <Text
                className={
                  on
                    ? 'text-[19px] font-icon text-on-primary-fixed'
                    : 'text-[19px] font-icon text-surface-variant'
                }>
                {Icon[t.icon]}
              </Text>
              <Text
                className={
                  on
                    ? 'text-[12px] font-label font-bold text-on-primary-fixed mt-0.5'
                    : 'text-[12px] font-label font-medium text-surface-variant mt-0.5'
                }>
                {t.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
      </View>
    </View>
  );
}

export function Banner({
  text,
  tag,
  tone = 'info',
}: {
  text: string;
  tag?: string;
  tone?: 'info' | 'warn' | 'error';
}) {
  const glyph = tone === 'error' ? Icon.cancel : tone === 'warn' ? Icon.schedule : Icon.verified_user;
  const content = (
    <>
      <View className="flex-row items-center gap-2 flex-shrink">
        <Text className="text-[15px] font-icon text-on-surface">{glyph}</Text>
        <Text className="text-body-sm font-body font-medium text-on-surface flex-shrink">
          {text}
        </Text>
      </View>
      {tag ? (
        <View className="flex-row items-center gap-1.5">
          {tone === 'error' ? (
            <View className="w-1.5 h-1.5 rounded-full bg-error" />
          ) : tone === 'warn' ? (
            <View className="w-1.5 h-1.5 rounded-full bg-primary" />
          ) : (
            <View className="w-1.5 h-1.5 rounded-full bg-secondary" />
          )}
          <Text className="text-[10px] font-label font-bold text-on-surface">{tag}</Text>
        </View>
      ) : null}
    </>
  );

  if (tone === 'error') {
    return (
      <View className="mx-3.5 mt-2 rounded-card px-3 py-2 flex-row items-center justify-between bg-error-container">
        {content}
      </View>
    );
  }
  if (tone === 'warn') {
    return (
      <View className="mx-3.5 mt-2 rounded-card px-3 py-2 flex-row items-center justify-between bg-primary-container">
        {content}
      </View>
    );
  }
  return (
    <View className="mx-3.5 mt-2 rounded-card px-3 py-2 flex-row items-center justify-between bg-secondary-container">
      {content}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  tone = 'primary',
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'danger' | 'outline';
  icon?: IconName;
}) {
  const glyph = icon ? Icon[icon] : null;

  if (tone === 'danger') {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        className="w-full flex-row items-center justify-center gap-2 h-11 rounded-full bg-error-container border border-error active:scale-95"
        style={disabled ? { opacity: 0.4 } : undefined}>
        {glyph ? <Text className="text-[17px] font-icon text-error">{glyph}</Text> : null}
        <Text className="text-body-md font-headline font-bold text-error">{label}</Text>
      </Pressable>
    );
  }
  if (tone === 'outline') {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        className="w-full flex-row items-center justify-center gap-2 h-11 rounded-full bg-surface border border-secondary active:scale-95"
        style={disabled ? { opacity: 0.4 } : undefined}>
        {glyph ? <Text className="text-[17px] font-icon text-secondary">{glyph}</Text> : null}
        <Text className="text-body-md font-headline font-bold text-secondary">{label}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="w-full flex-row items-center justify-center gap-2 h-11 rounded-full bg-primary border border-primary active:scale-95"
      style={disabled ? { opacity: 0.4 } : undefined}>
      {glyph ? <Text className="text-[17px] font-icon text-on-primary">{glyph}</Text> : null}
      <Text className="text-body-md font-headline font-bold text-on-primary">{label}</Text>
    </Pressable>
  );
}


/**
 * 蓝牙指示点：只有真实 GATT 链路才算已连接（状态绿）；
 * 数字钥匙材料就绪但没建链路是中性描边色；未就绪时最淡。
 */
export type BluetoothState = 'connected' | 'ready' | 'off';

function BluetoothDot({ state }: { state: BluetoothState }) {
  const color = state === 'connected'
    ? 'bg-positive'
    : state === 'ready' ? 'bg-outline' : 'bg-surface-container-highest';
  return <View className={`w-1.5 h-1.5 rounded-full ${color}`} />;
}
const BLUETOOTH_LABEL: Record<BluetoothState, string> = {
  connected: '已连接',
  ready: '钥匙已就绪',
  off: '未连接',
};
export function TopBar({
  title,
  vehicleLabel,
  online,
  bluetoothState,
  onRefresh,
}: {
  title: string;
  vehicleLabel: string;
  online: boolean;
  bluetoothState: BluetoothState;
  onRefresh: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between px-5 py-3 bg-background">
      <View className="flex-row items-center gap-2.5 flex-shrink">
        <View className="w-10 h-10 rounded-full bg-surface-container-lowest items-center justify-center">
          <Text className="text-[20px] font-icon text-on-surface">{Icon.directions_car}</Text>
        </View>
        <View className="flex-col flex-shrink">
          <View className="flex-row items-center gap-2">
            <Text
              className="text-base font-headline font-bold text-on-surface tracking-tight"
              numberOfLines={1}>
              {title}
            </Text>
            <Text
              className="text-xs font-body font-medium text-on-surface-variant"
              numberOfLines={1}>
              {vehicleLabel || '—'}
            </Text>
          </View>
          <View className="flex-row items-center gap-2 mt-0.5">
            {online ? (
              <View className="flex-row items-center gap-1">
                <View className="w-1.5 h-1.5 rounded-full bg-positive" />
                <Text className="text-[11px] font-body font-medium text-on-surface-variant">
                  在线联机
                </Text>
              </View>
            ) : (
              <View className="flex-row items-center gap-1">
                <View className="w-1.5 h-1.5 rounded-full bg-outline" />
                <Text className="text-[11px] font-body font-medium text-on-surface-variant">
                  离线
                </Text>
              </View>
            )}
            <Text className="text-xs text-surface-dim">•</Text>
            <View className="flex-row items-center gap-1">
              <Text className="text-[13px] font-icon text-on-surface-variant">
                {Icon.bluetooth}
              </Text>
              <BluetoothDot state={bluetoothState} />
              <Text className="text-[11px] font-body font-medium text-on-surface-variant">
                {BLUETOOTH_LABEL[bluetoothState]}
              </Text>
            </View>
          </View>
        </View>
      </View>
      <Pressable
        onPress={onRefresh}
        accessibilityLabel="刷新状态"
        className="w-10 h-10 rounded-full bg-surface-container-lowest items-center justify-center active:scale-95">
        <Text className="text-[20px] font-icon text-on-surface">{Icon.refresh}</Text>
      </Pressable>
    </View>
  );
}

export function ScreenScroll({
  children,
  bottomInset = 108,
}: {
  children: ReactNode;
  bottomInset?: number;
}) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-4 pt-2.5 gap-4"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  );
}

export { insetWell, plateShadow, glowStyle };
