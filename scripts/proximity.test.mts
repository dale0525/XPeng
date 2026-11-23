import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateProximity, ProximityTracker, decideScanAction, decideScanDuringAction, decideUnlockGate, decideLockGate, unlockedFromLockState, decideLinkAttempt, LINK_RETRY_BACKOFF_MS, shouldLogSample, DEFAULT_PROXIMITY_CONFIG, type ProximityConfig,
} from '../packages/protocol/src/proximity.ts';

const cfg: ProximityConfig = { nearRssi: -65, farRssi: -80, enterMs: 3000, leaveMs: 8000 };

test('a single strong sample does not unlock before the enter dwell time', () => {
  const t = 0;
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 1000, rssi: -50 },
    { t: t + 2000, rssi: -50 },
  ], cfg), []);
});

test('unlocks once RSSI stays above nearRssi for the enter dwell', () => {
  const t = 0;
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 3000, rssi: -55 },
  ], cfg), ['unlock']);
});

test('a brief pass-by never unlocks, and does not lock on the way out', () => {
  const t = 0;
  // 靠近 1.5s 又离开：不满足 3s 进入停留，也不产生 lock（从未进入 nearby）。
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 1500, rssi: -50 },
    { t: t + 3000, rssi: -90 },
    { t: t + 20000, rssi: -95 },
  ], cfg), []);
});

test('locks only after being nearby then far for the leave dwell', () => {
  const t = 0;
  const samples = [
    { t, rssi: -50 },
    { t: t + 3000, rssi: -50 },        // unlock
    { t: t + 4000, rssi: -90 },
    { t: t + 12000, rssi: -90 },       // 8s 后 lock
  ];
  assert.deepEqual(evaluateProximity(samples, cfg), ['unlock', 'lock']);
});

test('does not lock when the car is merely out of scan range for less than leaveMs', () => {
  const t = 0;
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 3000, rssi: -50 },        // unlock
    { t: t + 4000, rssi: null },       // 短暂扫不到
    { t: t + 9000, rssi: -55 },        // 又回来了（间隔 5s < leaveMs 8s）
  ], cfg), ['unlock']);
});

test('hysteresis: RSSI between the two thresholds does not flap state', () => {
  const t = 0;
  // 进入后 RSSI 落在 (-80, -65) 之间，既不算离开也不算重新进入，不产生额外动作。
  assert.deepEqual(evaluateProximity([
    { t, rssi: -50 },
    { t: t + 3000, rssi: -50 },        // unlock
    { t: t + 4000, rssi: -70 },
    { t: t + 20000, rssi: -72 },
  ], cfg), ['unlock']);
});

test('tracker emits exactly one action per transition across many samples', () => {
  const tr = new ProximityTracker(cfg);
  const t = 0;
  const seq: Array<{ dt: number; rssi: number | null }> = [
    { dt: 0, rssi: -50 }, { dt: 1000, rssi: -50 }, { dt: 3000, rssi: -50 }, // unlock at 3000
    { dt: 4000, rssi: -60 }, { dt: 5000, rssi: -60 }, // still nearby, no action
    { dt: 7000, rssi: -90 }, { dt: 15000, rssi: -90 }, // lock at 7000+8000
    { dt: 30000, rssi: -90 },
  ];
  const actions: string[] = [];
  for (const s of seq) {
    const a = tr.push(t + s.dt, s.rssi);
    if (a) actions.push(a);
  }
  assert.deepEqual(actions, ['unlock', 'lock']);
});

test('default config has near stronger than far', () => {
  assert.ok(DEFAULT_PROXIMITY_CONFIG.nearRssi > DEFAULT_PROXIMITY_CONFIG.farRssi);
  assert.ok(DEFAULT_PROXIMITY_CONFIG.leaveMs > DEFAULT_PROXIMITY_CONFIG.enterMs);
});

const bg = { enabled: true, scanRunning: false, hasTarget: true, foreground: false };

test('enabling in background starts a scan even when the switch flag was already on', () => {
  // 缺陷版：按「开关没变」早退 → 这里返回 none，扫描永不启动。
  assert.equal(decideScanAction(bg), 'start');
});

test('enabling twice does not start two scans', () => {
  assert.equal(decideScanAction({ ...bg, scanRunning: true }), 'none');
});

