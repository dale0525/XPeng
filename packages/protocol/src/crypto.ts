/**
 * 客户端身份层用到的密码学原语：
 * - HMAC-SHA256：外层 `Xp-Signature` 与内层 `xpSign` 都用它，密钥是 app secret。
 * - AES-128-GCM：`Xp-Authorization` 信封与 WEEB/sData 响应信封的载荷加密。
 * - AES-128-ECB：`teeIndiv4App` 返回的 secreteKey 用它解出密钥池。
 *
 * 不引 Node 的 crypto：RN 运行时（Hermes）没有它。这三个算法都用 @noble 的纯 JS
 * 实现，体积小且不依赖平台。
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ecb, gcm } from '@noble/ciphers/aes.js';
import { md5 } from './md5.ts';
import { toHex, utf8 } from './bytes.ts';

export function hmacSha256(
  key: string | Uint8Array,
  msg: string | Uint8Array,
): Uint8Array {
  const k = typeof key === 'string' ? utf8(key) : key;
  const m = typeof msg === 'string' ? utf8(msg) : msg;
  return hmac(sha256, k, m);
}

export function hmacHex(
  key: string | Uint8Array,
  msg: string | Uint8Array,
): string {
  return toHex(hmacSha256(key, msg));
}

export function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plain: Uint8Array,
): Uint8Array {
  return gcm(key, iv).encrypt(plain);
}

export function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ct: Uint8Array,
): Uint8Array {
  return gcm(key, iv).decrypt(ct);
}

export function aesEcbDecrypt(key: Uint8Array, ct: Uint8Array): Uint8Array {
  return ecb(key).decrypt(ct);
}

export function md5Hex(b: Uint8Array): string {
  return toHex(md5(b));
}
