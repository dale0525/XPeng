import { useCallback, useEffect, useState } from 'react';
import type * as React from 'react';
import { Modal, Pressable, Text, View, type ViewStyle } from 'react-native';
import { plateShadow } from '../atoms';
import { themeVars, useThemeMode } from '../../core/theme';
import { Icon } from '../icons';
import {
  closeRemoteView,
  openRemoteView,
  switchView,
  type RemoteViewAngle,
} from '../../core/remote-view';

const VIEW_OPTIONS: ReadonlyArray<{ label: string; angle: RemoteViewAngle }> = [
  { label: '前视', angle: 'front' },
  { label: '后视', angle: 'back' },
  { label: '左视', angle: 'left' },
  { label: '右视', angle: 'right' },
];

/** 取景器四角发丝角标：1.5px 描边、外角 4px 圆角。 */
const CORNER_BASE: ViewStyle = {
  position: 'absolute',
  width: 16,
  height: 16,
  borderColor: 'rgba(255,255,255,0.3)',
};
const CORNER_STYLES: ReadonlyArray<ViewStyle> = [
  { top: 12, left: 12, borderTopWidth: 1.5, borderLeftWidth: 1.5, borderTopLeftRadius: 4 },
  { top: 12, right: 12, borderTopWidth: 1.5, borderRightWidth: 1.5, borderTopRightRadius: 4 },
  { bottom: 12, left: 12, borderBottomWidth: 1.5, borderLeftWidth: 1.5, borderBottomLeftRadius: 4 },
  { bottom: 12, right: 12, borderBottomWidth: 1.5, borderRightWidth: 1.5, borderBottomRightRadius: 4 },
];

/** 圆形关闭按钮。 */
function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="关闭"
      className="w-9 h-9 rounded-full bg-inset items-center justify-center active:scale-90">
      <Text className="text-[18px] font-icon text-on-surface">{Icon.close}</Text>
    </Pressable>
  );
}

function ViewPill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  if (selected) {
    return (
      <Pressable
        onPress={onPress}
        className="flex-1 py-2 rounded-full bg-primary-container items-center active:scale-95">
        <Text className="text-xs font-label font-semibold text-on-primary-fixed">{label}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} className="flex-1 py-2 rounded-full bg-inset items-center active:scale-95">
      <Text className="text-xs font-label font-medium text-on-surface-variant">{label}</Text>
    </Pressable>
  );
}

