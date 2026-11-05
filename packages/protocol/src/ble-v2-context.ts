import type { BleV2MaterialCall } from './ble-v2-material.ts';

export interface BleV2Context {
  vin: string;
  mac: string;
  keyMac: string;
  messageId: number;
}

export function isP5BleV2Vehicle(vehicle: { vehicleTypeCode: string }): boolean {
  return vehicle.vehicleTypeCode === 'DF';
}

const infoPath = '/digital-key/v2/key/ble/getBleInfo';

/** Preparation only: fetching context must never consume a message or touch BLE radio. */
export class BleV2ContextService {
  private readonly contexts = new Map<string, BleV2Context>();
  private readonly pending = new Map<string, Promise<BleV2Context>>();
  private generation = 0;

  private readonly call: BleV2MaterialCall;
  private readonly materials: { prepare(accountId: string | number, vin: string): Promise<void> };

  constructor(call: BleV2MaterialCall,
    materials: { prepare(accountId: string | number, vin: string): Promise<void> }) {
    this.call = call;
    this.materials = materials;
  }

  get(accountId: string | number, vin: string): BleV2Context | undefined {
    const context = this.contexts.get(JSON.stringify([String(accountId), vin]));
    return context && { ...context };
  }

  async prepare(accountId: string | number, vin: string): Promise<BleV2Context> {
    const key = JSON.stringify([String(accountId), vin]);
    const cached = this.get(accountId, vin);
    if (cached) return cached;
    const pending = this.pending.get(key);
    if (pending) return { ...await pending };
    const generation = this.generation;
    const request = this.load(accountId, vin, key, generation);
    this.pending.set(key, request);
    try {
      return { ...await request };
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  reset(): void {
    this.generation++;
    this.contexts.clear();
    this.pending.clear();
  }

  private async load(accountId: string | number, vin: string, key: string,
    generation: number): Promise<BleV2Context> {
    const data = await this.call(infoPath, { vin });
    if (generation !== this.generation) throw new Error('BLE V2 context reset during request');
    const macAddress = data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>).macAddress : undefined;
    if (typeof macAddress !== 'string' || !/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(macAddress)) {
      throw new Error(`${infoPath}: unsupported macAddress response`);
    }
    await this.materials.prepare(accountId, vin);
    if (generation !== this.generation) throw new Error('BLE V2 context reset during request');
    // Android connects getRemoteDevice(mac); that peripheral address is also the auth key string.
    const mac = macAddress.toUpperCase();
    const context = { vin, mac, keyMac: mac, messageId: 1 };
    this.contexts.set(key, context);
    return context;
  }
}
