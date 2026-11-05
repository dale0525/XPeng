/**
 * 用真实数据验证「服务端 authData → 车端可写帧」的 TS 实现（teardown §6.82）。
 *
 * 跑法：node --experimental-strip-types scripts/verify-server-frames.mts
 */
import { readFileSync, existsSync } from 'node:fs';
import { wrapAuthData, parseServerAuthData, parseTbox, buildTbox } from '../packages/protocol/src/ble.ts';
import { fromHex, toHex } from '../packages/protocol/src/bytes.ts';

const CAPTURED: Record<string, string> = {
  UNLOCK:
    'ed118b0084425b88d0015850424b5448010000836a7b5fe000534b490010' +
    '7a32fc31ace4afd950b24f60eb9b254545440010fd5dacb090f551221a93' +
    'e7b5d8769288534e00473045022100f78a764c9539c2f04bf4a626cbd4' +
    '7e0852cff0035c8fc6de167fcfbb3498763f02205f7a3c8e05e06c0a9b' +
    'c2c0499cc54510fdd7cbfd5e1d07d463971a3a30554ab601',
  LOCK:
    'ed118b00845bdbe2ed025850424b5448010000836a7b5fe000544b4900107a32fc31ace4afd950b24f60eb9b2545454400108f165547ab35e7108741369341684d23534e0047304502210085fb448e93add8730a5bea75be26d31e7d72bbffd5e3263bfda9dfca69fd12dd022075d726384c2c963e8d3610bda6eecb9684e85e8328bec8868dadd6bb1705912102',
};

let ok = true;
console.log('1) 实车抓包帧反证封装规则');
for (const [name, hx] of Object.entries(CAPTURED)) {
  const raw = fromHex(hx);
  const t = parseTbox(raw);
  const inner = t.payload;
  const authData = inner.subarray(0, inner.length - 1);
  const rebuilt = wrapAuthData(authData, inner[inner.length - 1], t.type);
  const same = toHex(rebuilt) === toHex(raw);
  console.log(`  ${name}: len=${raw.length} authData_preserved=${same}`);
  ok = ok && same;
}

console.log('2) 服务端 authData 全量转换（work/db/XpVehicle.db）');
const db = 'work/db/XpVehicle.db';
if (!existsSync(db)) {
  console.log('  跳过：数据库不存在');
} else {
  // 用 sqlite3 CLI 取 token_json，避免为脚本引入 sqlite 依赖
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('sqlite3', [db, 'select token_json from xp_vehicle_xp_key_message;'], {
    encoding: 'utf8',
  });
  const rows = out.trim().split('\n').filter(Boolean);
  let parsed = 0;
  let rt = 0;
  for (const line of rows) {
    const msg = JSON.parse(line).message as string;
    const raw = Uint8Array.from(Buffer.from(msg, 'base64'));
    try {
      parseServerAuthData(raw);
      parsed++;
    } catch (e) {
      console.log(`  parse fail: ${(e as Error).message}`);
      continue;
    }
    const frame = wrapAuthData(raw, 0x01);
    const t = parseTbox(frame);
    const seq = parseServerAuthData(raw).seq;
    const preserved = toHex(t.payload.subarray(0, -1)) === toHex(raw);
    if (preserved && seq === ((raw[14] << 8) | raw[15]) && t.payload.at(-1) === 0x01 &&
        toHex(buildTbox(t.channel, t.flag, t.type, t.payload)) === toHex(frame)) rt++;
  }
  console.log(`  服务端帧 ${rows.length} 条：parse ${parsed}/${rows.length}  roundtrip ${rt}/${rows.length}`);
  ok = ok && parsed === rows.length && rt === rows.length;
}

console.log('RESULT', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
