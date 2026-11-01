/**
 * 设计稿里的 CSS 视觉原语，转成 RN 可用的形式。
 *
 * 稿子里靠 `clip-path` / `skewX` / `box-shadow` 做的斜切徽章、切角卡片、内凹槽、
 * 发光边框，RN 没有对应属性，逐项换成：
 *   clip-path  → `View` 四角用绝对定位的三角形遮罩，或用 border 拼斜边
 *   skewX      → `transform: [{ skewX }]`（RN 支持），子元素反向 skew 抵消
 *   inset 阴影 → 叠一层半透明描边 + 顶部高光线
 *   glow       → `shadowColor/shadowRadius` + Android `elevation`
 *
 * 取值都照抄设计稿的 px，不另立一套。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, Text, View, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './icons';

/**
 * 斜切徽章：设计稿的 `.skew-badge` / `.badge-slant`（skewX(-8deg)）。
 * 外框斜切、内文反向斜切，文字才不歪。
 */
export function SkewBadge({
  children,
  className = '',
  angle = -8,
}: {
  children: ReactNode;
  className?: string;
  angle?: number;
}) {
  return (
    <View
      className={`flex-row items-center ${className}`}
      style={{ transform: [{ skewX: `${angle}deg` }] }}>
      <View className="flex-row items-center" style={{ transform: [{ skewX: `${-angle}deg` }] }}>
        {children}
      </View>
    </View>
  );
}

/**
 * 右上角切角卡片：设计稿 `.cut-corner-top-right` / `.chamfer-tr`
 * （`clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%)`）。
 *
 * RN 的 `clip-path` 只在较新版本可用且行为不一致，这里改用「右上角盖一个与背景同色
 * 的斜角块」达到同样效果；卡片有描边时，另补一条斜边线。
 */
export function CutCorner({
  children,
  className = '',
  size = 10,
  borderColor,
  bgColor,
}: {
  children: ReactNode;
  className?: string;
  size?: number;
  borderColor?: string;
  bgColor?: string;
}) {
  return (
    <View className={`relative ${className}`}>
      {children}
      {bgColor ? (
        <View
          className="absolute top-0 right-0"
          style={{
            width: size * 1.5,
            height: size * 1.5,
            backgroundColor: bgColor,
            transform: [{ translateX: size * 0.75 }, { translateY: -size * 0.75 }, { rotate: '45deg' }],
          }}
        />
      ) : null}
      {borderColor ? (
        <View
          className="absolute"
          style={{
            top: size * 0.42,
            right: -1,
            width: size * 1.42,
            height: 1,
            backgroundColor: borderColor,
            transform: [{ rotate: '-45deg' }],
          }}
        />
      ) : null}
    </View>
  );
}

/** 设计稿的 `.inset-dial-well` / `.inset-recessed`：内凹槽，靠顶部暗线 + 内描边表现。 */
export const insetWell: ViewStyle = {
  borderWidth: 1,
  borderTopColor: 'rgba(0,0,0,0.28)',
  borderColor: 'rgba(0,0,0,0.12)',
  shadowColor: '#000',
  shadowOpacity: 0.35,
  shadowRadius: 4,
  shadowOffset: { width: 0, height: 2 },
  elevation: 0,
};

/** 设计稿的 `.glow-cyan` / `.glow-amber`：外发光。RN 的 Android 发光只能靠 elevation + 阴影色。 */
export function glowStyle(color: string, radius = 12): ViewStyle {
  return Platform.select<ViewStyle>({
    android: { elevation: 4, shadowColor: color },
    default: { shadowColor: color, shadowOpacity: 0.45, shadowRadius: radius, shadowOffset: { width: 0, height: 0 } },
  })!;
}

/** 设计稿的 `.hud-card-bevel`：顶边 1px 高光 + 深投影，让卡片像一块浮雕。 */
export const hudBevel: ViewStyle = {
  borderTopWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.12)',
  shadowColor: '#000',
  shadowOpacity: 0.35,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 8 },
  elevation: 6,
};

/** 设计稿的 `.plate-shadow` / `.raised-plate`：亮色稿的卡片投影，很淡。 */
export const plateShadow: ViewStyle = {
  shadowColor: '#1C1A15',
  shadowOpacity: 0.07,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 2,
};

/**
 * 三斜杠速度条：设计稿里反复出现（首页 hero 顶栏、设置页装饰条）。
 * 三根竖条依次变窄变淡，整体 -12deg。
 */
export function SpeedStripes({
  colorClass = 'bg-secondary',
  height = 12,
}: {
  colorClass?: string;
  height?: number;
}) {
  return (
    <View className="flex-row items-end gap-0.5" style={{ transform: [{ skewX: '-12deg' }] }}>
      <View className={`w-1.5 ${colorClass}`} style={{ height }} />
      <View className={`w-1 ${colorClass} opacity-60`} style={{ height }} />
      <View className={`w-0.5 ${colorClass} opacity-30`} style={{ height }} />
    </View>
  );
}

/** 在线脉冲点：设计稿 `animate-ping` 的中心点 + 外圈。静态呈现，动画交给 Animated。 */
export function LiveDot({ colorClass = 'bg-secondary', size = 8 }: { colorClass?: string; size?: number }) {
  return (
    <View className="items-center justify-center" style={{ width: size * 2, height: size * 2 }}>
      <View
        className={`absolute rounded-full ${colorClass} opacity-25`}
        style={{ width: size * 2, height: size * 2 }}
      />
      <View className={`rounded-full ${colorClass}`} style={{ width: size, height: size }} />
    </View>
  );
}

/**
 * 分段仪表条：设计稿首页电池 10 格、车控温度 7 格都用这个。
 * `filled` 段数按百分比取整。
 */
export function SegmentBar({
  total,
  filled,
  fillClass = 'bg-primary',
  emptyClass = 'bg-outline-variant/40',
  height = 8,
  gap = 2,
}: {
  total: number;
  filled: number;
  fillClass?: string;
  emptyClass?: string;
  height?: number;
  gap?: number;
}) {
  return (
    <View className="w-full flex-row" style={{ gap }}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          className={`flex-1 rounded-sm ${i < filled ? fillClass : emptyClass}`}
          style={{ height }}
        />
      ))}
    </View>
  );
}

/** 图标 + 一行小字的状态胶囊，设计稿里门口节点、胎压点都用它。 */
export function DotTag({
  icon,
  label,
  value,
  dotClass = 'bg-secondary',
  valueClass = 'text-secondary',
}: {
  icon?: IconName;
  label: string;
  value: string;
  dotClass?: string;
  valueClass?: string;
}) {
  return (
    <View className="flex-row items-center gap-1">
      {icon ? (
        <Text className="text-[12px] text-secondary font-icon">{Icon[icon]}</Text>
      ) : (
        <View className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      )}
      <Text className="text-[11px] text-on-surface">{label}</Text>
      <Text className={`text-[10px] font-mono font-bold ${valueClass}`}>{value}</Text>
    </View>
  );
}

/**
 * 旋转的加载图标。`pending` 为真时以 1s/圈匀速转，为假时不渲染。
 *
 * 为什么不用 ActivityIndicator：设计稿里的所有图标都来自 Material Symbols 子集，
 * 平台自带的菊花图在这套字体/配色下显得格格不入；直接转同一个 `sync` 字形，
 * 与按钮内其余图标同族同色。
 */
export function SpinnerIcon({
  size = 19,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.Text
      className={`font-icon ${className}`}
      style={{ fontSize: size, transform: [{ rotate }] }}>
      {Icon.sync}
    </Animated.Text>
  );
}
