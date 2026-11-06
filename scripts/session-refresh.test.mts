import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XpApi, type CallResult } from '../packages/protocol/src/api.ts';
import type { HttpClient, HttpResponse } from '../packages/protocol/src/http.ts';
import type { KeyPool } from '../packages/protocol/src/keypool.ts';
import { LoginFlow, coldStartAction, refreshSession, type Session } from '../packages/protocol/src/session.ts';
import { aesGcmEncrypt } from '../packages/protocol/src/crypto.ts';
import { base64Encode, beBytes, concat, utf8 } from '../packages/protocol/src/bytes.ts';

// 服务端下发的 token 是 WEEB 信封，只能用签发那次请求的密钥池解开；
// 测试自己造一套池与信封，让 unwrapJwt 走真实解密路径而不是被 stub 掉。
const DEVICE_ID = 'a'.repeat(32);
const KEY = new Uint8Array(16).fill(0x42);
const POOL: KeyPool = { 0: KEY, 5: KEY, 7: KEY };
const IV = new Uint8Array(12).fill(0x11);
const AT_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJhdCJ9.sig-at';
const RT_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJydCJ9.sig-rt';

function envelope(payload: Uint8Array, keyIndex: number): string {
  const ct = aesGcmEncrypt(POOL[keyIndex], IV, concat(new Uint8Array(32), payload));
  const raw = concat(
    utf8('XA'),
    new Uint8Array([1, keyIndex]),
    new Uint8Array([DEVICE_ID.length]),
    utf8(DEVICE_ID),
    new Uint8Array([32]),
    beBytes(1_700_000_000_000, 8),
    new Uint8Array([IV.length]),
    IV,
    ct,
  );
  return base64Encode(raw);
}

const wrapJwt = (jwt: string, keyIndex: number) => envelope(utf8(jwt), keyIndex);

function loginSData(): string {
  return envelope(utf8(JSON.stringify({
    accessToken: wrapJwt(AT_JWT, 7),
    refreshToken: wrapJwt(RT_JWT, 5),
    uid: 123456,
    expiresIn: 7200,
    refreshExpiresIn: 7776000,
  })), 0);
}

const deadHttp: HttpClient = {
  async post(): Promise<HttpResponse> {
    throw new Error('测试不应发起真实 HTTP');
  },
};

function fakeApi(json: any, calls: any[][] = []): XpApi {
  const api = new XpApi(deadHttp);
  api.post = async (...args: any[]): Promise<CallResult> => {
    calls.push(args);
    return { json, pool: POOL, raw: { status: 200, body: '', setCookie: [] } };
  };
  return api;
}

const seed: Session = {
  accessToken: AT_JWT,
  refreshToken: RT_JWT,
  uid: 123456,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 7200_000,
  refreshExpiresAt: Date.now() + 7776000_000,
};

test('refreshSession 把续期返回的 AT/RT 信封都解成 eyJ JWT', async () => {
  const nextAt = 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJuZXctYXQifQ.sig-new-at';
  const nextRt = 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJuZXctcnQifQ.sig-new-rt';
  const calls: any[][] = [];
  const api = fakeApi({
    code: 200,
    data: {
      accessToken: wrapJwt(nextAt, 7),
      refreshToken: wrapJwt(nextRt, 5),
      expiresIn: 7200,
      refreshExpiresIn: 7776000,
    },
  }, calls);

  const before = Date.now();
  const next = await refreshSession(api, DEVICE_ID, seed);
  const after = Date.now();

  assert.equal(next.accessToken, nextAt);
  assert.equal(next.refreshToken, nextRt, 'refreshToken 必须是解开的 eyJ JWT，不能把 WEEB 信封回灌进 Session');
  assert.ok(next.refreshToken.startsWith('eyJ'));
  assert.ok(next.expiresAt >= before + 7200_000 && next.expiresAt <= after + 7200_000,
    '续期响应里的 expiresIn 必须换算成 expiresAt 落盘');
  assert.ok(next.refreshExpiresAt >= before + 7776000_000 && next.refreshExpiresAt <= after + 7776000_000,
    '续期响应里的 refreshExpiresIn 必须换算成 refreshExpiresAt 落盘');
  const opts = calls[0][4];
  assert.equal(opts.innerExtra, '&refreshToken=' + RT_JWT, 'refresh 的输入必须是 eyJ JWT');
});

test('登录成功后 Session.refreshToken 是 eyJ JWT，且带有效期元数据', async () => {
  const api = fakeApi({ code: 200, data: { sData: loginSData() } });
  const flow = new LoginFlow(api, DEVICE_ID);
  (flow as any).xid = 'test-xid';
  (flow as any).mobile = '13000000000';

  const before = Date.now();
  const session = await flow.finishWithSlider('validate');
  const after = Date.now();

  assert.equal(session.accessToken, AT_JWT);
  assert.equal(session.refreshToken, RT_JWT, '登录侧同样必须解 RT 信封，否则首次续期即 12010204');
  assert.ok(session.refreshToken.startsWith('eyJ'));
  assert.ok(session.expiresAt >= before + 7200_000 && session.expiresAt <= after + 7200_000,
    'sData 的 expiresIn 必须落进 Session');
  assert.ok(session.refreshExpiresAt >= before + 7776000_000 && session.refreshExpiresAt <= after + 7776000_000,
    'sData 的 refreshExpiresIn 必须落进 Session');
});

test('冷启动按有效期分档：active / refresh / relogin', () => {
  const t = 1_800_000_000_000;
  const base: Session = {
    ...seed,
    issuedAt: t,
    expiresAt: t + 7200_000,
    refreshExpiresAt: t + 7776000_000,
  };
  assert.equal(coldStartAction(base, t), 'active');
  assert.equal(coldStartAction(base, t + 7200_001), 'refresh',
    'AT 过了建议有效期但 RT 还在：先续期，不等业务请求报 12010101');
  assert.equal(coldStartAction(base, t + 7776000_001), 'relogin',
    'RT 明确过期：直接落登录页，不盲发必失败的 refresh');
  assert.equal(coldStartAction({ ...base, refreshToken: 'WEEB…' }, t), 'relogin',
    '旧版本落盘的 WEEB RT 刷不动，必须重新登录');
  assert.equal(coldStartAction({ ...base, expiresAt: NaN, refreshExpiresAt: NaN }, t), 'relogin',
    '旧版本没有有效期字段，不能当作可续期会话');
});
