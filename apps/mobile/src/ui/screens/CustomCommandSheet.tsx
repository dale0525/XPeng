import { useEffect, useState } from 'react';
import type * as React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { plateShadow } from '../atoms';
import { themeVars, useThemeMode } from '../../core/theme';
import { Icon } from '../icons';
import type { CustomCommandId } from '../../core/quick-commands';

export type { CustomCommandId } from '../../core/quick-commands';

export const CUSTOM_COMMAND_OPTIONS: ReadonlyArray<{
  id: CustomCommandId;
  label: string;
  description: string;
  icon: keyof typeof Icon;
}> = [
  { id: 'doorLock', label: '门锁（解锁/锁车）', description: '一键开锁与上锁', icon: 'lock' },
  { id: 'remoteUnlock', label: '远程解锁', description: '授权无钥匙应急解闭', icon: 'vpn_key' },
  { id: 'acOn', label: '打开空调', description: '预设舒适座舱温度', icon: 'ac_unit' },
  { id: 'flash', label: '闪灯', description: '鸣笛与日行灯双闪找车', icon: 'lightbulb' },
  { id: 'windowClose', label: '全车车窗关闭', description: '关闭四门侧窗', icon: 'vertical_align_bottom' },
  { id: 'windowVent', label: '全车车窗通风', description: '微开缝隙自然换气', icon: 'air' },
  { id: 'shadeOpen', label: '打开遮阳帘', description: '展开全景天幕采光', icon: 'wb_sunny' },
  { id: 'shadeClose', label: '关闭遮阳帘', description: '完全遮蔽隔绝热量', icon: 'shield' },
  { id: 'quickCool', label: '极速降温', description: '最大功率送冷风与座舱对流', icon: 'severe_cold' },
  { id: 'quickWarm', label: '极速升温', description: '方向盘与座椅同步加热', icon: 'heat_pump' },
  { id: 'highTempSterilize', label: '高温抑菌', description: '座舱净化与深度防霉循环', icon: 'clean_hands' },
  { id: 'sentinelOn', label: '开启哨兵模式', description: '周边环境实时警戒监控', icon: 'security' },
  { id: 'sentinelOff', label: '关闭哨兵模式', description: '解除车周主动探测防卫', icon: 'gpp_bad' },
  { id: 'tailgateOpen', label: '打开电动尾门', description: '后备箱电动解锁抬升', icon: 'sensor_door' },
  { id: 'tempPark', label: '临停开关', description: '锁车状态下维持车内供电', icon: 'power' },
];

const MAX_COMMANDS = 4;

function CommandOptionRow({
  option,
  selected,
  onPress,
}: {
  option: (typeof CUSTOM_COMMAND_OPTIONS)[number];
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      className="h-16 px-4 rounded-[22px] bg-surface-container-low flex-row items-center justify-between active:scale-[0.99]">
      <View className="w-10 h-10 rounded-full bg-inset items-center justify-center">
        <Text className="text-[22px] font-icon text-on-surface">{Icon[option.icon]}</Text>
      </View>
      <View className="flex-1 ml-3.5 mr-2">
        <Text className="text-[14px] font-body font-semibold text-on-surface">{option.label}</Text>
        <Text className="text-[11px] font-body text-on-surface-variant" numberOfLines={1}>
          {option.description}
        </Text>
      </View>
      {selected ? (
        <View className="w-6 h-6 rounded-full bg-primary-container items-center justify-center">
          <Text className="text-[16px] font-icon text-on-primary-fixed">{Icon.check}</Text>
        </View>
      ) : (
        <View className="w-6 h-6 rounded-full border-2 border-inset bg-transparent" />
      )}
    </Pressable>
  );
}

export function CustomCommandSheet(props: {
  visible: boolean;
  selected: readonly CustomCommandId[];
  onCancel: () => void;
  onSave: (ids: CustomCommandId[]) => void;
}): React.JSX.Element {
  const { visible, selected, onCancel, onSave } = props;
  const [, , scheme] = useThemeMode();
  const [draft, setDraft] = useState<CustomCommandId[]>([...selected]);

  useEffect(() => {
    if (visible) setDraft([...selected]);
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="justify-end bg-black/45" style={[themeVars(scheme), { flex: 1 }]}>
        <View
          className="bg-surface-container-lowest rounded-t-[28px] overflow-hidden"
          style={[themeVars(scheme), plateShadow, { height: '78%' }]}>
          {/* 顶部拖拽手柄 */}
          <View className="w-full pt-3 pb-1 items-center justify-center">
            <View className="w-9 h-1 rounded-full bg-surface-container-highest" />
          </View>

          {/* 标题栏与关闭按钮 */}
          <View className="px-5 pt-3 pb-2 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2.5">
              <Text className="text-[20px] font-headline font-semibold text-on-surface tracking-tight">
                自定义快捷指令
              </Text>
              <View className="flex-row items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-inset">
                <View className="w-1.5 h-1.5 rounded-full bg-primary-container" />
                <Text
                  className="text-[12px] font-headline font-semibold text-on-surface"
                  style={{ fontVariant: ['tabular-nums'] }}>
                  {`${draft.length} / 4`}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={onCancel}
              accessibilityLabel="关闭"
              className="w-9 h-9 rounded-full bg-inset items-center justify-center active:scale-95">
              <Text className="text-[20px] font-icon text-on-surface">{Icon.close}</Text>
            </Pressable>
          </View>

          {/* 辅助说明行 */}
          <View className="px-5 pb-3 flex-row items-center justify-between">
            <Text className="text-[12px] font-body text-on-surface-variant">
              选择要显示在快捷区的指令（最多 4 个）
            </Text>
            {draft.length >= MAX_COMMANDS ? (
              <Text className="text-[12px] font-body font-medium text-on-surface-variant">已达上限</Text>
            ) : null}
          </View>

          {/* 可滚动指令列表 */}
          <ScrollView
            className="flex-1"
            contentContainerClassName="px-5 pb-4 gap-2.5"
            showsVerticalScrollIndicator={false}>
            {CUSTOM_COMMAND_OPTIONS.map((option) => (
              <CommandOptionRow
                key={option.id}
                option={option}
                selected={draft.includes(option.id)}
                onPress={() =>
                  setDraft((prev) => {
                    if (prev.includes(option.id)) return prev.filter((id) => id !== option.id);
                    if (prev.length >= MAX_COMMANDS) return prev;
                    return [...prev, option.id];
                  })
                }
              />
            ))}
          </ScrollView>

          {/* 底部固定操作栏 */}
          <View className="w-full bg-surface-container-lowest px-5 pt-3 pb-2 border-t border-inset">
            <View className="flex-row items-center gap-3">
              <Pressable
                onPress={onCancel}
                className="flex-1 h-[50px] rounded-full bg-inset items-center justify-center active:scale-95">
                <Text className="text-[15px] font-headline font-semibold text-on-surface">取消</Text>
              </Pressable>
              <Pressable
                onPress={() => onSave(draft)}
                className="flex-1 h-[50px] rounded-full bg-primary-container flex-row items-center justify-center gap-1.5 active:scale-95"
                style={plateShadow}>
                <Text className="text-[15px] font-headline font-semibold text-on-primary-fixed">
                  保存配置
                </Text>
                <Text className="text-[18px] font-icon text-on-primary-fixed">
                  {Icon.arrow_forward}
                </Text>
              </Pressable>
            </View>
            {/* iOS Home Indicator */}
            <View className="w-32 h-1 rounded-full bg-surface-container-highest self-center mt-2.5" />
          </View>
        </View>
      </View>
    </Modal>
  );
}
