/**
 * Bluetooth charging-pile frame codec.
 *
 * There are **two** frame families on the same characteristic, and they do not
 * share a layout:
 *
 * Server-style (`0x68`/`0x69`) — connect handshake and status reports:
 *
 *     b0 | b1 | payload | crc16        b1 = class<<5 | payload length
 *
 * `b0 & 0xFE == 0x68`, bit 0 is a role bit (initiator vs responder), NOT a
 * transport direction. The pile posts its own reports with the initiator-style
 * `0x68` and the phone answers with `0x69`.
 *
 * Command-style (`0x7e`/`0x7f`) — every charge command:
 *
 *     b0 | cmd | len | data | crc16
 *
 * `b0` is the direction (`0x7e` phone → pile, `0x7f` pile → phone), `cmd` is the
 * command number, `len` is the data length in bytes. Captured 2026-11-13 on
 * official App 5.19.0 across three sessions (see
 * `docs/research/xpeng-ble-charging-pile.md` §5). Because the byte-1/length
 * layout differs, a codec that only modelled the server family could neither
 * emit nor decode these — which is why start charging was rejected with payload
 * `01` on every attempt: `68620000291a` was a status-report fragment, never the
 * start command.
 *
 * `crc16` is CRC16/XMODEM over everything before it, big-endian, in both
 * families.
 *
 * This module is transport-agnostic and holds no key material. It does not
 * generate the connect-handshake payloads: the derivation of those from
 * `secretKey` is unknown.
 */

export const PILE_B0_MASK = 0xfe;
export const PILE_B0_VALUE = 0x68;
/** Command-style byte 0, phone → pile. */
export const PILE_CMD_B0_VALUE = 0x7e;
/** Command-style byte 0, pile → phone (acknowledgement). */
export const PILE_CMD_ACK_B0_VALUE = 0x7f;
export const PILE_MAX_PAYLOAD = 0x1f;

export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export interface PileFrame {
  /** Byte 0, including the role bit. */
  b0: number;
  class: number;
  payload: Uint8Array;
  /** True when bit 0 of `b0` is set (responder-style frame). */
  responder: boolean;
  /** True for the command family (`0x7e` phone → `0x7f` pile). */
  command: boolean;
  /** Command number; 0 for server-style frames. */
  commandId: number;
}

export function buildPileFrame(initiator: boolean, cls: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(cls) || cls < 0 || cls > 0x07) {
    throw new RangeError(`pile frame class out of range: ${cls}`);
  }
  if (payload.length > PILE_MAX_PAYLOAD) {
    throw new RangeError(`pile frame payload too long: ${payload.length} > ${PILE_MAX_PAYLOAD}`);
  }
  const b1 = ((cls << 5) | payload.length) & 0xff;
  const body = new Uint8Array(2 + payload.length + 2);
  body[0] = initiator ? 0x68 : 0x69;
  body[1] = b1;
  body.set(payload, 2);
  return withCrc(body);
}

/**
 * Build a command-style frame. `ack` picks the pile's side (`0x7f`) instead of
 * the phone's (`0x7e`); the phone only ever sends the latter.
 */
export function buildPileCommandFrame(commandId: number, data: Uint8Array, ack = false): Uint8Array {
  if (!Number.isInteger(commandId) || commandId < 0 || commandId > 0xff) {
    throw new RangeError(`pile command id out of range: ${commandId}`);
  }
  const body = new Uint8Array(3 + data.length + 2);
  body[0] = ack ? PILE_CMD_ACK_B0_VALUE : PILE_CMD_B0_VALUE;
  body[1] = commandId;
  body[2] = data.length;
  body.set(data, 3);
  return withCrc(body);
}

function withCrc(body: Uint8Array): Uint8Array {
  const end = body.length - 2;
  const crc = crc16Xmodem(body.subarray(0, end));
  body[end] = (crc >> 8) & 0xff;
  body[end + 1] = crc & 0xff;
  return body;
}

export function parsePileFrame(frame: Uint8Array): PileFrame {
  if (frame.length < 4) throw new RangeError(`pile frame too short: ${frame.length} bytes`);
  const b0 = frame[0]!;
  const command = b0 === PILE_CMD_B0_VALUE || b0 === PILE_CMD_ACK_B0_VALUE;
  if (!command && (b0 & PILE_B0_MASK) !== PILE_B0_VALUE) {
    throw new RangeError(`not a pile frame: b0=0x${b0.toString(16).padStart(2, '0')}`);
  }
  if (command) return parseCommandFrame(frame);

  const b1 = frame[1]!;
  const payloadLength = b1 & PILE_MAX_PAYLOAD;
  const expected = 2 + payloadLength + 2;
  if (frame.length !== expected) {
    throw new RangeError(`pile frame length mismatch: b1 says ${expected}, got ${frame.length}`);
  }
  verifyCrc(frame, expected);
  return {
    b0,
    class: b1 >> 5,
    payload: frame.slice(2, 2 + payloadLength),
    responder: (b0 & 1) === 1,
    command: false,
    commandId: 0,
  };
}

function parseCommandFrame(frame: Uint8Array): PileFrame {
  const commandId = frame[1]!;
  const dataLength = frame[2]!;
  const expected = 3 + dataLength + 2;
  if (frame.length !== expected) {
    throw new RangeError(
      `pile command frame length mismatch: len byte says ${expected}, got ${frame.length}`,
    );
  }
  verifyCrc(frame, expected);
  return {
    b0: frame[0]!,
    // The command family has no class field; `commandId` carries the meaning.
    class: commandId,
    payload: frame.slice(3, 3 + dataLength),
    responder: false,
    command: true,
    commandId,
  };
}

function verifyCrc(frame: Uint8Array, expected: number): void {
  const bodyEnd = expected - 2;
  const stored = (frame[bodyEnd]! << 8) | frame[bodyEnd + 1]!;
  const computed = crc16Xmodem(frame.subarray(0, bodyEnd));
  if (stored !== computed) {
    throw new RangeError(
      `pile frame CRC mismatch: stored=0x${stored.toString(16).padStart(4, '0')} computed=0x${computed
        .toString(16)
        .padStart(4, '0')}`,
    );
  }
}