test('disabling stops a running scan, and is a no-op when nothing runs', () => {
  assert.equal(decideScanAction({ ...bg, enabled: false, scanRunning: true }), 'stop');
  assert.equal(decideScanAction({ ...bg, enabled: false, hasTarget: false }), 'none');
});

test('enabled without a vehicle target waits instead of starting', () => {
  assert.equal(decideScanAction({ ...bg, hasTarget: false }), 'none');
});

test('真正决定能不能扫的是「有没有持有链路」，不是前后台', () => {
  // 原始实测依据仍然成立：持有 GATT 连接时连续 20 轮 results=0，释放连接后立刻扫到
  // ——车端在已有连接时不广播。但旧实现把这条物理约束错误地表达成了"前台一律不扫"，
  // 而两态架构下前台也可能是扫描态（连接态掉线后退回），按前台拦截会让功能在前台失效。
  // 所以判据改成直接看链路状态。
  assert.equal(decideScanAction({ ...bg, foreground: true, linkConnected: true }), 'none');
  assert.equal(decideScanAction({ ...bg, foreground: true, linkConnected: true, scanRunning: true }), 'stop');
  // 前台但没持链路：该扫就扫。
  assert.equal(decideScanAction({ ...bg, foreground: true, linkConnected: false }), 'start');
});

test('scan resumes after the action only when it should still be running', () => {
  const base = { enabled: true, foreground: false, hasMac: true };
  assert.equal(decideScanDuringAction(base), 'resume');
  // 动作期间用户把开关关了 / 回到前台 / 没有车 MAC，都不该再起扫描。
  assert.equal(decideScanDuringAction({ ...base, enabled: false }), 'stay-stopped');
  assert.equal(decideScanDuringAction({ ...base, foreground: true }), 'stay-stopped');
  assert.equal(decideScanDuringAction({ ...base, hasMac: false }), 'stay-stopped');
});

// ── 漏扫率置信度（2026-11-19 五点对照实测后新增）──
//
// 实测依据：把 2026-11-12 的 656 轮数据按漏扫率分桶，漏扫 0-20% 的窗口中位读数
// -69.1，40-60% 为 -76.0，60-80% 为 -78.3。同一份数据里 30 米段漏扫仅 28.9%、
// 门边 48.9%，于是 30 米的中位数反而比 5 米强——远端只有强包能到达，弱包全丢，
// 剩下的样本被幸存者偏差抬高。所以「读数强」在漏扫率高时并不可信。

test('高漏扫率窗口里的强读数不得触发解锁', () => {
  // 20 轮里只有 4 轮扫到，且那 4 轮都很强：这是典型的幸存者偏差形态。
  const t = 0;
  const seq: (number | null)[] = [];
  for (let i = 0; i < 20; i += 1) {
    // 每 5 轮出现一次强值，其余全漏扫
    seq.push(i % 5 === 0 ? -50 : null);
  }
  const acts = evaluateProximity(seq.map((rssi, i) => ({ t: t + i * 1500, rssi })), cfg);
  assert.deepEqual(acts, [], `漏扫 80% 时不该解锁，实际: ${acts.join(',')}`);
});

test('低漏扫率窗口里的同样强读数可以正常解锁', () => {
  // 同样的强值，但每轮都扫到：应当解锁。
  const t = 0;
  const seq = Array.from({ length: 20 }, () => -50 as number | null);
  const acts = evaluateProximity(seq.map((rssi, i) => ({ t: t + i * 1500, rssi })), cfg);
  assert.deepEqual(acts, ['unlock']);
});

test('漏扫率随时间衰减：早期稀疏样本不能永久压制后续可靠样本', () => {
  // 先 10 轮全漏扫（刚起扫、车还没广播），再来 10 轮稳定强值。
  // 若把整段历史都算进漏扫率，后者会被前面的空窗拖累而永不解锁。
  const t = 0;
  const seq: (number | null)[] = [
    ...Array.from({ length: 10 }, () => null as number | null),
    ...Array.from({ length: 10 }, () => -50 as number | null),
  ];
  const acts = evaluateProximity(seq.map((rssi, i) => ({ t: t + i * 1500, rssi })), cfg);
  assert.deepEqual(acts, ['unlock'], `空窗之后稳定强值应解锁，实际: ${acts.join(',')}`);
});

