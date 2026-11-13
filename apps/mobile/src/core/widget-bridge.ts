/**
 * 桌面组件与 JS 侧的接口：下发指令、回写读数快照。
 *
 * 组件上的按钮不是打开 App，而是由 `WidgetHeadlessService` 起一个无界面 JS 任务
 * 直接下发——签名、密钥池、MQTT 凭据全在这一侧，原生拿不到。因此这个模块承担两件事：
 *
 * 1. `runWidgetCommand()`：组件点击后的完整下发流程，可脱离界面运行；
 * 2. `publishSnapshot()`：把 MQTT 读到的电量与续航写回，让 2x4 组件重画。
 *
 * 两条路径都复用 `carLink`，不另建一套连接逻辑。
 */
import { carLink } from './car';
import { native, StorageKey, xpLog } from './native';
import { sessionStore } from './session';
import type { Vehicle, VehicleStatus } from '@xpeng/protocol/src/vehicles';
import { COMMANDS } from '@xpeng/protocol/src/commands';
import type { CommandDef } from '@xpeng/protocol/src/commands';
import { sendVehicleCommand } from '@xpeng/protocol/src/ble-v2-routing';
import { bleLink } from './ble';

/** 组件上的四个格位对应的指令 id，与 `CustomCommandId` 同名。 */
export type WidgetCommandId = 'doorLock' | 'remoteUnlock' | 'acOn' | 'flash';

export type WidgetCommandOutcome =
  | { ok: true }
  | { ok: false; reason: 'anonymous' | 'no-vehicle' | 'unsupported' | 'failed'; detail: string };

/**
 * 组件点一下 → 下发对应车控指令。
 *
 * 与车控页 `runQuick` 的分派保持一致：
 * - `doorLock` 是状态切换（已锁就解锁、未锁就上锁），方向取决于当前锁止状态；
 * - `acOn` 走 `hvac.on`，P5 上没有 BLE V2 路由，由 MQTT 下发；
 * - `flash` 走 `light.flash`，P5 上走 BLE V2 的 0x26；
 * - `remoteUnlock` 在 App 里本来就没实现，组件同样返回 `unsupported`，不假装成功。
 */
export async function runWidgetCommand(commandId: string): Promise<WidgetCommandOutcome> {
  const id = commandId as WidgetCommandId;
  // 冷启动场景：组件点击会把整个 RN 运行时拉起来，此时 App.tsx 的 useEffect 里
  // 那次 sessionStore.init() 还没跑，状态停在 loading。不主动初始化的话，下面
  // 的「未登录」判断会把每一次点击都拒掉——这是组件「点了没反应」的根因。
  if (sessionStore.current.kind === 'loading') {
    await sessionStore.init().catch((e) => xpLog('widget', `session init failed: ${errText(e)}`, 'w'));
  }
  if (id === 'remoteUnlock') {
    // App 内点这一格也是提示不支持（Control.tsx 的 REAL_COMMANDS 里就是 undefined），
    // 组件保持一致，免得桌面按下去了、界面里却做不了。
    return { ok: false, reason: 'unsupported', detail: '远程解锁' };
  }
  if (sessionStore.current.kind !== 'active') {
    return { ok: false, reason: 'anonymous', detail: '未登录' };
  }

  const vehicle = await ensureVehicle();
  if (!vehicle) return { ok: false, reason: 'no-vehicle', detail: '没有可用车辆' };

  // 无界面任务里没有界面去驱动连接：先确保在线，否则 carLink.send 会直接返回「连接未就绪」。
  if (carLink.linkState !== 'online') {
    const uid = (sessionStore.current as { session: { uid: number } }).session.uid;
    try {
      await carLink.connect(vehicle.vin, uid);
    } catch (e) {
      return { ok: false, reason: 'failed', detail: `连接失败：${errText(e)}` };
    }
  }

  const def = resolveCommandDef(id);
  if (!def) return { ok: false, reason: 'unsupported', detail: '远程解锁' };

  // P5 的门锁与闪灯走 BLE V2，需要先准备好车辆上下文（材质预签），否则
  // executePreparedV2 会抛「context is not prepared」。无界面任务没有界面去准备，
  // 所以这里补一次；非 P5 车型 autoPrepareV2 本身是空操作。
  try {
    await bleLink.autoPrepareV2(vehicle);
  } catch (e) {
    xpLog('widget', `ble prepare failed: ${errText(e)}`, 'w');
  }

  const result = await sendVehicleCommand(vehicle, def, {
    send: (d) => carLink.send(d),
    executePreparedV2: (vin, code) => bleLink.executePreparedV2(vin, code),
  });
  xpLog('widget', `command=${id} ok=${result.ok} err=${result.error ?? '-'}`);
  if (!result.ok) {
    return { ok: false, reason: 'failed', detail: result.error ?? '下发失败' };
  }
  // 下发后立刻读一次，让 2x4 上的电量/续航跟着更新（车控页也是这个行为）。
  carLink.readStatus().then((s) => {
    if (s) void publishStatus(s);
  }).catch(() => {});
  return { ok: true };
}

