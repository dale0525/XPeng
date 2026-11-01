/**
 * 服务端按 deviceId 下发的密钥池。
 *
 * `POST /biz/v5/secure/teeIndiv4App` 返回的 `secreteKey` 是 base64 密文，用
 * `md5(deviceId)` 作 AES-128 密钥按 ECB 解开，得到 `{index:{index,key}}` 的明文，
 * 每个 `key` 再 base64 解一次就是 16 字节的 AES-GCM 密钥。
 *
 * **不能缓存**：每次调用返回的池都不同，服务端只认最近一次。用上一次的池签名会
 * 得到 12110009（信封解不开）。
 */
import { base64Decode, fromHex, stripPkcs7, utf8, utf8Decode } from './bytes.ts';
import { aesEcbDecrypt, md5Hex } from './crypto.ts';

export type KeyPool = Record<number, Uint8Array>;

export function parseKeyPool(secreteKeyB64: string, deviceId: string): KeyPool {
  const key = fromHex(md5Hex(utf8(deviceId)));
  const ct = base64Decode(secreteKeyB64);
  const plain = utf8Decode(stripPkcs7(aesEcbDecrypt(key, ct)));
  const pool: KeyPool = {};
  const re = /(\d+):\{"index":\d+,"key":"([^"]+)"\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    pool[Number(m[1])] = base64Decode(m[2]);
  }
  return pool;
}