export function RemoteViewSheet(props: {
  visible: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { visible, onClose } = props;
  const [, , scheme] = useThemeMode();
  const [active, setActive] = useState<RemoteViewAngle>('front');
  /** 连接状态：MQTT 下发结果，不是本地推导。 */
  const [linkText, setLinkText] = useState('未开始');
  const [linkOk, setLinkOk] = useState(false);
  /** 画面状态：拉流/切视角/关流的回执结果。 */
  const [pictureText, setPictureText] = useState('—');
  /** 只有这两种状态代表画面真的在出图。 */
  const streaming = pictureText === '已开流' || pictureText === '画面正常';
  /** 失败原文单独留一份：要显示在弹窗正文里，不能只塞进 12px 灰字。 */
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setActive('front');
    setLinkText('正在初始化');
    setPictureText('正在拉流');
    setErrorText(null);
    openRemoteView()
      .then((result) => {
        if (!alive) return;
        setLinkOk(result.ok);
        setLinkText(result.ok ? '已连接' : (result.error ?? '下发失败'));
        // 回执里的 camera_live_url 是运行时凭据：不展示、不落盘、不写日志。
        // 视频占位区保持占位，也是因为 RN 侧没有可用的视频播放组件。
        setPictureText(result.ok ? '已开流' : '拉流失败');
        setErrorText(result.ok ? null : (result.error ?? '下发失败（无错误文案）'));
      })
      .catch((e: unknown) => {
        // `carLink.send` 正常返回 CommandResult、不 reject，但包装函数是 async，
        // 任何同步抛错都会变成 rejected promise。不接住就只剩一个未处理的
        // rejection，界面停在「正在初始化」，用户看到的就是「没有反应」。
        if (!alive) return;
        const raw = e instanceof Error ? e.message : String(e);
        setLinkOk(false);
        setLinkText('下发失败');
        setPictureText('拉流失败');
        setErrorText(raw);
      });
    return () => {
      alive = false;
    };
  }, [visible]);

  const selectAngle = useCallback((angle: RemoteViewAngle) => {
    setActive(angle);
    setPictureText('切换中');
    setErrorText(null);
    switchView(angle)
      .then((result) => {
        setPictureText(result.ok ? '画面正常' : '切换失败');
        setErrorText(result.ok ? null : (result.error ?? '切换失败（无错误文案）'));
      })
      .catch((e: unknown) => {
        setPictureText('切换失败');
        setErrorText(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const close = useCallback(() => {
    // 先收弹窗再下发：关流回执要等车端，弹窗不该为此卡在原地。
    setPictureText('正在关闭');
    void closeRemoteView().catch(() => {});
    onClose();
  }, [onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View className="justify-end bg-black/45" style={[themeVars(scheme), { flex: 1 }]}>
        <View
          className="bg-surface rounded-t-[28px] overflow-hidden px-6 pt-3 pb-6"
          style={[themeVars(scheme), plateShadow]}>
          <View className="w-[36px] h-[4px] rounded-full bg-surface-container-highest self-center mb-4" />

          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-[20px] font-headline font-bold text-on-surface tracking-tight">
              远程查看
            </Text>
            <CloseButton onPress={close} />
          </View>

          <View
            className="relative w-full rounded-[22px] bg-ink overflow-hidden items-center justify-center"
            style={{ aspectRatio: 16 / 9 }}>
            {CORNER_STYLES.map((corner, i) => (
              <View key={i} style={[CORNER_BASE, corner]} />
            ))}
            {/* 设计稿是静态画面、徽标常亮；实现里只有真正开流/画面正常时才显示，
                否则用户会把占位框误当成实时画面。 */}
            {streaming ? (
              <View className="absolute top-[20px] left-[20px] flex-row items-center gap-1.5 bg-black/50 px-2.5 py-1 rounded-full">
                <View className="w-1.5 h-1.5 rounded-full bg-positive" />
                <Text className="text-[12px] font-body font-medium text-white leading-none tracking-wider">实时</Text>
              </View>
            ) : null}
            <View className="items-center justify-center gap-1.5">
              <Text className="text-[28px] font-icon text-on-surface-variant">{Icon.videocam}</Text>
              <Text className="text-[13px] font-body text-on-surface-variant tracking-wide">视频画面</Text>
            </View>
          </View>

          <View className="mt-[14px] mb-3 flex-row gap-2">
            {VIEW_OPTIONS.map(({ label, angle }) => (
              <ViewPill
                key={angle}
                label={label}
                selected={angle === active}
                onPress={() => selectAngle(angle)}
              />
            ))}
          </View>

          <View className="mb-4 bg-inset rounded-[20px] px-5 py-3 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Text className="text-xs font-body text-on-surface-variant">连接状态</Text>
              <View className="flex-row items-center gap-1.5">
                {linkOk ? (
                  <View className="w-1.5 h-1.5 rounded-full bg-positive" />
                ) : (
                  <View className="w-1.5 h-1.5 rounded-full bg-surface-container-highest" />
                )}
                <Text className="text-xs font-body font-medium text-on-surface">{linkText}</Text>
              </View>
            </View>
            <View className="w-[1px] h-[14px] bg-surface-container-highest" />
            <View className="flex-row items-center gap-2">
              <Text className="text-xs font-body text-on-surface-variant">画面状态</Text>
              <Text className="text-xs font-body font-medium text-on-surface">{pictureText}</Text>
            </View>
          </View>

          {errorText ? (
            /* 失败原文放在 bg-error-container 上：12px 淡灰字在真机上几乎看不见，
               「只有黑条、没有报错信息」的观感就是这么来的。 */
            <View className="mb-4 rounded-[18px] bg-error-container px-4 py-3">
              <Text className="text-xs font-body font-medium text-on-error-container leading-relaxed">
                {errorText}
              </Text>
            </View>
          ) : null}

          <Pressable
            onPress={close}
            className="w-full h-[52px] rounded-full bg-primary-container items-center justify-center active:scale-[0.98]">
            <Text className="text-base font-headline font-bold text-on-primary-fixed tracking-tight">关闭查看</Text>
          </Pressable>

          <View className="mt-4 items-center">
            <View className="w-[128px] h-[4px] rounded-full bg-surface-container-highest" />
          </View>
        </View>
      </View>
    </Modal>
  );
}