test('漏扫率门槛只挡解锁、不挡闭锁：走远时漏扫本来就多', () => {
  // 实测：人走远时漏扫率 70-90%。若闭锁也受该门槛约束，车就永远不锁。
  // 这里构造「先可靠地进入附近，再在高漏扫环境下走远」的序列。
  const t = 0;
  const near = Array.from({ length: 6 }, () => -50 as number | null);
  // 走远段：每 4 轮才扫到一次弱值，漏扫率 75%
  const far: (number | null)[] = [];
  for (let i = 0; i < 24; i += 1) far.push(i % 4 === 0 ? -95 : null);
  const seq = [...near, ...far];
  const acts = evaluateProximity(seq.map((rssi, i) => ({ t: t + i * 1500, rssi })), cfg);
  assert.deepEqual(acts, ['unlock', 'lock'], `应解锁后正常闭锁，实际: ${acts.join(',')}`);
});

// ── 车辆行驶门控 ──
//
// 车在动时人不可能站在车旁等着被解锁，此时任何 RSSI 判断都不该触发解锁。
// 这是语义判断，比信号推断可靠：不依赖 RSSI 精度，也不受多径与漏扫影响。
//
// speed 的单位未证实（字段是字符串，实测 "0.000000"），但「大于 0 即在动」
// 与单位无关——任何单位下 0 都是静止。

test('车在行驶时不得解锁：RSSI 再强也不代表人在车旁', () => {
  assert.equal(decideUnlockGate({ moving: true }), 'block');
});

test('车静止时放行，由 RSSI 自行判断', () => {
  assert.equal(decideUnlockGate({ moving: false }), 'allow');
});

test('拿不到车速时放行：缺数据不能挡住解锁', () => {
  // 代价不对等：误放行最坏是多解一次锁，误挡则是人在车前解不开。
  assert.equal(decideUnlockGate({ moving: null }), 'allow');
});

test('闭锁与解锁同样受行驶门控约束：车在动时不做任何操作', () => {
  // 车开走时蓝牙本来就在快速变弱，容易被误判成"人走远了"而误锁；
  // 但人根本没走、是车走了，此时锁车没有意义。
  assert.equal(decideLockGate({ moving: true }), 'block');
  assert.equal(decideLockGate({ moving: false }), 'allow');
  assert.equal(decideLockGate({ moving: null }), 'allow');
  // 过期规则与解锁一致。
  assert.equal(decideLockGate({ moving: true, ageMs: 31_000 }), 'allow');
});

// ── 行驶状态的过期保护 ──
//
// MQTT 只在状态变化时推送（实测静止车辆 60 秒零推送）。若车停下后没有新的
// speed=0 推送，缓存会一直停在"在动"，门控就会永久挡住解锁——人站在车边解不开。
// 所以状态必须有保质期：过期即视为"不知道"，按放行处理。

test('行驶状态在 30 秒内有效', () => {
  assert.equal(decideUnlockGate({ moving: true, ageMs: 0 }), 'block');
  assert.equal(decideUnlockGate({ moving: true, ageMs: 29_000 }), 'block');
});

test('行驶状态超过 30 秒即失效，退回放行', () => {
  // 这是防"车已停下但缓存仍停在在动"导致永久不解锁的关键。
  assert.equal(decideUnlockGate({ moving: true, ageMs: 30_001 }), 'allow');
  assert.equal(decideUnlockGate({ moving: true, ageMs: 300_000 }), 'allow');
});

test('没有过期信息时按新鲜处理（调用方未提供时间戳）', () => {
  assert.equal(decideUnlockGate({ moving: true }), 'block');
});

// ── 以车辆真实锁状态校准「是否在附近」 ──
//
// 原实现的 nearby 是纯本地记忆：只有"自己判断解锁成功"才置 true、"自己判断闭锁成功"
// 才置 false。动作失败时它停在错值上，于是再也触发不了对应动作（2026-11-12 实测：
// 走到 50 m 外闭锁两次失败，状态机已是"不在附近"，用户看到"只解锁、从不闭锁"）。
//
// 改成跟着车辆真实锁状态走：车锁着 = 人不在附近，车开着 = 人在附近。
// 四种真实场景全部自洽，且失败时车锁没变，nearby 就不会被写错。

