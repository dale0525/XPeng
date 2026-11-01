/**
 * 设计稿里的共享组件，名字与 `docs/design/*.html` 的区块一一对应。
 *
 * 全部用 Tailwind 语义类，不写色值：色值只在 `tailwind.config.js` 与
 * `src/core/colors.ts` 里各出现一次，亮暗两套共用同一批 className。
 *
 * 视觉装饰（斜切、切角、内凹槽、发光）走 `atoms.tsx`，本文件只管结构与排布。
 */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { LiveDot, glowStyle, insetWell, plateShadow } from './atoms';
import { Icon, type IconName } from './icons';

/** 卡片：设计稿里 `.bg-surface rounded-xl border border-outline-variant/40` + 淡投影。 */
export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <View
      className={`bg-surface rounded-xl border border-outline-variant/40 ${
        padded ? 'p-3.5' : ''
      } ${className}`}
      style={plateShadow}>
      {children}
    </View>
  );
}

/**
 * 分组标题：左侧 1.5×3.5 主色短条 + 标题，右侧一行小字或徽章。
 * 短条颜色按设计稿分区：车门 primary、车窗 secondary、哨兵 tertiary。
 */
export function SectionHeader({
  title,
  accent = 'primary',
  right,
}: {
  title: string;
  accent?: 'primary' | 'secondary' | 'tertiary';
  right?: ReactNode;
}) {
  const bar = {
    primary: 'bg-primary',
    secondary: 'bg-secondary',
    tertiary: 'bg-tertiary',
  }[accent];
  return (
    <View className="flex-row items-center justify-between mb-2.5">
      <View className="flex-row items-center gap-1.5">
        <View className={`w-1.5 h-3.5 rounded-full ${bar}`} />
        <Text className="font-headline text-sm font-bold text-on-surface">{title}</Text>
      </View>
      {right}
    </View>
  );
}

/** 分组右上角的英文小标，例如 `DOOR SYSTEM`。 */
export function CapsTag({ text }: { text: string }) {
  return <Text className="text-[11px] font-mono text-on-surface-variant">{text}</Text>;
}

/** 只读键值行：左标签右数值，等宽数字。 */
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
  return (
    <View className="flex-row justify-between items-center py-1">
      <Text className={`text-on-surface-variant ${small ? 'text-[10px]' : 'text-[11px]'}`}>
        {label}
      </Text>
      <Text
        className={`font-mono ${small ? 'text-[10px]' : 'text-[11px]'} font-semibold ${valueClass}`}>
        {value}
      </Text>
    </View>
  );
}

export type CommandVisualState = 'idle' | 'primary' | 'pending' | 'success' | 'failed' | 'disabled';

/**
 * 车控按钮。设计稿里三种形态：
 * - `solid`：主操作实心（锁车、打开空调）；
 * - `soft`：浅底细描边（解锁车门、遮阳帘、闪灯）；
 * - `tile`：五等分小方砖（空调快捷操作）。
 * 下发中 / 成功 / 失败三态覆盖在形态之上，颜色仍取语义 token。
 */
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
  const shell =
    state === 'pending'
      ? 'bg-secondary-container/20 border-2 border-secondary'
      : state === 'success'
        ? 'bg-success/15 border-2 border-success'
        : state === 'failed'
          ? 'bg-error-container border-2 border-error'
          : state === 'primary'
            ? 'bg-primary border border-primary'
            : variant === 'solid'
              ? 'bg-surface-tint border border-surface-tint'
              : 'bg-surface-container border border-outline-variant/70';

  const iconTint =
    state === 'primary' || (variant === 'solid' && state === 'idle')
      ? 'text-on-primary'
      : state === 'pending'
        ? 'text-secondary'
        : state === 'success'
          ? 'text-success'
          : state === 'failed'
            ? 'text-error'
            : tint === 'secondary'
              ? 'text-secondary'
              : tint === 'tertiary'
                ? 'text-tertiary'
                : tint === 'primary'
                  ? 'text-primary'
                  : 'text-on-surface-variant';

  const textTint =
    state === 'primary' || (variant === 'solid' && state === 'idle')
      ? 'text-on-primary'
      : state === 'pending'
        ? 'text-secondary'
        : state === 'success'
          ? 'text-success'
          : state === 'failed'
            ? 'text-error'
            : 'text-on-surface';

  const glowColor =
    state === 'primary' ? '#FFB703' : state === 'pending' || state === 'success' ? '#00EEFC' : undefined;

  if (variant === 'tile') {
    return (
      <Pressable
        onPress={onPress}
        disabled={state === 'pending' || state === 'disabled'}
        className={`flex-1 flex-col items-center justify-center py-2 px-1 rounded ${shell} ${className}`}
        style={glowColor ? glowStyle(glowColor) : undefined}>
        <Text className={`text-[16px] font-icon ${iconTint}`}>{Icon[icon]}</Text>
        <Text className={`text-[11px] font-headline mt-0.5 ${textTint}`}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={state === 'pending' || state === 'disabled'}
      className={`flex-row items-center justify-center gap-2 py-3 px-3 rounded-lg ${shell} ${className}`}
      style={glowColor ? glowStyle(glowColor) : undefined}>
      <Text className={`text-[18px] font-icon ${iconTint}`}>{Icon[icon]}</Text>
      <Text className={`text-sm font-headline font-bold ${textTint}`}>{label}</Text>
    </Pressable>
  );
}

