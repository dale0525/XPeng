/**
 * 应用外壳：登录态路由 + 三个标签页（车控 / 状态 / 设置）。
 *
 * 没有引 react-navigation：只有「登录 / 三个平级标签」这一层结构，用 useState
 * 切换即可，省掉一整套导航容器。快捷指令配置存在原生 SharedPreferences 里。
 */
import { useEffect, useMemo, useState } from 'react';
import { StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UserProfile, Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import { carLink, type LinkState } from './src/core/car';
import { bleLink } from './src/core/ble';
import { sessionStore, type SessionState } from './src/core/session';
import { themeVars, useThemeMode } from './src/core/theme';
import { useUpdater } from './src/core/update';
import { native, StorageKey } from './src/core/native';
import { DEFAULT_CUSTOM_COMMAND_IDS, parseQuickCommands, type CustomCommandId } from './src/core/quick-commands';
import { Banner, BottomNav, TopBar, type TabKey } from './src/ui/components';
import { SpinnerIcon } from './src/ui/atoms';
import { ControlScreen } from './src/ui/screens/Control';
import { CustomCommandSheet } from './src/ui/screens/CustomCommandSheet';
import { LoginScreen } from './src/ui/screens/Login';
import { SettingsScreen } from './src/ui/screens/Settings';
import { StatusScreen } from './src/ui/screens/Status';
import { RemoteViewSheet } from './src/ui/screens/RemoteViewSheet';
import { StraightSummonSheet } from './src/ui/screens/StraightSummonSheet';
import { ConnectChargerSheet } from './src/ui/screens/ConnectChargerSheet';

const PAGE_TITLE: Record<TabKey, string> = {
  control: '车控',
  status: '状态',
  settings: '设置',
};

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
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [status, setStatus] = useState<VehicleStatus | null>(null);
  const [link, setLink] = useState<LinkState>('idle');
  const [linkReason, setLinkReason] = useState<string | undefined>();
  const [latency, setLatency] = useState<number | null>(null);
  const [bluetoothReady, setBluetoothReady] = useState(false);
  /**
   * 真正有没有活动 GATT 链路。`bluetoothReady` 只表示数字钥匙材料已就绪
   * （`phase === 'ready'`），链路本身并不存在——原生 `write` 在没有 GATT 时以
   * `E_NOT_READY / BLE not subscribed` 拒绝（`XpengBleModule.kt` 的 write 判
   * `gatt == null || writer == null`）。把 ready 当「已连接」显示，等于把
   * 「按下去没有反应」这件事藏起来。
   */
  const [bluetoothConnected, setBluetoothConnected] = useState(false);
  const [quickCommands, setQuickCommands] = useState<readonly CustomCommandId[]>(DEFAULT_CUSTOM_COMMAND_IDS);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [remoteViewVisible, setRemoteViewVisible] = useState(false);
  const [summonVisible, setSummonVisible] = useState(false);
  const [chargerVisible, setChargerVisible] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [theme, setTheme, scheme] = useThemeMode();
  const updater = useUpdater();

  useEffect(() => {
    const unsub = sessionStore.subscribe(setSession);
    sessionStore.init().catch(() => {});
    return unsub;
  }, []);

  useEffect(() => {
    native.storageGet(StorageKey.quickCommands)
      .then((saved) => setQuickCommands(parseQuickCommands(saved)))
      .catch(() => {});
    return bleLink.subscribe((state) => {
      setBluetoothReady(state.phase === 'ready');
      // `connected` 才是 GATT 链路真实状态（ble.ts 的 uiState 只在
      // authenticating/authenticated/command 三个活跃阶段置 true）。
      setBluetoothConnected(state.connected);
    });
  }, []);

  useEffect(() => {
    if (!unsupported) return;
    const timer = setTimeout(() => setUnsupported(null), 2400);
    return () => clearTimeout(timer);
  }, [unsupported]);

  useEffect(() => {
    if (session.kind !== 'active') return;
    let alive = true;
    (async () => {
      try {
        const data = await sessionStore.call<{ vehicles: Vehicle[] }>(
          '/biz/v5/vehicle/v2/myVehicles',
          {},
        );
        const first = data?.vehicles?.[0];
        if (!alive || !first) return;
        setVehicle(first);
        void bleLink.autoPrepareV2(first).catch((error) => {
          console.warn('[shell] BLE V2 准备失败:', error instanceof Error ? error.message : String(error));
        });
        await carLink.connect(first.vin, session.session.uid);
      } catch (e) {
        console.warn('[shell] 读取车辆失败:', e instanceof Error ? e.message : String(e));
      }
      // 当前登录账号本人资料（myVehicles 的 ownerInfo 是车主，不是登录人）。
      try {
        const p = await sessionStore.call<UserProfile>('/resource/app/v3/userinfoMask', {});
        if (alive) setProfile(p);
      } catch (e) {
        console.warn('[shell] 读取账号资料失败:', e instanceof Error ? e.message : String(e));
      }
    })();
    const unsubLink = carLink.subscribe((s, reason) => {
      setLink(s);
      setLinkReason(reason);
    });
    const unsubStatus = carLink.subscribeStatus((s) => {
      setStatus(s);
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

  const saveQuickCommands = (ids: CustomCommandId[]) => {
    setQuickCommands(ids);
    setSheetVisible(false);
    native.storageSet(StorageKey.quickCommands, JSON.stringify(ids)).catch(() => {});
  };

  const themed = themeVars(scheme);

  if (session.kind === 'loading') {
    return (
      <View style={[themed, { flex: 1 }]} className="bg-background items-center justify-center">
        <SpinnerIcon />
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

  const plateNo = vehicle?.plateNo || '—';
  const modelName = vehicle?.vehicleTypeName || '—';
  const vehicleLabel = `车牌 ${plateNo} ｜ 车型 ${modelName}`;

  return (
    <View style={[themed, { flex: 1, paddingTop: insets.top }]} className="bg-background">
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <TopBar
        title={PAGE_TITLE[tab]}
        vehicleLabel={vehicleLabel}
        online={link === 'online'}
        bluetoothState={bluetoothConnected ? 'connected' : bluetoothReady ? 'ready' : 'off'}
        onRefresh={refresh}
      />

      {link === 'offline' && linkReason ? (
        <Banner tone="error" text={`连接断开：${linkReason}`} tag="RETRY" />
      ) : null}
      {unsupported ? (
        <View className="mx-5 mb-2 rounded-box bg-surface-container-highest px-4 py-2.5">
          <Text className="text-[12px] font-body text-on-surface">{`${unsupported} 暂不可用`}</Text>
        </View>
      ) : null}

      <View className="flex-1">
        {!vehicle ? (
          <View className="flex-1 items-center justify-center gap-2">
            <SpinnerIcon />
            <Text className="text-[14px] text-on-surface-variant">正在读取车辆信息…</Text>
          </View>
        ) : tab === 'control' ? (
          <ControlScreen
            vehicle={vehicle}
            status={status}
            onRefresh={refresh}
            bottomInset={108 + insets.bottom}
            quickCommands={quickCommands}
            onCustomize={() => setSheetVisible(true)}
            onUnsupported={setUnsupported}
            onRemoteView={() => setRemoteViewVisible(true)}
            onSummon={() => setSummonVisible(true)}
            onConnectCharger={() => setChargerVisible(true)}
            // 车主判定不能依赖 myVehicles 的 ownerInfo：真机实测该账号
            // ownerInfo 恒为 null（子账号反而有值），拿它比对会把车主本人判成非车主。
            // 用 userinfoMask 的账号类型：车主本人 type=1，被分享子账号 type=4（均实测）。
            isOwner={profile !== null && profile.type === 1}
          />
        ) : tab === 'status' ? (
          <StatusScreen status={status} bottomInset={108 + insets.bottom} />
        ) : (
          <SettingsScreen
            bottomInset={108 + insets.bottom}
            session={session.session}
            vehicle={vehicle}
            profile={profile}
            status={status}
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
      <CustomCommandSheet
        visible={sheetVisible}
        selected={quickCommands}
        onCancel={() => setSheetVisible(false)}
        onSave={saveQuickCommands}
      />
      <RemoteViewSheet
        visible={remoteViewVisible}
        onClose={() => setRemoteViewVisible(false)}
      />
      <StraightSummonSheet
        visible={summonVisible}
        onClose={() => setSummonVisible(false)}
        bluetoothConnected={bluetoothConnected}
      />
      <ConnectChargerSheet
        visible={chargerVisible}
        onClose={() => setChargerVisible(false)}
      />
    </View>
  );
}
