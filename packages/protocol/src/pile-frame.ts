/**
 * Bluetooth charging-pile frame codec.
 *
 * Wire format, re-derived offline from the nine captured frames with zero
 * residual bytes (see `work/ble-capture/pile-identity/protocol-evidence.md`):
 *
 *     b0 | b1 | payload | crc16
 *
 * - `b0 & 0xFE == 0x68`; bit 0 is a role bit (initiator vs responder), NOT a
 *   transport direction. The pile posts its own reports with the initiator-style
 *   `0x68` and the phone answers with `0x69`.
 * - `b1` high 3 bits = message class, low 5 bits = payload length.
 * - `crc16` = CRC16/XMODEM over `b0 | b1 | payload`, big-endian.
 *
 * This module is transport-agnostic and holds no key material. It does not
 * generate the connect-handshake payloads: the derivation of those from
 * `secretKey` is unknown.
 */

export const PILE_B0_MASK = 0xfe;
export const PILE_B0_VALUE = 0x68;
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
}

export function buildPileFrame(initiator: boolean, cls: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(cls) || cls < 0 || cls > 0x07) {
    throw new RangeError(`pile frame class out of range: ${cls}`);
  }
  if (payload.length > PILE_MAX_PAYLOAD) {
    throw new RangeError(`pile frame payload too long: ${payload.length} > ${PILE_MAX_PAYLOAD}`);
  }
  const b0 = (initiator ? 0x68 : 0x69) | 0;
  const b1 = ((cls << 5) | payload.length) & 0xff;
  const body = new Uint8Array(2 + payload.length + 2);
  body[0] = b0;
  body[1] = b1;
  body.set(payload, 2);
  const crc = crc16Xmodem(body.subarray(0, 2 + payload.length));
  body[2 + payload.length] = (crc >> 8) & 0xff;
  body[2 + payload.length + 1] = crc & 0xff;
  return body;
}

export function parsePileFrame(frame: Uint8Array): PileFrame {
  if (frame.length < 4) throw new RangeError(`pile frame too short: ${frame.length} bytes`);
  const b0 = frame[0]!;
  if ((b0 & PILE_B0_MASK) !== PILE_B0_VALUE) {
    throw new RangeError(`not a pile frame: b0=0x${b0.toString(16).padStart(2, '0')}`);
  }
  const b1 = frame[1]!;
  const payloadLength = b1 & PILE_MAX_PAYLOAD;
  const expected = 2 + payloadLength + 2;
  if (frame.length !== expected) {
    throw new RangeError(`pile frame length mismatch: b1 says ${expected}, got ${frame.length}`);
  }
  const stored = (frame[2 + payloadLength]! << 8) | frame[2 + payloadLength + 1]!;
  const computed = crc16Xmodem(frame.subarray(0, 2 + payloadLength));
  if (stored !== computed) {
    throw new RangeError(
      `pile frame CRC mismatch: stored=0x${stored.toString(16).padStart(4, '0')} computed=0x${computed
        .toString(16)
        .padStart(4, '0')}`,
    );
  }
  return {
    b0,
    class: b1 >> 5,
    payload: frame.slice(2, 2 + payloadLength),
    responder: (b0 & 1) === 1,
  };
}