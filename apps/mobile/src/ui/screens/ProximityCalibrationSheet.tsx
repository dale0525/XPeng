import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { plateShadow } from '../atoms';
import { themeVars, useThemeMode } from '../../core/theme';
import { Icon } from '../icons';
import { bleLink } from '../../core/ble';
import type { ProximityCalibration } from '@xpeng/protocol/src/proximity-calibration';
import { MIN_CALIBRATION_SAMPLES, parseManualThresholds } from '@xpeng/protocol/src/proximity-calibration';

type Phase =
  | { kind: 'intro' }
  | { kind: 'sampling'; secondsLeft: number }
  | { kind: 'done'; calibration: ProximityCalibration }
  | { kind: 'manual'; nearText: string; error: string | null }
  | { kind: 'failed'; reason: string; count: number };

/**
 * 首次打开「靠近自动解闭锁」时的就地标定引导。
 *
 * 为什么非要标定：RSSI 的绝对值随手机型号、壳体、握持、环境差十几个 dB，
 * 拍脑袋定的阈值会把「近在眼前」判成「很远」。这里让用户站到**希望解锁的位置**
 * 静置采样，取中位数当解锁阈值；闭锁阈值由它减 15 dB 自动推导，无需单独标定。
 * 采样走**持连接读数**——与判距本身同一条链路、同一种量纲，且零丢失无选择偏差。
 */
