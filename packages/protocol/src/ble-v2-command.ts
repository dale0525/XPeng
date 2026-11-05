import { buildTbox } from './ble.ts';
import { concat } from './bytes.ts';

export function validateV2Command(commandCode: number, messageId: number): void {
  for (const [name, value] of [['commandCode', commandCode], ['messageId', messageId]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error(`BLE V2 ${name} must be a uint8 integer`);
    }
  }
}

/** V2 EDDataPackager appends the command to opaque server material; messageId is independent. */
export function buildV2Command(raw: Uint8Array, commandCode: number, messageId: number): Uint8Array {
  validateV2Command(commandCode, messageId);
  return buildTbox(0xed, 0x11, messageId, concat(raw, [commandCode]));
}
