import { cbc } from '@noble/ciphers/aes.js';
import { fromHex } from './bytes.ts';

/** Key is the HEX value returned by getVerifyCarSecKey(vin), not a V3 KDF input. */
export function createV2AuthCipher(verifyKey: string, verifyRandom: number): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(verifyKey)) {
    throw new Error('BLE V2 verify key must be HEX bytes');
  }
  if (!Number.isInteger(verifyRandom) || verifyRandom < 0 || verifyRandom > 0xffffffff) {
    throw new Error('BLE V2 verify random must be uint32');
  }
  const plain = new Uint8Array(16);
  new DataView(plain.buffer).setUint32(0, verifyRandom, true);
  return cbc(fromHex(verifyKey), new Uint8Array(16), { disablePadding: true }).encrypt(plain);
}

/** Rejects any reply other than the complete uint32 rand+1 challenge with twelve zero bytes. */
export function verifyV2AuthReply(verifyKey: string, verifyRandom: number, cipher: Uint8Array): void {
  if (cipher.length !== 16) throw new Error('BLE V2 reply cipher must be sixteen bytes');
  const plain = cbc(fromHex(verifyKey), new Uint8Array(16), { disablePadding: true }).decrypt(cipher);
  // uint32 arithmetic wraps here; official behavior at 0xffffffff is not established.
  const expected = (verifyRandom + 1) >>> 0;
  if (new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, true) !== expected
    || plain.subarray(4).some((byte) => byte !== 0)) {
    throw new Error('BLE V2 reply challenge mismatch');
  }
}