export function ProximityCalibrationSheet(props: {
  visible: boolean;
  /** 当前生效的阈值，用于"手动填写"入口的预填值。 */
  current: { nearRssi: number; farRssi: number };
  onCancel: () => void;
  onConfirmed: (calibration: ProximityCalibration) => void;
}): React.JSX.Element {
  const { visible, current, onCancel, onConfirmed } = props;
  const [, , scheme] = useThemeMode();
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' });
  const cancelled = useRef(false);

  useEffect(() => {
    if (visible) {
      cancelled.current = false;
      setPhase({ kind: 'intro' });
    }
  }, [visible]);

  const start = async () => {
    setPhase({ kind: 'sampling', secondsLeft: SAMPLING_SECONDS });
    const startedAt = Date.now();
    // 倒计时只用于给用户看；真正的采样时长由 bleLink.startCalibration 控制。
    const ticker = setInterval(() => {
      if (cancelled.current) return;
      const left = Math.max(0, SAMPLING_SECONDS - Math.floor((Date.now() - startedAt) / 1000));
      setPhase((p) => (p.kind === 'sampling' ? { kind: 'sampling', secondsLeft: left } : p));
    }, 500);
    const result = await bleLink.startCalibration(SAMPLING_SECONDS * 1000);
    clearInterval(ticker);
    if (cancelled.current) return;
    if (result.ok && result.calibration) setPhase({ kind: 'done', calibration: result.calibration });
    else {
      const reason = result.reason === 'too-few-samples'
        ? `只采到 ${result.count} 次有效信号，不足以定值。请把手机拿稳、离车再近一些重试。`
        : '没扫到车辆蓝牙。请确认蓝牙已开、车在附近，然后重试。';
      setPhase({ kind: 'failed', reason, count: result.count });
    }
  };

  const close = () => {
    cancelled.current = true;
    onCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      {/* 键盘弹出时把弹层顶上去：原来整块贴底固定，输入名称/标定值时输入框被键盘
          完全盖住，用户看不见自己在打什么。iOS 用 padding、Android 用 height 才是
          各自的正确行为。 */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="justify-end bg-black/45"
        style={{ flex: 1 }}>
        <View className="bg-surface-container-lowest rounded-t-[28px] overflow-hidden" style={[themeVars(scheme), plateShadow]}>
          <View className="w-full pt-3 pb-1 items-center justify-center">
            <View className="w-9 h-1 rounded-full bg-surface-container-highest" />
          </View>
          <View className="px-5 pt-3 pb-2 flex-row items-center justify-between">
            <Text className="text-[20px] font-headline font-semibold text-on-surface tracking-tight">
              标定解锁距离
            </Text>
            <Pressable onPress={close} accessibilityLabel="关闭" className="w-9 h-9 rounded-full bg-inset items-center justify-center active:scale-95">
              <Text className="text-[20px] font-icon text-on-surface">{Icon.close}</Text>
            </Pressable>
          </View>

          <View className="px-5 pb-5 gap-4">
            {phase.kind === 'intro' ? (
              <>
                <Text className="text-[13px] font-body text-on-surface-variant leading-relaxed">
                  为了让自动解锁在「走到车边」时触发，请先做一次就地标定：
                </Text>
                <View className="rounded-2xl bg-inset p-4 gap-2">
                  <Text className="text-[13px] font-body text-on-surface leading-relaxed">1. 拿着手机，站到你希望车自动解锁的那个位置（比如离车 3 米处）。</Text>
                  <Text className="text-[13px] font-body text-on-surface leading-relaxed">2. 手机保持不动，等 {SAMPLING_SECONDS} 秒采样完成。</Text>
                  <Text className="text-[13px] font-body text-on-surface leading-relaxed">3. 采样用蓝牙连接读数，过程中连接会保持，不影响正常使用。</Text>
                </View>
                <Primary label="开始标定" onPress={start} />
                <Pressable
                  onPress={() => setPhase({
                    kind: 'manual',
                    nearText: String(Math.abs(current.nearRssi)),
                    error: null,
                  })}
                  className="h-[44px] items-center justify-center active:scale-95"
                >
                  <Text className="text-[13px] font-headline font-semibold text-primary">或直接手动填写阈值</Text>
                </Pressable>
              </>
            ) : null}

            {phase.kind === 'sampling' ? (
              <>
                <View className="items-center py-4">
                  <Text className="text-[52px] font-headline font-semibold text-on-surface" style={{ fontVariant: ['tabular-nums'] }}>
                    {phase.secondsLeft}
                  </Text>
                  <Text className="text-[13px] font-body text-on-surface-variant mt-1">请保持手机位置不动…</Text>
                </View>
                <View className="rounded-2xl bg-inset p-3">
                  <Text className="text-[12px] font-body text-on-surface-variant leading-relaxed">正在采集蓝牙连接下的信号强度。请保持手机在刚才的位置不动。</Text>
                </View>
              </>
            ) : null}

            {phase.kind === 'done' ? (
              <>
                <View className="flex-row items-center gap-2">
                  <Text className="text-[18px] font-icon text-positive">{Icon.check_circle}</Text>
                  <Text className="text-[15px] font-headline font-semibold text-on-surface">标定完成</Text>
                </View>
                <View className="rounded-2xl bg-inset p-4 gap-1.5">
                  <Text className="text-[13px] font-body text-on-surface">{`解锁阈值约为 ${phase.calibration.nearRssi} dBm`}</Text>
                  <Text className="text-[13px] font-body text-on-surface">{`闭锁阈值自动取 ${phase.calibration.farRssi} dBm（解锁值 − 15 dB）`}</Text>
                  <Text className="text-[12px] font-body text-on-surface-variant">{`共采样 ${phase.calibration.sampleCount} 次`}</Text>
                </View>
                <Text className="text-[12px] font-body text-on-surface-variant leading-relaxed">若实际触发距离不满意，可手动改数值或重新标定。</Text>
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={() => setPhase({
                      kind: 'manual',
                      nearText: String(Math.abs(phase.calibration.nearRssi)),
                      error: null,
                    })}
                    className="flex-1 h-[50px] rounded-full bg-inset items-center justify-center active:scale-95"
                  >
                    <Text className="text-[15px] font-headline font-semibold text-on-surface">手动修改</Text>
                  </Pressable>
                  <Primary label="用这个结果" onPress={() => onConfirmed(phase.calibration)} flex />
                </View>
              </>
            ) : null}

            {phase.kind === 'manual' ? (
              <>
                <View className="flex-row items-center gap-2">
                  <Text className="text-[15px] font-headline font-semibold text-on-surface">手动设置阈值</Text>
                </View>
                <Text className="text-[12px] font-body text-on-surface-variant leading-relaxed">
                  只填解锁值即可，负号和 dB 已标在框外。数字越小，离车越近才触发；数字越大，离得远一点就触发。闭锁值会自动取「解锁值 − 15 dB」。
                </Text>
                <View className="rounded-2xl bg-inset p-4 gap-3">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-[13px] font-body text-on-surface">解锁阈值</Text>
                    <View className="flex-row items-center gap-1.5">
                      <Text className="text-[15px] font-headline font-semibold text-on-surface-variant">−</Text>
                      <TextInput
                        value={phase.nearText}
                        onChangeText={(t) => setPhase((p) => (p.kind === 'manual' ? { ...p, nearText: t, error: null } : p))}
                        keyboardType="number-pad"
                        className="w-[78px] h-10 rounded-xl bg-surface-container-lowest text-center text-[16px] font-headline font-semibold text-on-surface" style={{ paddingHorizontal: 0, paddingVertical: 0, includeFontPadding: false, textAlignVertical: 'center' }}
                        placeholder="75"
                        placeholderTextColor="#8a8f98"
                      />
                      <Text className="text-[13px] font-body text-on-surface-variant">dBm</Text>
                    </View>
                  </View>
                </View>
                {phase.error ? (
                  <Text className="text-[12px] font-body text-error leading-relaxed">{phase.error}</Text>
                ) : null}
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={() => setPhase({ kind: 'intro' })}
                    className="flex-1 h-[50px] rounded-full bg-inset items-center justify-center active:scale-95"
                  >
                    <Text className="text-[15px] font-headline font-semibold text-on-surface">返回</Text>
                  </Pressable>
                  <Primary
                    label="保存"
                    flex
                    onPress={() => {
                      if (phase.kind !== 'manual') return;
                      const parsed = parseManualThresholds(phase.nearText);
                      if (!parsed.ok) {
                        setPhase((p) => (p.kind === 'manual'
                          ? { ...p, error: '请填一个 1~120 的整数（例如 75）。' }
                          : p));
                        return;
                      }
                      onConfirmed(parsed.calibration);
                    }}
                  />
                </View>
              </>
            ) : null}

            {phase.kind === 'failed' ? (
              <>
                <View className="flex-row items-center gap-2">
                  <Text className="text-[18px] font-icon text-error">{Icon.gpp_maybe}</Text>
                  <Text className="text-[15px] font-headline font-semibold text-on-surface">这次没采够</Text>
                </View>
                <View className="rounded-2xl bg-inset p-4">
                  <Text className="text-[13px] font-body text-on-surface leading-relaxed">{phase.reason}</Text>
                </View>
                <View className="flex-row gap-3">
                  <Pressable onPress={close} className="flex-1 h-[50px] rounded-full bg-inset items-center justify-center active:scale-95">
                    <Text className="text-[15px] font-headline font-semibold text-on-surface">稍后再说</Text>
                  </Pressable>
                  <Primary label="重新标定" onPress={start} flex />
                </View>
              </>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// 2026-11-12 由 15 s 延长到 30 s：15 s 只有约 7 个有效样本，取中位数也偏噪声；
// 门边实测 149 个样本才稳定反映分布，30 s（约 15~20 个样本）是可接受的下限。
const SAMPLING_SECONDS = 15;

function Primary({ label, onPress, flex }: { label: string; onPress: () => void; flex?: boolean }): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      className={`${flex ? 'flex-1' : 'w-full'} h-[50px] rounded-full bg-primary-container items-center justify-center active:scale-95`}
      style={plateShadow}>
      <Text className="text-[15px] font-headline font-semibold text-on-primary-fixed">{label}</Text>
    </Pressable>
  );
}
