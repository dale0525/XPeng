/**
 * MD5（RFC 1321）。签名里 `canon()` 需要 body 的 md5，而 Hermes 没有内置实现，
 * 又不值得为它引入一整个加密库，故就地实现。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

export function md5(input: Uint8Array): Uint8Array {
  const msgLen = input.length;
  const withOne = msgLen + 1;
  const padLen = ((56 - (withOne % 64)) + 64) % 64;
  const total = withOne + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(input);
  buf[msgLen] = 0x80;
  const bitLenLo = (msgLen * 8) >>> 0;
  const bitLenHi = Math.floor(msgLen / 536870912);
  buf[total - 8] = bitLenLo & 0xff;
  buf[total - 7] = (bitLenLo >>> 8) & 0xff;
  buf[total - 6] = (bitLenLo >>> 16) & 0xff;
  buf[total - 5] = (bitLenLo >>> 24) & 0xff;
  buf[total - 4] = bitLenHi & 0xff;
  buf[total - 3] = (bitLenHi >>> 8) & 0xff;
  buf[total - 2] = (bitLenHi >>> 16) & 0xff;
  buf[total - 1] = (bitLenHi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + M[g]) | 0;
      B = (B + rotl(sum, S[i])) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}
