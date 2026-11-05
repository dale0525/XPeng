/**
 * 小鹏 BLE 车控帧的编解码（D55 协议族）。
 *
 * 与 `scripts/ble_frame.py` 逐字节等价——那边是实车 HCI 抓包验证过的参考实现，
 * 这边是给自研客户端用的 TypeScript 版本。两帧实车样本都能 parse → rebuild 后
 * 逐字节还原，验收靠 `scripts/ble-frame-selftest.ts`。
 *
 * 本模块只做字节层面的编解码，不含签名与密钥派生：
 *   - 签名是 ECDSA P-256 + SHA-256，消息为 ED 的 16 字节原文（teardown §6.18f）
 *   - KI 是设备侧持有的长期共享密钥（teardown §6.19h/§6.19i）
 * 所以 `construct()` 要求调用方把 ki / ed / sn 都准备好。
 *
 * 帧从哪来、末尾的 0xe0 是谁加的，见 teardown §6.77n：
 * `createAuthFrameData` 收到算好的 data 后追加 0xe0，再套 TBox 外层出 0xED 帧。
 */
import { concat, fromHex, readBe } from './bytes.ts';
import { md5 } from './md5.ts';

/** 内层明文魔数。 */
export const MAGIC = 'XPBKTH';
/** 车控通道。 */
export const CHANNEL_COMMAND = 0xed;

/** 已实测的指令码（teardown §6.18a）。 */
export const CMD = {
  UNLOCK: 0x01,
  LOCK: 0x02,
  /** 开/关后备箱共用同一个 cmd，靠头部字节区分方向（§6.20b）。 */
  TRUNK: 0x04,
  FLASH_LIGHTS: 0x26,
  WINDOW_OPEN: 0x0c,
  WINDOW_CLOSE: 0x0d,
} as const;

/** Captured outer operation types. */
export const TYPE = {
  UNLOCK: 0x01,
  LOCK: 0x02,
  TRUNK_OPEN: 0x03,
  TRUNK_CLOSE: 0x04,
  FLASH_LIGHTS: 0x05,
  WINDOW_OPEN: 0x06,
  WINDOW_CLOSE: 0x07,
} as const;

/**
 * CRC-32，init=0、末尾不取反。
 *
 * 标准 zlib 用 init=0xFFFFFFFF 且末尾取反，与本协议不符；实车两帧的 TBox CRC
 * 只在 init=0、无最终异或时才吻合（teardown §6.6 曾记错）。
 */
export function crc32Init0(data: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return c >>> 0;
}

export interface TboxFrame {
  channel: number;
  flag: number;
  /** 分片长度，等于 body 长度。 */
  chunkLen: number;
  /** 只计 payload 长度，不含 type 字节。 */
  tboxLen: number;
  tboxCrc: number;
  type: number;
  payload: Uint8Array;
}

/**
 * 切出分片头与 TBox 外层。
 *
 * 布局： [channel 1B][flag 1B][chunk_len 1B][tbox_len 2B BE][crc32 4B BE][type 1B][payload]
 */
export function parseTbox(v: Uint8Array): TboxFrame {
  if (v.length < 7) throw new Error(`frame too short: ${v.length}`);
  const body = v.subarray(3);
  return {
    channel: v[0],
    flag: v[1],
    chunkLen: v[2],
    tboxLen: readBe(body, 0, 2),
    tboxCrc: readBe(body, 2, 4),
    type: body[6],
    payload: body.subarray(7),
  };
}

