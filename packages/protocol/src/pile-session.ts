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
 * The start/stop charge commands are **command-style frames** (`0x7e`), not the
 * server-style `0x68` envelope:
 *
 *     start: 7e | 03 | 07 | 00 00 00 00 00 00 00 | crc16  =  7e 03 07 00 00 00 00 00 00 00 0c 29
 *     stop:  7e | 04 | 05 | ff ff ff ff 01       | crc16  =  7e 04 05 ff ff ff ff 01 61 6b
 *
 * Both are fixed byte strings: they carry no session-derived material and did
 * not vary across the three captured sessions. Each gets one `0x7f` ack from the
 * pile, then the pile pushes a `68a5…` status report which the phone answers with
 * `69a1002bb5`. Captured 2026-11-13 on official App 5.19.0; see
 * `docs/research/xpeng-ble-charging-pile.md` §5.
 */

import {
  buildPileCommandFrame,
  buildPileFrame,
  parsePileFrame,
  type PileFrame,
} from './pile-frame.ts';

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

/** Start charging: command 3, seven zero bytes. */
export const START_CHARGE_COMMAND = 3;
/** Stop charging: command 4, `ff ff ff ff 01`. */
export const STOP_CHARGE_COMMAND = 4;
export const START_CHARGE_FRAME = buildPileCommandFrame(3, new Uint8Array(7));
/** Stop charging: command 4, `ff ff ff ff 01`. */
export const STOP_CHARGE_FRAME = buildPileCommandFrame(
  4,
  Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x01]),
);
/** Phone answer to the pile's `68a5…` status report; same bytes for both. */
export const STATUS_ACK_FRAME = buildPileFrame(false, 5, Uint8Array.from([0x00]));

/** The pile's ack to a command is command-class, responder byte `0x7f`. */
export const COMMAND_ACK_PREFIX = 0x7f;

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

  /** Start charging: send the command frame, then settle the status exchange. */
  async startCharging(timeoutMs = 5000): Promise<PileFrame[]> {
    if (!this.handshakeComplete) throw new PileSessionError('start charging requires a completed handshake');
    return this.sendCommand(START_CHARGE_FRAME, START_CHARGE_COMMAND, 'start', timeoutMs);
  }

  /** Stop charging: the same exchange with command 4. */
  async stopCharging(timeoutMs = 5000): Promise<PileFrame[]> {
    if (!this.handshakeComplete) throw new PileSessionError('stop charging requires a completed handshake');
    return this.sendCommand(STOP_CHARGE_FRAME, STOP_CHARGE_COMMAND, 'stop', timeoutMs);
  }

  /**
   * One command exchange, as captured: write the command, read the pile's `7f`
   * ack, then answer each `68a5…` status report it pushes with `69a1002bb5`.
   */
  private async sendCommand(
    frame: Uint8Array,
    commandId: number,
    label: string,
    timeoutMs: number,
  ): Promise<PileFrame[]> {
    await this.transport.write(frame);

    const ack = await this.nextCommandAck(commandId, timeoutMs, `${label} ack`);
    const verdict = ack.payload[0];
    if (verdict !== 0x00 && verdict !== 0x01) {
      throw new PileSessionError(
        `${label}: unexpected command ack payload 0x${verdict?.toString(16).padStart(2, '0')}`,
      );
    }
    if (verdict === 0x01) {
      // Rejected. The pile sends no status report after a rejection.
      throw new PileSessionError(`${label}: 桩拒绝了命令（回执首字节 01：当前条件不满足）`);
    }

    // The command succeeded: the `0x7f` ack carried 00. Everything below is the
    // pile's asynchronous charge-state reporting, which is NOT the success
    // criterion. Measured 2026-11-14 on a real pile: the command took effect
    // (charging started) yet no status report arrived before our timeout, and an
    // earlier version reported that as a failure. So collect status frames and
    // answer them best-effort; never let a late/missing report turn a successful
    // command into an error.
    const status: PileFrame[] = [];
    try {
      const first = await this.nextClassFrame(5, Math.min(timeoutMs, 2000), `${label} status 1`);
      status.push(first);
      await this.transport.write(STATUS_ACK_FRAME);
      try {
        const second = await this.nextClassFrame(5, Math.min(timeoutMs, 2000), `${label} status 2`);
        status.push(second);
        await this.transport.write(STATUS_ACK_FRAME);
      } catch {
        // A single status report is enough; the second is optional.
      }
    } catch {
      // No status report (or an undecodable one) within the window: the command
      // still succeeded, so keep going and report success.
    }

    return status;
  }

  /**
   * Pull frames until the pile's `0x7f` ack for `commandId` shows up. Anything
   * else (a status report that raced ahead of the ack, a stray frame) is pushed
   * back onto the local buffer so the status wait below still sees it -- never
   * dropped, or the exchange would deadlock on a frame we already consumed.
   */
  private async nextCommandAck(commandId: number, timeoutMs: number, label: string): Promise<PileFrame> {
    const deadline = Date.now() + timeoutMs;
    const deferred: PileFrame[] = [];
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PileSessionError(`${label}: no frame (timed out)`);
        const parsed = await this.readAny(remaining, label);
        if (parsed.command && parsed.b0 === COMMAND_ACK_PREFIX && parsed.commandId === commandId) {
          return parsed;
        }
        deferred.push(parsed);
      }
    } finally {
      // Re-queue in arrival order ahead of anything still on the wire.
      this.buffered.unshift(...deferred);
    }
  }

  /** Pull frames until one of server class `cls` arrives, buffering the rest. */
  private async nextClassFrame(cls: number, timeoutMs: number, label: string): Promise<PileFrame> {
    const deadline = Date.now() + timeoutMs;
    const deferred: PileFrame[] = [];
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PileSessionError(`${label}: no frame (timed out)`);
        const parsed = await this.readAny(remaining, label);
        if (!parsed.command && parsed.class === cls) return parsed;
        deferred.push(parsed);
      }
    } finally {
      this.buffered.unshift(...deferred);
    }
  }

  private async expectFrame(cls: number, timeoutMs: number, label: string): Promise<PileFrame> {
    const frame = await this.readAny(timeoutMs, label);
    if (frame.command) {
      throw new PileSessionError(`${label}: expected class ${cls}, got command ${frame.commandId}`);
    }
    if (frame.class !== cls) {
      throw new PileSessionError(`${label}: expected class ${cls}, got ${frame.class}`);
    }
    return frame;
  }

  /** Buffered frames skipped while hunting for a specific one. */
  private readonly buffered: PileFrame[] = [];

  private async readAny(timeoutMs: number, label: string): Promise<PileFrame> {
    const queued = this.buffered.shift();
    if (queued) return queued;
    return this.readFrame(timeoutMs, label);
  }

  private async readFrame(timeoutMs: number, label: string): Promise<PileFrame> {
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
    try {
      return parsePileFrame(raw);
    } catch (error) {
      throw new PileSessionError(`${label}: undecodable frame (${(error as Error).message})`);
    }
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