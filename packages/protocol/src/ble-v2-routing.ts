import type { CommandDef } from './commands.ts';
import { isP5BleV2Vehicle } from './ble-v2-context.ts';

/** Commands with no MQTT representation; direction lives in the server-issued BLE material. */
export const BLE_ONLY_V2_COMMAND_IDS = ['trunk.open', 'trunk.close'] as const;

interface SendResult {
  ok: boolean;
  msgId: string;
  error?: string;
  /** Vehicle acted physically in one capture, but the official result-code meaning is unknown. */
  unconfirmed?: boolean;
}

export async function sendVehicleCommand(
  vehicle: { vin: string; vehicleTypeCode: string },
  def: CommandDef,
  links: {
    send(def: CommandDef): Promise<SendResult>;
    executePreparedV2(vin: string, commandCode: number): Promise<{ code: number }>;
  },
): Promise<SendResult> {
  let commandCode: number | undefined;
  if (isP5BleV2Vehicle(vehicle)) {
    switch (def.id) {
      case 'door.unlock': commandCode = 1; break;
      case 'door.lock': commandCode = 2; break;
      case 'trunk.open': case 'trunk.close': commandCode = 0x04; break;
      case 'light.flash': commandCode = 0x26; break;
      case 'window.down': commandCode = 0x0c; break;
      case 'window.up': commandCode = 0x0d; break;
    }
  }
  if (commandCode === undefined) {
    if (BLE_ONLY_V2_COMMAND_IDS.includes(def.id as typeof BLE_ONLY_V2_COMMAND_IDS[number])) {
      return { ok: false, msgId: '', error: 'P5 BLE-only command has no evidenced MQTT fallback: ' + def.id };
    }
    return links.send(def);
  }
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