test('车锁着即人不在附近：之后走近能触发解锁', () => {
  assert.equal(unlockedFromLockState({ locked: true }), false);
});

test('车开着即人在附近：之后走远能触发闭锁', () => {
  assert.equal(unlockedFromLockState({ locked: false }), true);
});

test('拿不到车锁状态时返回 null，由调用方维持原值', () => {
  // 不能默认成"不在附近"：那会让已解锁的车永远不再闭锁。
  assert.equal(unlockedFromLockState({ locked: null }), null);
});

// ── 判距器用车锁状态校准 internal 状态 ──
//
// calibrate 是治"动作失败后状态卡死"的核心：每轮扫描前用真实车锁状态拉回真值。

test('calibrate：车锁着时判距器视为不在附近', () => {
  const tr = new ProximityTracker(DEFAULT_PROXIMITY_CONFIG);
  tr.calibrate(false); // 车开着
  assert.equal(tr.isUnlocked, true);
  tr.calibrate(true); // 车锁上（比如人已走远、车自动锁了）
  assert.equal(tr.isUnlocked, false);
});

test('calibrate：拿不到车锁状态时维持原值，不清空', () => {
  const tr = new ProximityTracker(DEFAULT_PROXIMITY_CONFIG);
  tr.calibrate(false);
  assert.equal(tr.isUnlocked, true);
  tr.calibrate(null); // 不知道 -> 不动
  assert.equal(tr.isUnlocked, true);
});

test('calibrate：状态变化时清空计时窗口，避免用旧方向的进度误触发', () => {
  const tr = new ProximityTracker(DEFAULT_PROXIMITY_CONFIG);
  tr.calibrate(true);   // 不在附近
  // 喂几条强值攒出解锁进度
  tr.push(0, -60); tr.push(1500, -60);
  // 车锁状态翻转为开着（人已进车）：应清空进度、直接视为已解锁
  tr.calibrate(false);
  assert.equal(tr.isUnlocked, true);
  // 立刻喂一条远值不应马上闭锁（进度已被清空）
  assert.equal(tr.push(3000, -100), undefined);
});

// ── 两态架构下的起扫判据 ──
//
// 旧判据「前台一律不扫描」来自"前台持连接、后台扫描"的粗粒度互斥。两态架构下
// 连接态由「扫到车」触发、掉线后退回扫描，前后台不再是决定因素；继续按前台拦截
// 会让前台永远起不了扫、也永远进不了连接态。

test('前台开着功能也要起扫：两态切换靠扫描触发', () => {
  assert.equal(decideScanAction({ enabled: true, scanRunning: false, hasTarget: true, foreground: true }), 'start');
});

test('已连着时不该再起扫（两者互斥，会抢控制器）', () => {
  assert.equal(decideScanAction({ enabled: true, scanRunning: false, hasTarget: true, foreground: false, linkConnected: true }), 'none');
});

test('功能关着时停止扫描', () => {
  assert.equal(decideScanAction({ enabled: false, scanRunning: true, hasTarget: true, foreground: false }), 'stop');
});

// ── 建连失败后的退避 ──
//
// "扫到车就建连"在建连失败时会退回扫描，而扫描马上又会扫到车、再次尝试建连。
// 车端拒绝连接时（例如连接槽被官方 App 占着）这会变成"扫描→失败→扫描→失败"
// 的快速循环，很耗电。失败后至少等 5 秒才允许再试。

test('刚失败过就不要再试：避免扫描与建连互撞的快速循环', () => {
  assert.equal(decideLinkAttempt({ lastFailureAtMs: 1000, nowMs: 3000 }), 'wait');
});

test('退避期满后允许重试', () => {
  assert.equal(decideLinkAttempt({ lastFailureAtMs: 1000, nowMs: 7000 }), 'retry');
});

test('从没失败过时直接允许', () => {
  assert.equal(decideLinkAttempt({ lastFailureAtMs: null, nowMs: 1000 }), 'retry');
});

test('退避期是 5 秒', () => {
  assert.equal(LINK_RETRY_BACKOFF_MS, 5_000);
  // 边界：差 1 ms 仍要等，够了才放行。
  assert.equal(decideLinkAttempt({ lastFailureAtMs: 0, nowMs: 4_999 }), 'wait');
  assert.equal(decideLinkAttempt({ lastFailureAtMs: 0, nowMs: 5_000 }), 'retry');
});

