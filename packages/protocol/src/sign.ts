/**
 * 请求签名与 `Xp-Authorization` 信封。
 *
 * 服务端认两层签名，两层都用 app secret 做 HMAC-SHA256：
 * - 内层 `xpSign`：canonical 串由**请求头**决定，密文装进 `Xp-Authorization`；
 * - 外层 `Xp-Signature`：canonical 串里含 `Xp-Authorization` 本身。
 *
 * 信封布局（国内版标记 `XA`）：
 *   [1B tee_len][tee_id][2B 标记][1B ver][1B idx][1B dev_len][device_id]
 *   [1B nonce_len][8B ts BE][1B iv_len][iv][AES-GCM 密文]
 * `tee_id` 传空串时**不写 tee_len 段**——这是唯一能被服务端解开的形式。
 */
import {
  base64Encode,
  base64Decode,
  beBytes,
  concat,
  stripPkcs7,
  toHex,
  utf8,
  utf8Decode,
} from './bytes.ts';
import { md5 } from './md5.ts';
import { aesGcmDecrypt, aesGcmEncrypt, hmacHex } from './crypto.ts';
import {
  APP_ID,
  APP_SECRET,
  BRAND,
  APP_VERSION,
  DEVICE_BRAND,
  DEVICE_MODEL,
  VERSION_CODE,
} from './config.ts';

export type HeaderMap = Record<string, string>;

/** 签名用的 canonical 串：`METHOD & 排序后的 XP-* 头 & body 的 md5`。 */
export function canon(method: string, body: string, headers: HeaderMap): string {
  const picked: Array<[string, string]> = [];
  for (const k of Object.keys(headers)) {
    const up = k.toUpperCase();
    if (up.startsWith('XP-') && up !== 'XP-SIGNATURE') {
      picked.push([up, headers[k]]);
    }
  }
  picked.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const tail = body && (method === 'POST' || method === 'PUT') ? md5Hex(body) : '';
  return (
    `${method}&` +
    picked.map(([k, v]) => `${k}=${v}`).join('&') +
    `&${tail}`
  );
}

function md5Hex(body: string): string {
  return toHex(md5(utf8(body)));
}

/** 设备指纹串。`di` 必须与解密钥池时用的设备号一致，否则池解不出来。 */
export function clientFingerprint(deviceId: string): string {
  return (
    `ve=${APP_VERSION};br=${DEVICE_BRAND};mo=${DEVICE_MODEL};st=1;sv=17;no=null;` +
    `pn=com.xiaopeng.mycarinfo;cn=gw;re=1080x2209;ma=;ro=Other;me=4.10G;` +
    `cp=0;cr=1;rvc=0;pvc=;nt=WIFI;t=0;gp=;di=${deviceId}`
  );
}

/**
 * 构造请求头。业务请求必须把 `Xp-Uid` 设成 token 所属账号——它参与内层签名，
 * 所以要在算 `xpSign` **之前**设好，否则带 token 也恒 12010101。
 */
export function baseHeaders(deviceId: string, uid?: string | number): HeaderMap {
  const ts = Date.now();
  const h: HeaderMap = {
    'Xp-Appid': APP_ID,
    'Xp-Brand': BRAND,
    'Xp-Client-Encoding': 'None',
    'Xp-Client-Type': '1',
    'Xp-Uid': uid === undefined ? '0' : String(uid),
    'Xp-Client': clientFingerprint(deviceId),
    'Xp-Nonce': `${ts}0001`,
    'Xp-Encryption-Type': '2',
    'Xp-Tee-Version': '2',
  };
  return h;
}

export interface BuildAuthOptions {
  deviceId: string;
  keyIndex: number;
  key: Uint8Array;
  plain: string;
  version?: number;
  nonceLength?: number;
  iv?: Uint8Array;
  tsMs?: number;
}