export function buildTbox(
  channel: number,
  flag: number,
  type: number,
  payload: Uint8Array,
): Uint8Array {
  const len = payload.length;
  const body = concat(
    [len >>> 8, len & 0xff],
    (() => {
      const c = crc32Init0(payload);
      return [(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];
    })(),
    [type],
    payload,
  );
  return concat([channel, flag, body.length & 0xff], body);
}

export interface CommandPayload {
  /** 9 字节头部，两帧实测相同，含义未定。 */
  header: Uint8Array;
  flagByte: number;
  /** 实测 tag 为 KI / ED / SN（§6.18b）。 */
  tlvs: Record<string, Uint8Array>;
  cmd: number;
}

/**
 * 切出 XPBKTH 内层。
 *
 * 布局： "XPBKTH" 6B | header 9B | flag_byte 1B | TLV* | cmdCode 1B
 * TLV： tag 2B ASCII、length 2B BE。
 */
export function parseCommandPayload(pay: Uint8Array): CommandPayload {
  const magic = String.fromCharCode(...pay.subarray(0, 6));
  if (magic !== MAGIC) throw new Error(`bad magic: ${magic}`);

  const tlvs: Record<string, Uint8Array> = {};
  let i = 16;
  while (i < pay.length - 1) {
    const tag = String.fromCharCode(pay[i], pay[i + 1]);
    const ln = readBe(pay, i + 2, 2);
    tlvs[tag] = pay.subarray(i + 4, i + 4 + ln);
    i += 4 + ln;
  }
  if (i !== pay.length - 1) {
    throw new Error(`TLV parse did not close: stopped at ${i}, payload ${pay.length}`);
  }

  return {
    header: pay.subarray(6, 15),
    flagByte: pay[15],
    tlvs,
    cmd: pay[i],
  };
}

export function buildCommandPayload(
  header: Uint8Array,
  flagByte: number,
  ki: Uint8Array,
  ed: Uint8Array,
  sn: Uint8Array,
  cmd: number,
): Uint8Array {
  // 手写 ASCII→字节，不用 TextEncoder：Hermes 不保证提供（见 bytes.ts 头注释）。
  const magic: number[] = [];
  for (let i = 0; i < MAGIC.length; i++) magic.push(MAGIC.charCodeAt(i));
  const parts: Array<Uint8Array | number[]> = [magic, header, [flagByte]];
  for (const [tag, val] of [
    ['KI', ki],
    ['ED', ed],
    ['SN', sn],
  ] as Array<[string, Uint8Array]>) {
    parts.push([tag.charCodeAt(0), tag.charCodeAt(1)], [val.length >>> 8, val.length & 0xff], val);
  }
  parts.push([cmd]);
  return concat(...parts);
}

/**
 * `ef0110` 的 16 字节 payload（teardown §6.80）。
 *
 * native `createAuthKey`(0x8c13c) 的式子：
 *
 * ```
 * seed4  = hexStringToBytes( hexStringIncrement( stripColon(keyString)[-10:][:8] ) )
 * K1     = MD5(seed4)                  ← hmac_md5 的 key
 * msg    = app_n(4B) || car_n(4B)      ← hmac_md5 的 msg
 * ef0110 = HMAC-MD5(K1, msg)           → 16 字节
 * ```
 *
 * `keyString` must identify the target vehicle module. The later slave-module
 * A/B experiment (§6.81b) requires that module's own MAC, not a cached primary MAC.
 * It is not KI: passing KI to native createAuthKey caused an abort (§6.80e).
 *
 * 188 组真实抓包 188/188 命中，验收靠 `scripts/ble-kdf-verify.py`。
 */
export function deriveAuth1Payload(
  appN: Uint8Array,
  carN: Uint8Array,
  keyString: string,
): Uint8Array {
  if (appN.length !== 4 || carN.length !== 4) {
    throw new Error(`nonce must be 4 bytes: app=${appN.length} car=${carN.length}`);
  }
  const stripped = keyString.replace(/:/g, '');
  const last10 = stripped.length >= 10 ? stripped.slice(-10) : stripped;
  const first8 = last10.slice(0, 8);
  const seed4 = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    // hexStringIncrement 逐 nibble +1 mod 16，两个 nibble 合成一个字节
    const hi = (parseInt(first8[i * 2], 16) + 1) & 0xf;
    const lo = (parseInt(first8[i * 2 + 1], 16) + 1) & 0xf;
    seed4[i] = (hi << 4) | lo;
  }
  const k1 = md5(seed4);
  const msg = concat(appN, carN);
  return hmacMd5(k1, msg);
}