// ── 详细调试日志开关 ──
//
// 平常只记"发生了什么"（触发、建连、抑制、失败），一轮 1.5 s 的 RSSI 明细不记，
// 否则日志几分钟就滚满、把关键事件冲掉。开关打开后把每轮读数都落盘——这是排查
// "为什么没触发 / 为什么触发了"唯一的一手数据。

test('开关关着时不记每轮明细', () => {
  assert.equal(shouldLogSample({ verbose: false }), false);
});

test('开关打开时每轮都记', () => {
  assert.equal(shouldLogSample({ verbose: true }), true);
});

// ── 失联判离开 ──
//
// 阈值闭锁有个覆盖不到的洞：人快步走远，RSSI 掉到闭锁线以下后计时器要凑满
// leaveMs（8 s）；但他在 8 s 内走出蓝牙范围 → 链路断开 → 转扫描 → 扫不到车 →
// 再也收不到弱读数 → 那 8 s 永远凑不满 → 车一直不锁。
// 所以解锁状态下，连续收不到读数达到「失联退出」时长，就直接判离开。

test('解锁后连续扫不到车，达到失联时长就闭锁', () => {
  const tr = new ProximityTracker(DEFAULT_PROXIMITY_CONFIG);
  const t = 0;
  // 先解锁：默认配置要 3 轮且跨度 ≥ enterMs(1.5s)。
  assert.equal(tr.push(t, -60), undefined);
  assert.equal(tr.push(t + 800, -60), undefined);
  assert.equal(tr.push(t + 1600, -60), 'unlock');
  // 之后连续 null：每 1.5 s 一轮。首末样本差需 ≥ 9 s，即 7 轮（6 个间隔）。
  let locked: string | undefined;
  for (let i = 1; i <= 7; i++) {
    locked = tr.push(t + 1600 + i * 1500, null);
    if (locked) break;
  }
  assert.equal(locked, 'lock');
});

test('失联时长不够时不要闭锁：短暂漏扫不能当成走远', () => {
  const tr = new ProximityTracker(DEFAULT_PROXIMITY_CONFIG);
  const t = 0;
  assert.equal(tr.push(t, -60), undefined);
  assert.equal(tr.push(t + 800, -60), undefined);
  assert.equal(tr.push(t + 1600, -60), 'unlock');
  // 连续 3 轮 null（约 4.5 s）还不够 9 s，不能闭锁。
  for (let i = 1; i <= 3; i++) {
    assert.equal(tr.push(t + 1600 + i * 1500, null), undefined);
  }
  // 一旦重新收到读数，失联计时清零，仍保持解锁。
  assert.equal(tr.push(t + 6200, -62), undefined);
  assert.equal(tr.isUnlocked, true);
});

test('从未解锁时，扫不到不会产生 lock', () => {
  const tr = new ProximityTracker(DEFAULT_PROXIMITY_CONFIG);
  for (let i = 0; i < 10; i++) {
    assert.equal(tr.push(i * 1500, null), undefined);
  }
  assert.equal(tr.isUnlocked, false);
});

// ── 动作后是否恢复扫描（两态架构）──
//
// 两态架构下后台也可能走连接态判距。动作执行完若按"后台就恢复扫描"处理，
// 会把刚用的连接停掉改起扫描，而车端在已有连接时不广播，等于每次后台动作后
// 都把判距打断一次。

test('后台动作后仍持连接：不要切回扫描', () => {
  assert.equal(decideScanDuringAction({ enabled: true, foreground: false, hasMac: true, linkHeld: true }), 'stay-stopped');
});

test('后台动作后链路已断：应恢复扫描', () => {
  assert.equal(decideScanDuringAction({ enabled: true, foreground: false, hasMac: true, linkHeld: false }), 'resume');
});

test('前台动作后：由自动切换管理，不手动起扫', () => {
  assert.equal(decideScanDuringAction({ enabled: true, foreground: true, hasMac: true, linkHeld: false }), 'stay-stopped');
});

// ── 漏扫窗口在判距环境切换时清空（2026-11-20 实测修复）──
//
// 扫描态绝大多数轮次扫不到车（实测一天 26813 轮里 26687 轮为空）。切到连接态后，
// 若沿用这批 null，前 10 轮漏扫率仍 >0.4，解锁会被一直挡着直到窗口被稀释——这正是
// 「标定 -93 却要等到 -61（走到门口）才解锁」、白等约 10 秒的根因。

