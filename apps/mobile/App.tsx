/**
 * 应用外壳：登录态路由 + 三个标签页（车控 / 状态 / 设置）。
 *
 * 没有引 react-navigation：只有「登录 / 三个平级标签」这一层结构，用 useState
 * 切换即可，省掉一整套导航容器。快捷指令配置存在原生 SharedPreferences 里。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UserProfile, Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import { vehicleModelLabel } from '@xpeng/protocol/src/vehicle-model';
import { COMMANDS } from '@xpeng/protocol/src/commands';
import { carLink, type LinkState } from './src/core/car';
import { publishWidgetSnapshot } from './src/core/widget-bridge';
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
import { ProximitySuppressionSheet } from './src/ui/screens/ProximitySuppressionSheet';
import { ProximityCalibrationSheet } from './src/ui/screens/ProximityCalibrationSheet';
import { parseCalibration } from '@xpeng/protocol/src/proximity-calibration';
import { DEFAULT_SUPPRESSION, parseSuppression, serializeSuppression, type ProximitySuppression } from '@xpeng/protocol/src/proximity-suppression';

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
  /**
   * 数字钥匙材料是否已取到（`contextState.kind === 'ready'`）。
   *
   * 与 `bluetoothReady`（`phase === 'ready'`）不同：退避重连期间 phase 变成
   * `backoff`，但材料仍在手、mac 也记着，靠近标定照样能跑。拿 phase 当判据会把
   * 「人在车边刚被踢掉连接」这种最常见的情形误判成不可标定。
   */
  const [materialsReady, setMaterialsReady] = useState(false);
  const [quickCommands, setQuickCommands] = useState<readonly CustomCommandId[]>(DEFAULT_CUSTOM_COMMAND_IDS);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [remoteViewVisible, setRemoteViewVisible] = useState(false);
  const [summonVisible, setSummonVisible] = useState(false);
  const [chargerVisible, setChargerVisible] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [theme, setTheme, scheme] = useThemeMode();
  const [proximityEnabled, setProximityEnabled] = useState(false);
  const [verboseLog, setVerboseLog] = useState(false);
  // subscribeStatus 的回调建在只依赖 accessToken 的 effect 里，闭包里读 state 会永远
  // 停在初始值 false（实测 11-24 全天 0 条 vehicle-state 就是这个原因，虽然后来
  // bleLink.setVerboseLog 生效了、sample 有写，但这条诊断行一直是哑的）。
  const verboseLogRef = useRef(false);
  const [calibrationVisible, setCalibrationVisible] = useState(false);
  const [suppression, setSuppression] = useState<ProximitySuppression>(DEFAULT_SUPPRESSION);
  const [suppressionVisible, setSuppressionVisible] = useState(false);
  const [thresholds, setThresholds] = useState(bleLink.currentThresholds());
  /**
   * 站位对照采样的当前状态（临时取证用，非功能路径）。
   *
   * 它存在的唯一目的：判定「保持 GATT 连接时能不能用连接态 RSSI 判距」。车端在已有
   * 连接时不广播，两条测量路径物理互斥，`measureStation` 会先后跑完再恢复原状。
   */
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
    // 阈值：标定入口已移除，但此前存下的标定值仍然生效（不必强制重新标定）。
    native.storageGet(StorageKey.proximityCalibration).then((raw) => {
      bleLink.applyCalibration(parseCalibration(raw));
      setThresholds(bleLink.currentThresholds());
    }).catch(() => {});
    // 例外名单要在判距动作能触发之前就装进运行时，否则冷启动后第一次靠近会按"无例外"执行。
    native.storageGet(StorageKey.proximitySuppression).then((raw) => {
      const rules = parseSuppression(raw);
      bleLink.setSuppression(rules);
      setSuppression(rules);
    }).catch(() => {});
    native.storageGet(StorageKey.proximity).then((saved) => {
      if (saved !== '1') return;
      setProximityEnabled(true);
      // 决策函数自己会看前后台：前台开开关也不会起扫描（车端连上就不广播）。
      void bleLink.setProximityEnabled(true).catch(() => {});
    }).catch(() => {});
    // 自动闭锁的云端兜底：BLE 发不出去的锁车改走云端 MQTT（service_type 9 / cmd_type 1）。
    // 闭锁天然发生在人已走远、蓝牙已断的时刻，没有这条退路就会像 2026-11-20 那样锁不上。
    bleLink.setCloudLockFallback(async () => {
      const def = COMMANDS.find((c) => c.id === 'door.lock');
      if (!def) return false;
      const r = await carLink.send(def);
      return r.ok;
    });
    // 车辆状态续期：车速/驾驶位/车锁只在变化时推送，车停稳后就不再推。
    // 不主动补拉，解闭锁的两个否决门控会在保质期后自动失效——2026-11-24 等红灯
    // 90 秒后座椅状态过期、在车内自动解锁 4 次，就是这条缺失的直接后果；
    // 同一天离车后连续 7 次云端闭锁、22 秒内连解 4 次，也是车锁缓存没有续期。
    bleLink.setVehicleStateRefresher(async () => {
      await carLink.readStatus().catch(() => {});
    });
    // 详细日志开关：重启后要恢复，否则用户以为还开着、实际已经回到只记关键事件。
    native.storageGet(StorageKey.proximityVerboseLog).then((saved) => {
      const on = saved === '1';
      verboseLogRef.current = on;
      setVerboseLog(on);
      bleLink.setVerboseLog(on);
    }).catch(() => {});
    return bleLink.subscribe((state) => {
      setBluetoothReady(state.phase === 'ready');
      // `connected` 才是 GATT 链路真实状态（ble.ts 的 uiState 只在
      // authenticating/authenticated/command 三个活跃阶段置 true）。
      setBluetoothConnected(state.connected);
      setMaterialsReady(bleLink.contextState.kind === 'ready');
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
      // 车速与挡位等车辆状态从这里取；车坐标不再参与判距或扫描决策。
      const drive = s?.interval?.drive;
      // 行驶状态：只看 speed 是否大于 0，不解读单位（任何单位下 0 都是静止）。
      const speed = drive?.speed;
      const n = typeof speed === 'number' ? speed : Number.parseFloat(String(speed ?? ''));
      bleLink.setVehicleMoving(Number.isFinite(n) ? n > 0 : null);
      // 车锁状态：driver_door_lock_st 为 1 表示已锁。它用来校准判距器的「是否解锁」，
      // 使解闭锁失败后状态不会被卡错（失败时车锁没变，下一轮校准拉回真值）。
      const lockState = s?.instant?.door?.driver_door_lock_st;
      bleLink.setVehicleLocked(typeof lockState === 'number' ? lockState === 1 : null);
      // 驾驶位是否有人：用来区分「等红灯」与「走回车旁」。两者车速都归零、车都锁着、
      // 车内信号都很强，唯一差别就是驾驶位有没有人（2026-11-23 等红灯误解锁实测）。
      const seatState = s?.instant?.seat?.driver_seat_state;
      bleLink.setVehicleSeated(typeof seatState === 'number' ? seatState === 1 : null);
      // 车辆状态快照：只在详细日志打开时落盘。
      // 已确认 driver_seat_state=1 表示驾驶位有人（2026-11-19 上下车实测），
      // 保留这些字段便于事后判断"当时车是什么状态"。
      if (verboseLogRef.current) {
        const seat = s?.instant?.seat;
        const power = s?.instant?.power;
        void bleLink.logUserAction(
          `vehicle-state driver_seat=${seat?.driver_seat_state} ` +
          `power_state=${power?.car_power_state} igon=${power?.car_igon_state} ` +
          `shift=${s?.instant?.drive?.shift_state} ` +
          `lock=${s?.instant?.door?.driver_door_lock_st} speed=${speed}`,
        );
      }
      // 2x4 组件要显示的电量与续航：每次拿到新状态就落一份快照并让桌面重画。
      // 组件的 updatePeriodMillis 是 0（系统最短 30 分钟、不够用），只能靠这里推。
      void publishWidgetSnapshot(s).catch(() => {});
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

  /**
   * 前后台分工（用户已确认）：前台保持连接，退到后台释放连接、只跑扫描。
   * AppState 是唯一可靠的前后台信号；息屏时 RN 定时器会停，这里只做一次性切换。
   */
  useEffect(() => {
    void bleLink.setForeground(true);
    const sub = AppState.addEventListener('change', (next) => {
      // 前后台切换是解锁快慢的关键变量（前台不扫、后台才扫），必须落盘。
      bleLink.logUserAction(`appstate ${next}`);
      void bleLink.setForeground(next === 'active');
      // 系统会在进后台后掐断 MQTT 长连接（断开原因实测是 socket 的
      // "software caused connection abort"）。后台期间没有重连时机，回到前台
      // 必须补一次，否则用户看到的是「连接断开」而所有云端车控都发不出去。
      if (next === 'active') void carLink.resume();
    });
    return () => sub.remove();
  }, []);

  const toggleProximity = (enabled: boolean) => {
    // 手动操作必须落盘：排查「功能为什么会关着」时，只有记录能证明是谁在什么时候关的。
    void bleLink.logUserAction(`toggle proximity=${enabled}`);
    setProximityEnabled(enabled);
    native.storageSet(StorageKey.proximity, enabled ? '1' : '0').catch(() => {});
    void bleLink.setProximityEnabled(enabled).catch((error) => {
      console.warn('[shell] 靠近自动解闭锁切换失败:', error instanceof Error ? error.message : String(error));
    });
  };

  /**
   * 详细日志开关。落盘到 StorageKey.proximityVerboseLog，重启后保持。
   * 打开后每轮 RSSI 与状态切换都会写进日志文件（外部私有目录，adb pull 可取）。
   */
  const changeVerboseLog = (enabled: boolean) => {
    setVerboseLog(enabled);
    bleLink.setVerboseLog(enabled);
    native.storageSet(StorageKey.proximityVerboseLog, enabled ? '1' : '0').catch(() => {});
  };

  const saveSuppression = (rules: ProximitySuppression) => {
    bleLink.setSuppression(rules);
    setSuppression(rules);
    setSuppressionVisible(false);
    native.storageSet(StorageKey.proximitySuppression, serializeSuppression(rules)).catch(() => {});
  };

  const suppressionSummary = (() => {
    const wifi = suppression.wifiSsids.length;
    const places = suppression.places.length;
    if (wifi === 0 && places === 0) return '未设置例外，任何 WiFi 与地点都会触发。';
    if (wifi > 0 && places > 0) return `已在 ${wifi} 个 WiFi、${places} 个地点附近停用。`;
    if (wifi > 0) return `已在 ${wifi} 个 WiFi 下停用。`;
    return `已在 ${places} 个地点附近停用。`;
  })();

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
  const modelName = (vehicle && vehicleModelLabel(vehicle)) || '—';
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

      {link === 'offline' && linkReason && vehicle ? (
        <Banner
          tone="error"
          text={`连接断开：${linkReason}`}
          tag="RETRY"
          onRetry={() => {
            void carLink.connect(vehicle.vin, session.session.uid);
          }}
        />
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
            proximityEnabled={proximityEnabled}
            onProximityChange={toggleProximity}
            thresholds={thresholds}

            bluetoothReady={materialsReady}
            onUnsupported={setUnsupported}
            suppressionSummary={suppressionSummary}
            onEditSuppression={() => setSuppressionVisible(true)}
            verboseLog={verboseLog}
            onVerboseLogChange={changeVerboseLog}
            onRecalibrate={() => setCalibrationVisible(true)}
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
        onChargingSettled={() => {
          // 命令成功后只关弹窗。车辆数据仍由 MQTT 订阅推送驱动，不强制查询：
          // 主动 readStatus 会让车端先推一条查询前的旧快照，再回本次查询的完整回执，
          // 界面会先对后错地翻一次（实测「启动充电后迟迟不变为充电中，重启才正常」）。
          setChargerVisible(false);
        }}
      />
      <ProximityCalibrationSheet
        visible={calibrationVisible}
        current={{ nearRssi: thresholds.nearRssi, farRssi: thresholds.farRssi }}
        onCancel={() => setCalibrationVisible(false)}
        onConfirmed={(calibration) => {
          bleLink.applyCalibration(calibration);
          native.storageSet(StorageKey.proximityCalibration, bleLink.serializeCalibration(calibration)).catch(() => {});
          setThresholds(bleLink.currentThresholds());
          setCalibrationVisible(false);
        }}
      />
      <ProximitySuppressionSheet
        visible={suppressionVisible}
        rules={suppression}
        onCancel={() => setSuppressionVisible(false)}
        onSave={saveSuppression}
      />
    </View>
  );
}