/**
 * HMAC-MD5（RFC 2104）。
 *
 * `crypto.ts` 的 `hmac()` 要的是 noble 的 `Hash` 实例，而本仓库的 `md5()` 是个
 * 一次性函数，所以这里手写——只多几行，不值得为它改 md5.ts 的接口。
 */
export function hmacMd5(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > 64) k = md5(k);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  return md5(concat(opad, md5(concat(ipad, msg))));
}

/**
 * 组装一条完整车控帧。
 *
 * header 两帧实测相同（01 00 00 83 6a 7b 5f e0 00），含义未定，默认沿用该常量。
 * flag_byte 实测 = cmd + 0x52（解锁 0x53 'S'、上锁 0x54 'T'），此处按该规律生成。
 */
export function construct(
  ki: Uint8Array,
  ed: Uint8Array,
  sn: Uint8Array,
  cmd: number,
  header?: Uint8Array,
): Uint8Array {
  const h = header ?? fromHex('010000836a7b5fe000');
  const payload = buildCommandPayload(h, cmd + 0x52, ki, ed, sn, cmd);
  return buildTbox(CHANNEL_COMMAND, 0x11, cmd, payload);
}

/**
 * 服务端 `getXpKeyAuthData` 的 `authDataList[i]` → 可写入车端的 `ed118b` 帧。
 *
 * Server sequence bytes are preserved (appendix §6.42b-3/4):
 *
 * ```
 * 服务端：XPBKTH | ver(3) | flag(1) | r4(4) | seq(2) | TLV(KI,ED,SN)
 * App   ：authData 原样保留 | cmd(1)
 * ```
 *
 * The caller supplies the command; flag alone does not identify it in all captures.
 * 外层补 `ed 11 <chunk_len> | tbox_len | crc32 | type`，CRC 覆盖整个内层。
 *
 * 判据：实车 UNLOCK/LOCK 两帧反向还原后逐字节一致；99 条服务端帧全部闭合。
 * 验收靠 `scripts/verify-server-frames.mts`。
 */
export interface ServerAuthData {
  flag: number;
  r4: Uint8Array;
  seq: number;
  tlvs: Record<string, Uint8Array>;
  inner: Uint8Array;
}

export function parseServerAuthData(raw: Uint8Array): ServerAuthData {
  const magic = String.fromCharCode(...raw.subarray(0, 6));
  if (magic !== MAGIC) throw new Error(`bad magic: ${magic}`);
  if (raw.length < 16) throw new Error(`too short: ${raw.length}`);

  const tlvs: Record<string, Uint8Array> = {};
  let i = 16;
  while (i + 4 <= raw.length) {
    const tag = String.fromCharCode(raw[i], raw[i + 1]);
    if (tag !== 'KI' && tag !== 'ED' && tag !== 'SN') break;
    const ln = readBe(raw, i + 2, 2);
    tlvs[tag] = raw.subarray(i + 4, i + 4 + ln);
    i += 4 + ln;
  }
  if (i !== raw.length) {
    throw new Error(`TLV did not close: stopped at ${i}, frame ${raw.length}`);
  }
  for (const need of ['KI', 'ED', 'SN']) {
    if (!tlvs[need]) throw new Error(`missing TLV ${need}`);
  }

  return {
    flag: raw[9],
    r4: raw.subarray(10, 14),
    seq: readBe(raw, 14, 2),
    tlvs,
    inner: raw,
  };
}

/** Preserve server authData, then append the caller's command byte. */
export function toAppInner(raw: Uint8Array, cmd: number): Uint8Array {
  parseServerAuthData(raw);
  if (!Number.isInteger(cmd) || cmd < 0 || cmd > 0xff) {
    throw new Error(`command must be one byte: ${cmd}`);
  }
  return concat(raw, [cmd]);
}

/** Wrap signed authData without changing its server-assigned sequence. */
export function wrapAuthData(raw: Uint8Array, cmd: number, tboxType = cmd): Uint8Array {
  const inner = toAppInner(raw, cmd);
  return buildTbox(CHANNEL_COMMAND, 0x11, tboxType, inner);
}
