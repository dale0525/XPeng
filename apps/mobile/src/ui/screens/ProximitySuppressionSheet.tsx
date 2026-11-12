import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { plateShadow, SpinnerIcon } from '../atoms';
import { themeVars, useThemeMode } from '../../core/theme';
import { Icon } from '../icons';
import { bleLink } from '../../core/ble';
import { parseSuppression, type ProximitySuppression, type SuppressionPlace } from '@xpeng/protocol/src/proximity-suppression';

/**
 * 「哪些 WiFi 下、哪些地点附近不自动解闭锁」的设置页。
 *
 * WiFi 只能靠名字判：Android 10 起第三方 App 拿不到用户保存的网络清单，所以名单由
 * 用户自己录入名字，判定时拿当前连着的那个网络的 SSID 来比。名字匹配忽略大小写与
 * 系统加的双引号。多输一个字母，规则就永远不生效——所以每次保存后都拿当前网络回显
 * 一次"现在匹配到了哪条"，让用户能立刻看出自己是不是打错了。
 */
export function ProximitySuppressionSheet(props: {
  visible: boolean;
  rules: ProximitySuppression;
  onCancel: () => void;
  onSave: (rules: ProximitySuppression) => void;
}): React.JSX.Element {
  const { visible, rules, onCancel, onSave } = props;
  const [, , scheme] = useThemeMode();
  const [draft, setDraft] = useState<ProximitySuppression>(rules);
  const [ssidInput, setSsidInput] = useState('');
  const [busy, setBusy] = useState<'ssid' | 'saved' | 'locate' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(rules);
    setSsidInput('');
    setMessage(null);
    setBusy(null);
  }, [visible, rules]);

  const addSsid = (raw: string) => {
    const name = raw.trim();
    if (name === '') return;
    setDraft((current) => {
      const exists = current.wifiSsids.some((s) => s.trim().toLowerCase() === name.toLowerCase());
      return exists ? current : { ...current, wifiSsids: [...current.wifiSsids, name] };
    });
  };

  /** 一键把当前连着的网络加进名单：比手打名字可靠，也省得用户去系统设置里看自己叫什么网。 */
  const addCurrentSsid = async () => {
    setBusy('ssid');
    setMessage(null);
    try {
      const ssid = await bleLink.currentWifiSsid();
      if (!ssid) {
        setMessage('读不到当前 WiFi 的名字。请确认已授权定位权限、系统定位开关已打开，并已连上目标网络。');
        return;
      }
      addSsid(ssid);
      setMessage(`已加入「${ssid}」。`);
    } catch (error) {
      setMessage(`读取当前 WiFi 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const addCurrentPlace = async () => {
    setBusy('locate');
    setMessage(null);
    try {
      const permission = await bleLink.requestLocationPermission();
      if (!permission.granted) {
        setMessage('缺少定位权限，无法记录坐标。');
        return;
      }
      if (!permission.locationEnabled) {
        setMessage('系统定位开关是关的，无法记录坐标。');
        return;
      }
      const fix = await bleLink.currentLocation(30_000, 8_000);
      if (!fix) {
        setMessage('这次没取到坐标，请到室外或靠窗的地方再试。');
        return;
      }
      const place: SuppressionPlace = {
        id: `p${Date.now()}`,
        name: '',
        lat: fix.lat,
        lon: fix.lon,
        radiusM: 100,
      };
      setDraft((current) => ({ ...current, places: [...current.places, place] }));
      setMessage('已记录当前坐标，给它起个名字，并确认半径。');
    } catch (error) {
      setMessage(`取坐标失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const removeSsid = (name: string) => {
    setDraft((current) => ({ ...current, wifiSsids: current.wifiSsids.filter((s) => s !== name) }));
  };

  const removePlace = (id: string) => {
    setDraft((current) => ({ ...current, places: current.places.filter((p) => p.id !== id) }));
  };

  const updatePlace = (id: string, patch: Partial<SuppressionPlace>) => {
    setDraft((current) => ({
      ...current,
      places: current.places.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="justify-end bg-black/45" style={[themeVars(scheme), { flex: 1 }]}>
        <View className="bg-surface-container-lowest rounded-t-[28px] overflow-hidden" style={[themeVars(scheme), plateShadow]}>
          <View className="w-full pt-3 pb-1 items-center justify-center">
            <View className="w-9 h-1 rounded-full bg-surface-container-highest" />
          </View>
          <View className="px-5 pt-3 pb-2 flex-row items-center justify-between">
            <Text className="text-[20px] font-headline font-semibold text-on-surface tracking-tight">
              哪些情况不自动解闭锁
            </Text>
            <Pressable onPress={onCancel} accessibilityLabel="关闭" className="w-9 h-9 rounded-full bg-inset items-center justify-center active:scale-95">
              <Text className="text-[20px] font-icon text-on-surface">{Icon.close}</Text>
            </Pressable>
          </View>

          <View className="px-5 pb-5 gap-4">
            <Text className="text-[12px] font-body text-on-surface-variant leading-relaxed">
              满足这里任意一条时，靠近车辆也不解锁、不上锁。名单为空则一切照旧。
            </Text>

            {/* ── WiFi ── */}
            <View className="rounded-2xl bg-inset p-4 gap-3">
              <View className="flex-row items-center gap-2">
                <Text className="text-[16px] font-icon text-on-surface">{Icon.hub}</Text>
                <Text className="text-[14px] font-headline font-semibold text-on-surface">连到这些 WiFi 时</Text>
              </View>
              {draft.wifiSsids.length === 0 ? (
                <Text className="text-[12px] font-body text-on-surface-variant">还没有添加任何网络。</Text>
              ) : (
                <View className="gap-2">
                  {draft.wifiSsids.map((name) => (
                    <View key={name} className="flex-row items-center justify-between rounded-xl bg-surface px-3 py-2.5">
                      <Text className="flex-1 text-[13px] font-body text-on-surface" numberOfLines={1}>{name}</Text>
                      <Pressable onPress={() => removeSsid(name)} accessibilityLabel={`删除 ${name}`} className="active:scale-95 pl-2">
                        <Text className="text-[16px] font-icon text-on-surface-variant">{Icon.cancel}</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}
              <View className="flex-row items-center gap-2">
                <TextInput
                  value={ssidInput}
                  onChangeText={setSsidInput}
                  placeholder="输入 WiFi 名字"
                  placeholderTextColor="#8a8f98"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="flex-1 h-[42px] rounded-full bg-surface px-4 text-[13px] font-body text-on-surface"
                  onSubmitEditing={() => { addSsid(ssidInput); setSsidInput(''); }}
                  returnKeyType="done"
                />
                <Pressable
                  onPress={() => { addSsid(ssidInput); setSsidInput(''); }}
                  disabled={ssidInput.trim() === ''}
                  className="h-[42px] px-4 rounded-full bg-primary-container items-center justify-center active:scale-95"
                  style={ssidInput.trim() === '' ? { opacity: 0.5 } : undefined}>
                  <Text className="text-[13px] font-headline font-semibold text-on-primary-fixed">添加</Text>
                </Pressable>
              </View>
              <Pressable onPress={addCurrentSsid} disabled={busy !== null} className="flex-row items-center gap-2 active:scale-95">
                {busy === 'ssid' ? (
                  <SpinnerIcon size={14} className="text-primary" />
                ) : (
                  <Text className="text-[14px] font-icon text-primary">{Icon.add}</Text>
                )}
                <Text className="text-[12px] font-headline font-semibold text-primary">加入当前连着的 WiFi</Text>
              </Pressable>
            </View>

            {/* ── 坐标 ── */}
            <View className="rounded-2xl bg-inset p-4 gap-3">
              <View className="flex-row items-center gap-2">
                <Text className="text-[16px] font-icon text-on-surface">{Icon.location_on}</Text>
                <Text className="text-[14px] font-headline font-semibold text-on-surface">在这个地点附近时</Text>
              </View>
              {draft.places.length === 0 ? (
                <Text className="text-[12px] font-body text-on-surface-variant">还没有记录任何地点。</Text>
              ) : (
                <View className="gap-3">
                  {draft.places.map((place) => (
                    <PlaceRow
                      key={place.id}
                      place={place}
                      onChange={(patch) => updatePlace(place.id, patch)}
                      onRemove={() => removePlace(place.id)}
                    />
                  ))}
                </View>
              )}
              <Pressable onPress={addCurrentPlace} disabled={busy !== null} className="flex-row items-center gap-2 active:scale-95">
                {busy === 'locate' ? (
                  <SpinnerIcon size={14} className="text-primary" />
                ) : (
                  <Text className="text-[14px] font-icon text-primary">{Icon.gps_fixed}</Text>
                )}
                <Text className="text-[12px] font-headline font-semibold text-primary">记录当前坐标</Text>
              </Pressable>
            </View>

            {message ? (
              <Text className="text-[12px] font-body text-on-surface-variant leading-relaxed">{message}</Text>
            ) : null}

            <Pressable
              onPress={() => onSave(parseSuppression(JSON.stringify(draft)))}
              className="w-full h-[50px] rounded-full bg-primary-container items-center justify-center active:scale-95"
              style={plateShadow}>
              <Text className="text-[15px] font-headline font-semibold text-on-primary-fixed">保存</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** 一个地点的名字与半径：都能就地改，改完随「保存」一起落盘。 */
function PlaceRow({
  place,
  onChange,
  onRemove,
}: {
  place: SuppressionPlace;
  onChange: (patch: Partial<SuppressionPlace>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <View className="rounded-xl bg-surface px-3 py-3 gap-2">
      <View className="flex-row items-center gap-2">
        <TextInput
          value={place.name}
          onChangeText={(name) => onChange({ name })}
          placeholder="给这个地点起个名字"
          placeholderTextColor="#8a8f98"
          className="flex-1 h-[38px] rounded-full bg-inset px-3.5 text-[13px] font-body text-on-surface"
        />
        <Pressable onPress={onRemove} accessibilityLabel="删除这个地点" className="active:scale-95 pl-1">
          <Text className="text-[16px] font-icon text-on-surface-variant">{Icon.cancel}</Text>
        </Pressable>
      </View>
      <View className="flex-row items-center gap-2">
        <Text className="text-[12px] font-body text-on-surface-variant">半径</Text>
        <TextInput
          value={String(place.radiusM)}
          onChangeText={(raw) => {
            const n = Number(raw.replace(/[^0-9]/g, ''));
            onChange({ radiusM: Number.isFinite(n) ? n : 0 });
          }}
          keyboardType="number-pad"
          className="w-[72px] h-[34px] rounded-full bg-inset px-3 text-[13px] font-body text-on-surface text-center"
        />
        <Text className="text-[12px] font-body text-on-surface-variant">米内不解锁</Text>
        <Text className="flex-1 text-right text-[11px] font-mono text-outline">
          {`${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`}
        </Text>
      </View>
    </View>
  );
}