export function buildAuth(opts: BuildAuthOptions): string {
  const tsMs = opts.tsMs ?? Date.now();
  const iv = opts.iv ?? randomIv();
  const ct = aesGcmEncrypt(opts.key, iv, utf8(opts.plain));
  const raw = concat(
    utf8('XA'),
    new Uint8Array([opts.version ?? 2, opts.keyIndex & 0xff]),
    new Uint8Array([opts.deviceId.length]),
    utf8(opts.deviceId),
    new Uint8Array([opts.nonceLength ?? 36]),
    beBytes(tsMs, 8),
    new Uint8Array([iv.length]),
    iv,
    ct,
  );
  return base64Encode(raw);
}

function randomIv(): Uint8Array {
  const iv = new Uint8Array(12);
  const t = Date.now();
  for (let i = 0; i < 12; i++) {
    iv[i] = (Math.random() * 256) ^ ((t >> (i % 6)) & 0xff);
  }
  return iv;
}

/** 给一组头补上外层 `Xp-Signature`。 */
export function withOuterSignature(body: string, headers: HeaderMap): HeaderMap {
  const sig = hmacHex(APP_SECRET, canon('POST', body, headers));
  return { ...headers, 'Xp-Signature': sig };
}

/**
 * 组装内层明文：`UUID + base64({"xpSign":…})` + 可选的 `&accessToken=` / `&refreshToken=`。
 * 内层明文是客户端唯一可控、且实测仍能正常解封的载体。
 */
export function innerPlain(
  body: string,
  headers: HeaderMap,
  extra?: { accessToken?: string; refreshToken?: string },
): { plain: string; nonceLength: number } {
  const xpSign = hmacHex(APP_SECRET, canon('POST', body, headers));
  const nonce = uuid();
  const b64 = base64Encode(utf8(JSON.stringify({ xpSign })));
  let plain = nonce + b64;
  if (extra?.accessToken) plain += '&accessToken=' + extra.accessToken;
  if (extra?.refreshToken) plain += '&refreshToken=' + extra.refreshToken;
  return { plain, nonceLength: nonce.length };
}

function uuid(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

/**
 * 解开 WEEB/sData 信封（服务端 → 客户端）。
 * 布局：`XA` + ver + keyIndex@3 + devlen + deviceId + nonceLen + 8B ts + ivLen + iv + ct。
 * 明文前 32 B 是随机数，其后才是 JSON 或 JWT。
 */
export function unwrapEnvelope(
  b64: string,
  pool: Record<number, Uint8Array>,
): { payload: Uint8Array; keyIndex: number } {
  const raw = base64Decode(b64);
  if (raw.length < 60) throw new Error(`信封太短: ${raw.length} B`);
  if (raw[0] !== 0x58 || raw[1] !== 0x41) {
    throw new Error(`信封标记不是 XA: ${toHex(raw.slice(0, 2))}`);
  }
  const keyIndex = raw[3];
  const ivLen = raw[46];
  const ivStart = 47;
  const iv = raw.slice(ivStart, ivStart + ivLen);
  const ct = raw.slice(ivStart + ivLen);
  const key = pool[keyIndex];
  if (!key) {
    throw new Error(`keyIndex=${keyIndex} 不在密钥池（有 ${Object.keys(pool).join(',')}）`);
  }
  const pt = aesGcmDecrypt(key, iv, ct);
  return { payload: stripPkcs7(pt).slice(32), keyIndex };
}

/** 解开信封并按 JSON 解析。 */
export function unwrapJson(
  b64: string,
  pool: Record<number, Uint8Array>,
): any {
  const { payload } = unwrapEnvelope(b64, pool);
  return JSON.parse(utf8Decode(payload));
}

/** 解开信封并取 JWT（明文前 32 B 随机数之后整段就是 JWT）。 */
export function unwrapJwt(
  b64: string,
  pool: Record<number, Uint8Array>,
): { jwt: string; keyIndex: number } {
  const { payload, keyIndex } = unwrapEnvelope(b64, pool);
  const jwt = utf8Decode(payload);
  if (!jwt.startsWith('eyJ')) throw new Error(`明文不是 JWT: ${jwt.slice(0, 20)}`);
  return { jwt, keyIndex };
}