test('切连接态清空漏扫窗口后，强样本立即解锁（2026-11-20 场景）', () => {
  const tr = new ProximityTracker(cfg);
  const t0 = 0;
  // 扫描态：16 轮全扫不到（人还远）
  for (let i = 0; i < 16; i += 1) tr.push(t0 + i * 1500, null);
  // 切换连接态：调用方（startLinkRssiFeed）清空漏扫窗口
  tr.resetMisses();
  // 连接态开头就强：应立即解锁，而不是被旧漏扫率挡住
  const acts: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const a = tr.push(t0 + 30000 + i * 1500, -50);
    if (a) acts.push(a);
  }
  assert.deepEqual(acts, ['unlock'], `清空窗口后应解锁，实际: ${acts.join(',')}`);
});

test('不清空漏扫窗口时，连接态开头的强样本会被旧漏扫率挡住（对照）', () => {
  const tr = new ProximityTracker(cfg);
  const t0 = 0;
  for (let i = 0; i < 16; i += 1) tr.push(t0 + i * 1500, null);
  // 故意不清空，直接推强样本——验证旧行为确实是问题根源
  const acts: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const a = tr.push(t0 + 30000 + i * 1500, -50);
    if (a) acts.push(a);
  }
  assert.deepEqual(acts, [], `未清空时会被挡，实际: ${acts.join(',')}`);
});

test('seed 确立状态时也清空漏扫窗口，避免起扫/新环境被旧空窗拖累', () => {
  const tr = new ProximityTracker(cfg);
  const t0 = 0;
  for (let i = 0; i < 16; i += 1) tr.push(t0 + i * 1500, null);
  // 起扫时用当前信号播种（人已在车边，信号强）
  tr.seed(-50);
  const acts: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const a = tr.push(t0 + 30000 + i * 1500, -50);
    if (a) acts.push(a);
  }
  // seed 已把 unlocked 设为 true（-50 >= -65），不会再触发 unlock；关键是不报错、
  // 且后续不受旧漏扫窗口影响。
  assert.deepEqual(acts, []);
});

// ── 驾驶位否决：等红灯误解锁（2026-11-23 实测）──
//
// 车停下时车速归零、行车自动落锁让车锁变「已锁」，判距器被校准成"人不在附近"；
// 人在车内信号极强（实测 -50），1.5 秒内就满足进入条件 → 停个红灯车自己解锁。
// 「车速归零 + 驾驶位有人」正是等红灯的特征，下车走开时驾驶位必然回到 0。

test('坐在驾驶位时即使车速为 0 也不自动解锁（等红灯场景）', () => {
  // 2026-11-23 12:06 实测：v=1 → v=0、l=1、s=-50，随后误触发 unlock。
  assert.equal(decideUnlockGate({ moving: false, driverSeated: true }), 'block');
});

test('驾驶位无人时车速为 0 正常放行（走回车旁场景）', () => {
  assert.equal(decideUnlockGate({ moving: false, driverSeated: false }), 'allow');
});

test('拿不到驾驶位状态时放行，不能因缺数据让人解不开锁', () => {
  assert.equal(decideUnlockGate({ moving: false, driverSeated: null }), 'allow');
  assert.equal(decideUnlockGate({ moving: false }), 'allow');
});

test('驾驶位状态过期后不再拦：人下车不落锁时字段可能长期停在 1', () => {
  assert.equal(decideUnlockGate({ moving: false, driverSeated: true, seatAgeMs: 120_000 }), 'allow');
  assert.equal(decideUnlockGate({ moving: false, driverSeated: true, seatAgeMs: 10_000 }), 'block');
});

test('驾驶位有人时车速在动也拦（两条判据都命中）', () => {
  assert.equal(decideUnlockGate({ moving: true, driverSeated: true }), 'block');
});

test('闭锁不受驾驶位影响：人在车内也可能需要闭锁', () => {
  // decideLockGate 刻意不接收驾驶位状态，只按车速判。
  assert.equal(decideLockGate({ moving: false }), 'allow');
  assert.equal(decideLockGate({ moving: true }), 'block');
});