/** `COMMANDS` 是数组，按 id 索引一次，与车控页用同一份指令表。 */
const COMMAND_BY_ID: Record<string, CommandDef> = Object.fromEntries(
  COMMANDS.map((def) => [def.id, def]),
);

/** 组件点按钮时若 `doorLock` 是切换键，需要知道当前锁止状态；没有状态就按「解锁」处理。 */
function resolveCommandDef(id: WidgetCommandId): CommandDef | null {
  if (id === 'remoteUnlock') return null;
  if (id === 'doorLock') {
    const locked = carLink.status?.instant?.door?.driver_door_lock_st === 1;
    return COMMAND_BY_ID[locked ? 'door.unlock' : 'door.lock'] ?? null;
  }
  if (id === 'acOn') return COMMAND_BY_ID['hvac.on'] ?? null;
  if (id === 'flash') return COMMAND_BY_ID['light.flash'] ?? null;
  return null;
}

/** 组件任务里没有界面持有的车辆对象，需要自己拉一次；同一进程内只拉一次。 */
let cachedVehicle: Vehicle | null = null;
async function ensureVehicle(): Promise<Vehicle | null> {
  if (cachedVehicle) return cachedVehicle;
  try {
    const data = await sessionStore.call<{ vehicles: Vehicle[] }>('/biz/v5/vehicle/v2/myVehicles', {});
    cachedVehicle = data?.vehicles?.[0] ?? null;
    return cachedVehicle;
  } catch (e) {
    xpLog('widget', `load vehicles failed: ${errText(e)}`, 'w');
    return null;
  }
}

/**
 * 把电量与续航写回原生，并让 2x4 组件重画。
 *
 * 键名与 `WidgetSnapshot.KEY_SNAPSHOT` 一致（`widget.snapshot`），原生直接读同一个
 * SharedPreferences。写的是整数或 null——没有读数时组件显示「—」，不显示 0。
 */
export async function publishStatus(status: VehicleStatus): Promise<void> {
  const soc = status?.instant?.charge?.battery_soc;
  const range = status?.instant?.odometer?.avalible_driving_distance;
  const payload = JSON.stringify({
    soc: typeof soc === 'number' ? Math.round(soc) : null,
    rangeKm: typeof range === 'number' ? Math.round(range) : null,
    updatedAt: Date.now(),
  });
  await native.storageSet(StorageKey.widgetSnapshot, payload);
  // 落盘后立刻让桌面重画：不调这一步的话，2x4 要等下一次 launcher 主动 onUpdate
  // 才会变，而 updatePeriodMillis 我们置了 0，实际就是永远不变。
  await native.refreshWidgets().catch(() => 0);
}

/** 供界面在拿到新状态时调用；与 publishStatus 同一份落盘，只是多了「顺手重画」。 */
export async function publishWidgetSnapshot(status: VehicleStatus | null): Promise<void> {
  if (!status) return;
  await publishStatus(status);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
