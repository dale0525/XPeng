import type { CommandDef } from './commands.ts';
import { isP5BleV2Vehicle } from './ble-v2-context.ts';

/** Commands with no MQTT representation; direction lives in the server-issued BLE material. */
export const BLE_ONLY_V2_COMMAND_IDS = ['trunk.open', 'trunk.close'] as const;

/** 只有这几条真的没有云端通道，界面上才需要「蓝牙未连接就置灰」。 */
export function isBleOnlyCommand(id: string): boolean {
  return BLE_ONLY_V2_COMMAND_IDS.includes(id as typeof BLE_ONLY_V2_COMMAND_IDS[number]);
}

/**
 * P5 上真正走蓝牙的指令 → 车控命令码。
 *
 * 界面据此判断「哪几个按钮在蓝牙未连接时必须置灰」：同一份映射既是路由判据也是
 * 置灰判据，避免界面手抄一份列表后与路由漂移（多灰一个、少灰一个都是错的）。
 */
const BLE_V2_COMMAND_CODES: Record<string, number> = {
  'door.unlock': 1,
  'door.lock': 2,
  'trunk.open': 0x04,
  'trunk.close': 0x04,
  'light.flash': 0x26,
  'window.down': 0x0c,
  'window.up': 0x0d,
};

export function bleV2CommandCode(id: string): number | undefined {
  return BLE_V2_COMMAND_CODES[id];
}

interface SendResult {
  ok: boolean;
  msgId: string;
  error?: string;
  /** Vehicle acted physically in one capture, but the official result-code meaning is unknown. */
  unconfirmed?: boolean;
}

/**
 * 先走蓝牙，失败就退到云端。
 *
 * 蓝牙是本地链路，成功时最快、也不受网络影响；但它有个致命前提——人得在车旁边。
 * 实测：人走进公司大楼后点「上锁」，蓝牙写帧被原生以 `E_NOT_READY` 立刻拒掉，
 * 指令根本没发出去，车还开着，用户以为锁上了。而云端（`service_type` 9 / 12 / 5）
 * 有实测回执，能远程送达。所以除尾门外的指令都必须有这条退路。
 *
 * 只有 `BLE_ONLY_V2_COMMAND_IDS` 例外：它们在协议里没有云端表达，蓝牙不通就是不可用，
 * 必须由界面提前置灰并说明，不能静默失败。
 */
export async function sendVehicleCommand(
  vehicle: { vin: string; vehicleTypeCode: string },
  def: CommandDef,
  links: {
    send(def: CommandDef): Promise<SendResult>;
    executePreparedV2(vin: string, commandCode: number): Promise<{ code: number }>;
  },
): Promise<SendResult> {
  const commandCode = isP5BleV2Vehicle(vehicle) ? bleV2CommandCode(def.id) : undefined;
  if (commandCode === undefined) {
    if (BLE_ONLY_V2_COMMAND_IDS.includes(def.id as typeof BLE_ONLY_V2_COMMAND_IDS[number])) {
      return { ok: false, msgId: '', error: 'P5 BLE-only command has no evidenced MQTT fallback: ' + def.id };
    }
    return links.send(def);
  }
  const ble = await sendOverBle(vehicle, commandCode, links);
  // 蓝牙已把指令送达车端（含 163：车已动作但语义未定），不再重复下发。
  if (ble.ok || ble.unconfirmed) return ble;
  // 尾门没有云端表达，失败就是失败。
  if (BLE_ONLY_V2_COMMAND_IDS.includes(def.id as typeof BLE_ONLY_V2_COMMAND_IDS[number])) return ble;
  const cloud = await links.send(def);
  if (cloud.ok) return cloud;
  // 两条路都失败时，报告蓝牙失败原因——它更能说明「为什么本地点不了」，云端码只是叠加信息。
  return { ...cloud, error: `${ble.error}；云端重试失败：${cloud.error ?? '未知原因'}` };
}

async function sendOverBle(
  vehicle: { vin: string },
  commandCode: number,
  links: { executePreparedV2(vin: string, commandCode: number): Promise<{ code: number }> },
): Promise<SendResult> {
  try {
    const ack = await links.executePreparedV2(vehicle.vin, commandCode);
    if (ack.code === 200) return { ok: true, msgId: '' };
    const message = `BLE acknowledgement code: ${ack.code}`;
    return ack.code === 163
      ? { ok: false, msgId: '', error: message, unconfirmed: true }
      : { ok: false, msgId: '', error: message };
  } catch (error) {
    return { ok: false, msgId: '', error: error instanceof Error ? error.message : String(error) };
  }
}
