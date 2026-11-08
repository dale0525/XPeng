import { useState } from 'react';
import type * as React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { plateShadow } from '../atoms';
import { themeVars, useThemeMode } from '../../core/theme';
import { Icon } from '../icons';
import { startSummon, stopSummon, type SummonDirection, type SummonResult } from '../../core/summon';

/** 圆形关闭按钮。 */
function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="关闭"
      className="w-9 h-9 rounded-full bg-inset items-center justify-center active:scale-95">
      <Text className="text-[20px] font-icon text-on-surface">{Icon.close}</Text>
    </Pressable>
  );
}

function DirectionButton({
  glyph,
  label,
  pressed,
  onPressIn,
  onPressOut,
}: {
  glyph: string;
  label: string;
  pressed: boolean;
  onPressIn: () => void;
  onPressOut: () => void;
}) {
  return (
    <Pressable
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      className="w-full h-14 rounded-full bg-primary-container flex-row items-center justify-center gap-2"
      style={{ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }}>
      {/* 不能加 font-bold：Android 在 MaterialSymbols 上没有粗体变体，会整族回退到默认
          字体，字形渲染成 x（原本 vertical_align_top/bottom 正是这样坏的）。设计稿里
          `font-semibold` 只对文字生效，图标本身就靠字形笔画粗细。 */}
      <Text className="text-[20px] font-icon text-on-primary-fixed">{glyph}</Text>
      <Text className="text-[16px] font-body font-semibold text-on-primary-fixed">{label}</Text>
    </Pressable>
  );
}

export function StraightSummonSheet(props: {
  visible: boolean;
  onClose: () => void;
  bluetoothConnected: boolean;
}): React.JSX.Element {
  const { visible, onClose, bluetoothConnected } = props;
  const [, , scheme] = useThemeMode();
  const [pressDir, setPressDir] = useState<SummonDirection | null>(null);
  /** 真实发帧结果；`SummonResult.unconfirmed` 决定是否显示灰字说明。 */
  const [summonText, setSummonText] = useState('待命');
  const [note, setNote] = useState<string | null>(null);
  /** 提示条是错误（原生拒绝）还是仅说明（未进入召唤态）；决定配色。 */
  const [noteIsError, setNoteIsError] = useState(false);

  function show(result: SummonResult, done: string) {
    // 状态文案只认「车端是否激活」，不认「帧写出去了没有」：激活帧未实现，
    // 所以成功发帧也停在「待命」，把真实原因放提示条里，不伪装成召唤成功。
    setSummonText(result.ok ? (result.activated ? done : '待命') : '发帧失败');
    setNoteIsError(!result.ok);
    setNote(result.error ?? result.prerequisite ?? (result.unconfirmed ? result.note : null));
  }

  function press(direction: SummonDirection) {
    setPressDir(direction);
    startSummon(direction).then((result) => show(result, '召唤中'));
  }

  function release() {
    if (pressDir === null) return;
    setPressDir(null);
    stopSummon().then((result) => show(result, '已停止'));
  }

  function exit() {
    if (pressDir !== null) void stopSummon();
    setPressDir(null);
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={exit}>
      <View className="justify-end bg-black/45" style={[themeVars(scheme), { flex: 1 }]}>
        <View
          className="bg-surface rounded-t-[32px] overflow-hidden px-6 pt-3 pb-3"
          style={[themeVars(scheme), plateShadow]}>
          <View className="w-full items-center mb-3">
            <View className="w-10 h-1 rounded-full bg-surface-container-highest" />
          </View>

          <View className="flex-row items-center justify-between w-full py-1">
            <Text className="text-[20px] font-headline font-semibold text-on-surface tracking-tight">
              直线召唤
            </Text>
            <CloseButton onPress={exit} />
          </View>

          <View className="bg-inset rounded-[22px] p-4 my-4 gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-[14px] font-body text-on-surface-variant">蓝牙通道</Text>
              <View className="flex-row items-center">
                {bluetoothConnected ? (
                  <View className="w-2 h-2 rounded-full mr-1.5 bg-positive" />
                ) : (
                  <View className="w-2 h-2 rounded-full mr-1.5 bg-surface-container-highest" />
                )}
                <Text className="text-[14px] font-body font-medium text-on-surface">
                  {bluetoothConnected ? '已连接' : '未连接'}
                </Text>
              </View>
            </View>
            <View className="h-px w-full bg-hairline" />
            <View className="flex-row items-center justify-between">
              <Text className="text-[14px] font-body text-on-surface-variant">当前通道</Text>
              <Text className="text-[14px] font-body font-semibold text-on-surface">蓝牙</Text>
            </View>
          </View>

          <View className="flex-col items-center w-full">
            <DirectionButton
              glyph={Icon.arrow_upward}
              label="向前"
              pressed={pressDir === 'forward'}
              onPressIn={() => press('forward')}
              onPressOut={release}
            />
            <View className="py-2.5 items-center justify-center">
              <Text className="text-[12px] font-body text-on-surface-variant tracking-wide">按住不放，松开即停</Text>
            </View>
            <DirectionButton
              glyph={Icon.arrow_downward}
              label="向后"
              pressed={pressDir === 'backward'}
              onPressIn={() => press('backward')}
              onPressOut={release}
            />
          </View>

          <View className="flex-row gap-3 my-4">
            <View className="flex-1 bg-inset rounded-[20px] p-3.5 gap-1.5">
              <Text className="text-[12px] font-body text-on-surface-variant">车辆状态</Text>
              <Text className="text-[18px] font-headline font-bold text-on-surface leading-none">—</Text>
            </View>
            <View className="flex-1 bg-inset rounded-[20px] p-3.5 gap-1.5">
              <Text className="text-[12px] font-body text-on-surface-variant">召唤状态</Text>
              <Text className="text-[18px] font-headline font-bold text-on-surface leading-none">
                {summonText}
              </Text>
            </View>
          </View>

          {note ? (
            /* 失败原文与「未进入召唤态」都走这块可读提示条：12px text-outline 在真机
               上几乎看不见，正是「按下去没反应」观感的一半。两套样式是两块独立的、
               className 恒定的分支——按条件拼类名会让 NativeWind 反复重解析并卡死
               JS 线程。 */
            noteIsError ? (
              <View className="mb-4 rounded-[18px] bg-error-container px-4 py-3">
                <Text className="text-xs font-body font-medium text-on-error-container leading-relaxed">
                  {note}
                </Text>
              </View>
            ) : (
              <View className="mb-4 rounded-[18px] bg-inset px-4 py-3">
                <Text className="text-xs font-body font-medium text-on-surface-variant leading-relaxed">
                  {note}
                </Text>
              </View>
            )
          ) : null}

          <View className="pt-0.5">
            <Pressable
              onPress={exit}
              className="w-full h-12 rounded-full bg-inset items-center justify-center active:scale-[0.99]">
              <Text className="text-[15px] font-body font-medium text-on-surface">退出召唤</Text>
            </Pressable>
            <View className="mt-4 mb-1 items-center">
              <View className="w-32 h-1 rounded-full bg-surface-container-highest" />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