/** 一行小状态提示（门锁状态、天幕开度这类）。 */
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
  return (
    <View
      className={`flex-row items-center justify-between px-3 py-1.5 bg-surface-container-low rounded-md border border-outline-variant/40 ${className}`}>
      <Text className="text-xs text-on-surface-variant">{label}</Text>
      <Text className={`font-mono text-xs font-semibold ${valueClass}`}>{value}</Text>
    </View>
  );
}

/** 一格状态读数（五门开闭、四窗百分比、胎压四轮都用它）。 */
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
  return (
    <View
      className={`flex-1 py-1.5 px-1 rounded items-center justify-center ${
        active ? 'bg-surface-container-high border border-secondary/40' : 'bg-surface-container'
      }`}>
      <Text className="text-[10px] text-on-surface-variant" numberOfLines={1}>
        {label}
      </Text>
      <Text className={`font-mono text-xs font-bold mt-0.5 ${valueClass}`} numberOfLines={1}>
        {value}
      </Text>
      {sub ? (
        <Text className="text-[9px] text-on-surface-variant/70 mt-0.5" numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/** 底部两个入口：车控 / 设置。 */
export type TabKey = 'control' | 'settings';

const TABS: Array<{ key: TabKey; label: string; icon: IconName }> = [
  { key: 'control', label: '车控', icon: 'tune' },
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
    <View
      className="absolute bottom-0 left-0 right-0 flex-row justify-around items-center px-4 pt-2 bg-surface border-t border-outline-variant/40"
      style={{ paddingBottom: Math.max(insetBottom, 8) }}>
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            className={`flex-1 flex-col items-center justify-center py-1 active:scale-95 ${
              on ? 'bg-primary-container rounded-lg' : ''
            }`}>
            <Text
              className={`text-[22px] font-icon ${on ? 'text-on-primary-container' : 'text-on-surface-variant'}`}>
              {Icon[t.icon]}
            </Text>
            <Text
              className={`text-[11px] font-headline mt-0.5 ${
                on ? 'text-on-primary-container font-bold' : 'text-on-surface-variant'
              }`}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 顶部全局提示条：令牌续期、连接异常这类系统消息。 */
export function Banner({
  text,
  tag,
  tone = 'info',
}: {
  text: string;
  tag?: string;
  tone?: 'info' | 'warn' | 'error';
}) {
  const s = {
    info: {
      box: 'bg-secondary-container/20',
      label: 'text-secondary',
      dot: 'bg-secondary',
      g: 'info' as IconName,
    },
    warn: {
      box: 'bg-primary-container/25',
      label: 'text-on-primary-container',
      dot: 'bg-primary',
      g: 'schedule' as IconName,
    },
    error: {
      box: 'bg-error-container',
      label: 'text-on-error-container',
      dot: 'bg-error',
      g: 'cancel' as IconName,
    },
  }[tone];
  return (
    <View
      className={`mx-3.5 mt-2 rounded-lg px-3 py-2 flex-row items-center justify-between ${s.box}`}>
      <View className="flex-row items-center gap-2 flex-shrink">
        <Text className={`text-[15px] font-icon ${s.label}`}>{Icon[s.g]}</Text>
        <Text className={`text-[12px] font-medium flex-shrink ${s.label}`}>{text}</Text>
      </View>
      {tag ? (
        <View className="flex-row items-center gap-1.5">
          <View className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
          <Text className={`text-[10px] font-mono font-bold ${s.label}`}>{tag}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** 主按钮：登录页「登录」、设置页「重新连接」这类独占一行的操作。 */
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
  const box = {
    primary: 'bg-primary border border-primary',
    danger: 'bg-error-container/30 border border-error/40',
    outline: 'bg-surface border border-secondary',
  }[tone];
  const text = {
    primary: 'text-on-primary',
    danger: 'text-error',
    outline: 'text-secondary',
  }[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={`w-full flex-row items-center justify-center gap-2 h-11 rounded-lg ${box} ${
        disabled ? 'opacity-40' : 'active:scale-95'
      }`}>
      {icon ? <Text className={`text-[17px] font-icon ${text}`}>{Icon[icon]}</Text> : null}
      <Text className={`text-[14px] font-headline font-bold ${text}`}>{label}</Text>
    </Pressable>
  );
}

/** 顶栏：车牌 · 车型 + 在线胶囊 + 刷新按钮。 */
export function TopBar({
  title,
  online,
  onRefresh,
}: {
  title: string;
  online: boolean;
  onRefresh: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between px-3.5 h-14 bg-surface border-b border-outline-variant/40">
      <View className="flex-row items-center gap-2 flex-shrink">
        <Text className="text-primary text-[20px] font-icon">{Icon.directions_car}</Text>
        <Text
          className="font-headline text-base font-extrabold tracking-tight text-on-surface"
          numberOfLines={1}>
          {title}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        <View className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-container border border-outline-variant/60">
          <LiveDot colorClass={online ? 'bg-success' : 'bg-outline'} size={6} />
          <Text
            className={`text-[11px] font-mono font-medium ${
              online ? 'text-secondary' : 'text-outline'
            }`}>
            {online ? '在线联机' : '离线'}
          </Text>
        </View>
        <Pressable
          onPress={onRefresh}
          accessibilityLabel="刷新状态"
          className="w-8 h-8 rounded-full items-center justify-center active:scale-95">
          <Text className="text-on-surface-variant text-[18px] font-icon">{Icon.refresh}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 滚动容器：统一边距、卡片间距与底部留白（给固定导航让位）。 */
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
      contentContainerClassName="px-3.5 pt-3 gap-3.5"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  );
}

export { insetWell, plateShadow, glowStyle };
