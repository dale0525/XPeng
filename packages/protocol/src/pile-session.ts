/**
 * Bluetooth pile session state machine.
 *
 * Transport-agnostic: it only needs a `PileTransport` that can write one frame to
 * the write characteristic and deliver notifications from the notify handler. The
 * GATT profile is addressed by handle when available, else by the service UUID.
 *
 * Handshake ordering was measured on real hardware (see
 * `work/ble-capture/pile-identity/protocol-evidence.md`):
 *
 *     enable indication on the notify CCCD -> W1 -> N1 -> W2 -> N2
 *
 * W2 follows N1 by ~7 ms, so it must be pre-computable; this module therefore
 * accepts both frames as *supplied payloads* rather than deriving them. Deriving
 * them from `secretKey` is not implemented because the derivation is unknown.
 *
 * The start-charging sequence contains no session-derived bytes: write
 * `68620000291a`, expect `6961003de1` and a status frame, then ACK with
 * `69a1002bb5`.
 */

import { buildPileFrame, parsePileFrame, type PileFrame } from './pile-frame.ts';

export interface PileTransport {
  /** Write one full frame to the pile's write characteristic. */
  write(frame: Uint8Array): Promise<void>;
  /** Wait for the next notification frame, or reject on timeout. */
  nextNotification(timeoutMs: number): Promise<Uint8Array>;
}

export interface PileHandshakeMaterial {
  /** Frame W1, as captured. The bytes vary per session and cannot be pre-baked. */
  connectWrite1: Uint8Array;
  /** Frame W2, as captured. */
  connectWrite2: Uint8Array;
}

/** Captured reply frames, used to check that the pile answered as expected. */
export const EXPECTED_CONNECT_NOTIFY1_PREFIX = 0x22;
export const CONNECT_NOTIFY1_CLASS = 1;
export const CONNECT_NOTIFY2_CLASS = 2;

/** Start charging, constant across captured samples. */
export const START_CHARGE_FRAME = Uint8Array.from([0x68, 0x62, 0x00, 0x00, 0x29, 0x1a]);
export const START_CHARGE_REPLY_FRAME = Uint8Array.from([0x69, 0x61, 0x00, 0x3d, 0xe1]);
export const STATUS_ACK_FRAME = Uint8Array.from([0x69, 0xa1, 0x00, 0x2b, 0xb5]);

export class PileSessionError extends Error {}

export class PileSession {
  private readonly transport: PileTransport;
  private handshakeComplete = false;

  constructor(transport: PileTransport) {
    this.transport = transport;
  }

  /**
   * Run the two-write handshake. Requires material supplied by the caller; this
   * deliberately does not pretend to derive it.
   */
  async connect(material: PileHandshakeMaterial, timeoutMs = 5000): Promise<{ notify1: PileFrame; notify2: PileFrame }> {
    if (this.handshakeComplete) throw new PileSessionError('handshake already completed');

    await this.transport.write(material.connectWrite1);
    const n1 = await this.expectFrame(CONNECT_NOTIFY1_CLASS, timeoutMs, 'N1');
    if (n1.payload[0] !== EXPECTED_CONNECT_NOTIFY1_PREFIX) {
      throw new PileSessionError(
        `unexpected N1 first payload byte: 0x${n1.payload[0]?.toString(16).padStart(2, '0')}`,
      );
    }

    await this.transport.write(material.connectWrite2);
    const n2 = await this.expectFrame(CONNECT_NOTIFY2_CLASS, timeoutMs, 'N2');

    this.handshakeComplete = true;
    return { notify1: n1, notify2: n2 };
  }

  /**
   * Send start charging and complete the acknowledgement exchange.
   *
   * Returns the status frames observed. The ACK is sent once per status frame,
   * matching the captured sequence where the same ACK bytes answered both.
   */
  async startCharging(timeoutMs = 5000): Promise<PileFrame[]> {
    if (!this.handshakeComplete) throw new PileSessionError('start charging requires a completed handshake');

    await this.transport.write(START_CHARGE_FRAME);

    const reply = await this.expectFrame(3, timeoutMs, 'start reply');
    if (reply.responder !== true || reply.payload.length !== 1 || reply.payload[0] !== 0) {
      throw new PileSessionError('unexpected start-charging reply shape');
    }

    const status: PileFrame[] = [];
    const first = await this.expectFrame(5, timeoutMs, 'status 1');
    status.push(first);
    await this.transport.write(STATUS_ACK_FRAME);

    // A second status frame may follow; the capture showed one ~2.2 s later.
    try {
      const second = await this.expectFrame(5, Math.min(timeoutMs, 4000), 'status 2');
      status.push(second);
      await this.transport.write(STATUS_ACK_FRAME);
    } catch (error) {
      if (!(error instanceof PileSessionError)) throw error;
      // A single status frame is acceptable; do not fail on the optional follow-up.
    }

    return status;
  }

  private async expectFrame(cls: number, timeoutMs: number, label: string): Promise<PileFrame> {
    let raw: Uint8Array;
    try {
      raw = await this.transport.nextNotification(timeoutMs);
    } catch (error) {
      // Normalize transport-level failures (timeouts included) into one type so
      // callers can distinguish "no frame arrived" from "frame was wrong".
      throw error instanceof PileSessionError
        ? error
        : new PileSessionError(`${label}: no frame (${(error as Error).message})`);
    }
    let frame: PileFrame;
    try {
      frame = parsePileFrame(raw);
    } catch (error) {
      throw new PileSessionError(`${label}: undecodable frame (${(error as Error).message})`);
    }
    if (frame.class !== cls) {
      throw new PileSessionError(`${label}: expected class ${cls}, got ${frame.class}`);
    }
    return frame;
  }
}

/**
 * Generate handshake frames locally.
 *
 * Verified on real hardware 2026-11-07: the pile accepted locally generated
 * payloads and answered with class 1 / class 2 notifications. The client
 * therefore does not need the server secret to complete a handshake.
 *
 * W1 payload = 0xff | 8 random
 * W2 payload = 15 random | 0x84
 */
export function generateHandshakeMaterial(random: (n: number) => Uint8Array = defaultRandom): PileHandshakeMaterial {
  const w1 = new Uint8Array(9);
  w1[0] = 0xff;
  w1.set(random(8), 1);

  const w2 = new Uint8Array(16);
  w2.set(random(15), 0);
  w2[15] = 0x84;

  return {
    connectWrite1: buildPileFrame(true, 1, w1),
    connectWrite2: buildPileFrame(true, 2, w2),
  };
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Rebuild a captured frame so callers never hand-tune bytes. */
export function frame(initiator: boolean, cls: number, payload: Uint8Array): Uint8Array {
  return buildPileFrame(initiator, cls, payload);
}