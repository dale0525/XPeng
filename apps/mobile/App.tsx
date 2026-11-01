/**
 * 应用外壳：登录态路由 + 两个标签页（车控 / 设置）。
 *
 * 没有引 react-navigation：只有「登录 / 两个平级标签」这一层结构，用 useState
 * 切换即可，省掉 ~300 KB 依赖和一整套导航容器。
 *
 * 令牌续期在 `sessionStore` 里做：每次业务调用前检查剩余有效期，快到期就先换票；
 * 换票失败会把会话落到 `relogin`，这里负责把提示条和登录页显示出来。
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import { carLink, type LinkState } from './src/core/car';
import { sessionStore, type SessionState } from './src/core/session';
import { themeVars, useThemeMode } from './src/core/theme';
import { useUpdater } from './src/core/update';
import { Banner, BottomNav, TopBar, type TabKey } from './src/ui/components';
import { Icon } from './src/ui/icons';
import { ControlScreen } from './src/ui/screens/Control';
import { LoginScreen } from './src/ui/screens/Login';
import { SettingsScreen } from './src/ui/screens/Settings';

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const insets = useSafeAreaInsets();
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [tab, setTab] = useState<TabKey>('control');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [status, setStatus] = useState<VehicleStatus | null>(null);
  const [link, setLink] = useState<LinkState>('idle');
  const [linkReason, setLinkReason] = useState<string | undefined>();
  const [latency, setLatency] = useState<number | null>(null);
  const [theme, setTheme, scheme] = useThemeMode();
  const updater = useUpdater();

  useEffect(() => {
    const unsub = sessionStore.subscribe(setSession);
    sessionStore.init().catch(() => {});
    return unsub;
  }, []);

  // 登录后：取车辆 → 连 MQTT → 读状态
  useEffect(() => {
    if (session.kind !== 'active') return;
    let alive = true;
    (async () => {
      try {
        // myVehicles 的 data 是 { vehicles: [...] }，不是裸数组
        const data = await sessionStore.call<{ vehicles: Vehicle[] }>(
          '/biz/v5/vehicle/v2/myVehicles',
          {},
        );
        const first = data?.vehicles?.[0];
        if (!alive || !first) return;
        setVehicle(first);
        await carLink.connect(first.vin, session.session.uid);
      } catch (e) {
        // 失败时留在「离线」，用户可在设置页重新连接；原因必须进日志，否则只能猜
        console.warn('[shell] 读取车辆失败:', e instanceof Error ? e.message : String(e));
      }
    })();
    const unsubLink = carLink.subscribe((s, reason) => {
      setLink(s);
      setLinkReason(reason);
    });
    const unsubStatus = carLink.subscribeStatus((s) => {
      setStatus(s);
      // 往返延迟由 readStatus 量出来；订阅时同步一次，否则首次连接后设置页一直显示「— ms」
      setLatency(carLink.latencyMs);
    });
    return () => {
      alive = false;
      unsubLink();
      unsubStatus();
    };
  }, [session.kind === 'active' ? session.session.accessToken : null]);

  const refresh = useMemo(
    () => async () => {
      const t0 = Date.now();
      const s = await carLink.readStatus();
      setLatency(Date.now() - t0);
      if (s) setStatus(s);
    },
    [],
  );

  // 三个分支都要注入主题变量，否则登录页永远是亮色。
  // 必须放进 style 数组：themeVars() 返回的对象靠引用携带变量元数据，展开会丢。
  const themed = themeVars(scheme);

  if (session.kind === 'loading') {
    return (
      <View style={[themed, { flex: 1 }]} className="bg-background items-center justify-center">
        <ActivityIndicator color={scheme === 'dark' ? '#93ccff' : '#006194'} />
      </View>
    );
  }

  if (session.kind === 'anonymous' || session.kind === 'relogin') {
    return (
      <View style={[themed, { flex: 1, paddingTop: insets.top }]} className="bg-background">
        <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
        {session.kind === 'relogin' ? (
          <Banner
            tone="error"
            text={`登录已失效，请重新登录（${session.reason}）`}
            tag="RELOGIN"
          />
        ) : null}
        <LoginScreen />
      </View>
    );
  }

  const title =
    vehicle?.plateNo && vehicle.vehicleTypeName
      ? `${vehicle.plateNo} · ${vehicle.vehicleTypeName}`
      : '小鹏友';

  return (
    <View style={[themed, { flex: 1, paddingTop: insets.top }]} className="bg-background">
      {/* 状态栏图标要与背景反色，否则暗色下看不见 */}
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <TopBar title={title} online={link === 'online'} onRefresh={refresh} />

      {link === 'offline' && linkReason ? (
        <Banner tone="error" text={`连接断开：${linkReason}`} tag="RETRY" />
      ) : null}

      <View className="flex-1">
        {!vehicle ? (
          <View className="flex-1 items-center justify-center gap-2">
            <Text className="text-primary text-[32px] font-icon">{Icon.directions_car}</Text>
            <Text className="text-[14px] text-on-surface-variant">正在读取车辆信息…</Text>
          </View>
        ) : tab === 'control' ? (
          <ControlScreen vehicle={vehicle} status={status} onRefresh={refresh} bottomInset={108 + insets.bottom} />
        ) : (
          <SettingsScreen
            bottomInset={108 + insets.bottom}
            session={session.session}
            vehicle={vehicle}
            linkState={link}
            latencyMs={latency ?? carLink.latencyMs}
            mqttExpireAt={carLink.credentialsExpireAt}
            theme={theme}
            onThemeChange={setTheme}
            onReconnect={() => carLink.connect(vehicle.vin, session.session.uid)}
            onLogout={() => sessionStore.logout()}
            versionName={updater.version?.versionName ?? '—'}
            update={updater.state}
            onCheckUpdate={updater.check}
            onDownload={updater.download}
          />
        )}
      </View>

      <BottomNav active={tab} onChange={setTab} insetBottom={insets.bottom} />
    </View>
  );
}
