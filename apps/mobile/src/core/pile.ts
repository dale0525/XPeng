/**
 * Bluetooth charging pile connection profile.
 *
 * Everything here comes from captured traffic; none of it is guessed. See
 * `work/ble-capture/pile-identity/protocol-evidence.md`.
 *
 * The pile's service UUID was recovered, but the 128-bit UUIDs of its write and
 * notify characteristics were not: the HCI slice has no complete characteristic
 * declaration. Both are therefore addressed by attribute handle, which is enough
 * for a GATT client.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import { fromHex, toHex } from '@xpeng/protocol/src/bytes';
import type { PileTransport } from '@xpeng/protocol/src/pile-session';
import { PileSession, generateHandshakeMaterial } from '@xpeng/protocol/src/pile-session';

/** Service UUID present in the captured service discovery. */
export const PILE_SERVICE_UUID = '1b7e8251-2877-41c3-b46e-cf057c562023';

/** Attribute handles, confirmed on two independent connections. */
export const PILE_NOTIFY_HANDLE = 0x0003;
export const PILE_WRITE_HANDLE = 0x0006;

interface PileNative {
  connectProfile(
    mac: string,
    serviceUuid: string | null,
    writeUuid: string | null,
    readUuid: string | null,
    writeHandle: number | null,
    readHandle: number | null,
    autoConnect: boolean,
    timeoutMs: number,
  ): Promise<void>;
  dumpServices(): Promise<Array<{ service: string; characteristics: Array<{ uuid: string; handle: number; properties: number }> }>>;
  write(hex: string): Promise<void>;
  disconnect(): Promise<void>;
}

const bridge = NativeModules.XpengBle as PileNative;

/** Transport that routes frames through the native GATT bridge. */
class PileNativeTransport implements PileTransport {
  private mac = '';
  private readonly emitter = new NativeEventEmitter(NativeModules.XpengBle);
  private queue: Uint8Array[] = [];
  private waiters: Array<{ resolve: (value: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private subscription: { remove(): void } | null = null;

  async connect(mac: string, timeoutMs = 15000): Promise<void> {
    this.mac = mac.toUpperCase();
    this.subscription = this.emitter.addListener('xpeng-ble-data', (value) => {
      const event = value as unknown as { mac: string; hex: string };
      if (event.mac.toUpperCase() !== this.mac) return;
      this.push(fromHex(event.hex));
    });
    await bridge.connectProfile(mac, PILE_SERVICE_UUID, null, null, PILE_WRITE_HANDLE, PILE_NOTIFY_HANDLE, false, timeoutMs);
  }

  write(frame: Uint8Array): Promise<void> {
    return bridge.write(toHex(frame));
  }

  nextNotification(timeoutMs = 5000): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`pile notification timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  async disconnect(): Promise<void> {
    this.failWaiters(new Error('pile transport closed'));
    this.subscription?.remove();
    this.subscription = null;
    await bridge.disconnect();
  }

  private push(frame: Uint8Array) {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.queue.push(frame);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private failWaiters(error: Error) {
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
  }
}

/**
 * Connect to a pile and complete the handshake with locally generated frames.
 *
 * Verified on real hardware 2026-11-07: the pile accepts client-generated
 * handshake payloads, so no server secret is needed. The first link attempt often
 * fails with status 133 (`GATT_CONN_FAILED_ESTABLISHMENT`) — the official app hits
 * this too and recovers by reconnecting with an auto (background) connect. That
 * retry lives in the native module so the JS layer only connects once.
 */
export async function connectPile(
  mac: string,
  options: { timeoutMs?: number } = {},
): Promise<{ session: PileSession; transport: PileNativeTransport; startCharging: () => Promise<unknown> }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const transport = new PileNativeTransport();
  try {
    await transport.connect(mac, timeoutMs);
    const session = new PileSession(transport);
    await session.connect(generateHandshakeMaterial());
    return { session, transport, startCharging: () => session.startCharging() };
  } catch (error) {
    await transport.disconnect().catch(() => {});
    throw error;
  }
}

/** Read the connected device's full GATT layout; used to recover unknown UUIDs. */
export function dumpPileServices() {
  return bridge.dumpServices();
}
