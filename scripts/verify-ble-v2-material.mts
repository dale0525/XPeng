import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BleV2MaterialService,
  describeVerifyResponseShape,
  type BleV2MaterialCall,
} from '../packages/protocol/src/ble-v2-material.ts';

const authPath = '/digital-key/v1/key/ble/getXpKeyAuthData';
const verifyPath = '/digital-key/v1/key/common/getVerifyCode';
const auth = () => ({ cardNo: 'card-fixture', authDataList: ['b25l', 'dHdv'] });
const verify = () => ({ verifyCodes: {
  '1': { code: '123456', index: 7 },
  '2': { code: 'abcdef', index: 8 },
} });
function fixture() {
  const calls: { path: string; body: unknown }[] = [];
  const call: BleV2MaterialCall = async (path, body) => {
    calls.push({ path, body });
    return path === authPath ? auth() : verify();
  };
  return { calls, service: new BleV2MaterialService(call) };
}

test('prepare uses confirmed request bodies; take removes FIFO material before any BLE ACK', async () => {
  const { calls, service } = fixture();
  await service.prepare('account-a', 'vin-a');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.find(c => c.path === authPath)?.body, { vin: 'vin-a', count: 300, autoCreateKey: false });
  assert.deepEqual(calls.find(c => c.path === verifyPath)?.body, { vin: 'vin-a', typeList: [1, 2] });
  assert.deepEqual(await service.take('account-a', 'vin-a'), {
    cardNo: 'card-fixture', message: 'b25l', verifyCode: { code: '123456', index: 7 },
  });
  assert.equal((await service.take('account-a', 'vin-a')).message, 'dHdv');
  assert.equal(calls.length, 2);
});

test('concurrent callers share one refill and cannot double-consume', async () => {
  const { calls, service } = fixture();
  const materials = await Promise.all([service.take('account-a', 'vin-a'), service.take('account-a', 'vin-a')]);
  assert.deepEqual(materials.map(m => m.message), ['b25l', 'dHdv']);
  assert.equal(calls.length, 2);
  await assert.rejects(service.take('account-a', 'vin-a'), /no unused material/i);
  assert.equal(calls.filter(call => call.path === authPath).length, 2);
});

test('consumed history is isolated by account and VIN and cleared on reset', async () => {
  const service = new BleV2MaterialService(async path => path === authPath
    ? { cardNo: 'card-fixture', authDataList: ['b25l'] } : verify());
  await service.take('account-a', 'vin-a');
  await assert.rejects(service.take('account-a', 'vin-a'), /no unused material/i);
  assert.equal((await service.take('account-b', 'vin-a')).message, 'b25l');
  assert.equal((await service.take('account-a', 'vin-b')).message, 'b25l');
  service.reset();
  assert.equal((await service.take('account-a', 'vin-a')).message, 'b25l');
});

test('batch duplicates cannot be consumed twice, including concurrent take', async () => {
  let requests = 0;
  const service = new BleV2MaterialService(async path => {
    if (path !== authPath) return verify();
    requests++;
    return { cardNo: 'card-fixture', authDataList: ['b25l', 'b25l'] };
  });
  const results = await Promise.allSettled([service.take('account-a', 'vin-a'), service.take('account-a', 'vin-a')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.match(String(rejected?.reason), /no unused material/i);
  assert.equal(requests, 2);
});

test('refill filters consumed messages while preserving new FIFO messages', async () => {
  let requests = 0;
  const service = new BleV2MaterialService(async path => {
    if (path !== authPath) return verify();
    return { cardNo: 'card-fixture', authDataList: ++requests === 1 ? ['b25l'] : ['b25l', 'dHdv', 'dHdv'] };
  });
  assert.equal((await service.take('account-a', 'vin-a')).message, 'b25l');
  assert.equal((await service.take('account-a', 'vin-a')).message, 'dHdv');
  await assert.rejects(service.take('account-a', 'vin-a'), /no unused material/i);
  assert.equal(requests, 3);
});

test('account, VIN and reset isolate cached material', async () => {
  const { calls, service } = fixture();
  await service.take('account-a', 'vin-a');
  assert.equal((await service.take('account-b', 'vin-a')).message, 'b25l');
  assert.equal((await service.take('account-a', 'vin-b')).message, 'b25l');
  assert.equal(calls.length, 6);
  service.reset();
  assert.equal((await service.take('account-a', 'vin-a')).message, 'b25l');
  assert.equal(calls.length, 8);
});

test('reset rejects in-flight material and cannot repopulate the cache', async () => {
  let release!: (data: unknown) => void;
  let authCalls = 0;
  const service = new BleV2MaterialService(async path => {
    if (path !== authPath) return verify();
    if (++authCalls === 1) return new Promise(resolve => { release = resolve; });
    return auth();
  });
  const pending = service.take('account-a', 'vin-a');
  service.reset();
  release(auth());
  await assert.rejects(pending, /reset/i);
  assert.equal((await service.take('account-a', 'vin-a')).message, 'b25l');
  assert.equal(authCalls, 2);
});

test('nullable or absent verify index is preserved; code is HEX string', async () => {
  for (const verifyCode of [{ code: 'aabb', index: null }, { code: 'aabb' }]) {
    const service = new BleV2MaterialService(async path => path === authPath ? auth() : {
      verifyCodes: { '1': verifyCode },
    });
    assert.deepEqual((await service.take('account-a', 'vin-a')).verifyCode, verifyCode);
  }
});

test('HTTP rejection propagates and a later call can retry', async () => {
  const failure = new Error('offline fixture failure');
  let fails = true;
  const service = new BleV2MaterialService(async path => {
    if (fails) throw failure;
    return path === authPath ? auth() : verify();
  });
  await assert.rejects(service.take('account-a', 'vin-a'), e => e === failure);
  fails = false;
  assert.equal((await service.take('account-a', 'vin-a')).message, 'b25l');
});

test('unconfirmed or malformed external shapes fail explicitly without empty success', async () => {
  for (const bad of [null, {}, { cardNo: 'card-fixture', authDataList: [] },
    { cardNo: 'card-fixture', authDataList: ['not base64!'] },
    { cardNo: 'card-fixture', messages: ['b25l'] }, { cardNo: '', authDataList: ['b25l'] }]) {
    const service = new BleV2MaterialService(async path => path === authPath ? bad : verify());
    await assert.rejects(service.take('account-a', 'vin-a'), /getXpKeyAuthData/);
  }
  for (const bad of [null, {}, { verifyCodes: { '2': { code: '123456', index: 1 } } },
    { verifyCodes: { '1': { code: '', index: 1 } } },
    { verifyCodes: { '1': { code: 'not-hex', index: 1 } } }]) {
    const service = new BleV2MaterialService(async path => path === authPath ? auth() : bad);
    await assert.rejects(service.take('account-a', 'vin-a'), /getVerifyCode/);
  }
});

test('verify response shape is described without values or raw keys', () => {
  const sensitiveKey = 'sensitive-marker-key' + 'x'.repeat(80);
  const response = {
    verifyCodes: {
      '1': { code: 'deadBEEFnotAVALUE', index: null, extra: [1, 'x'] },
      '2': { code: '0xaabbccdd', index: 2 },
    },
    wrapped: '{"1":{"code":"secret-marker"}}',
    empty: {},
    [sensitiveKey]: { nested: 'nested-secret-value' },
  };
  const diagnostic = JSON.stringify(describeVerifyResponseShape(response));
  assert.match(diagnostic, /"charset":"hex-prefix"/);
  assert.match(diagnostic, /"numeric":"integer"/);
  assert.match(diagnostic, /"charset":"other"/);
  assert.match(diagnostic, /"jsonKnownKeys":\["1"\]/);
  for (const secret of ['deadBEEFnotAVALUE', '0xaabbccdd', 'secret-marker', 'nested-secret-value',
    'sensitive-marker-key', 'x'.repeat(65)]) {
    assert.equal(diagnostic.includes(secret), false);
  }
});

test('unsupported verify response includes bounded shape diagnostic and no raw keys or values', async () => {
  const sensitiveKey = 'sensitive-key-value' + 'y'.repeat(80);
  const bad = {
    [sensitiveKey]: { code: 'nested-secret-value' },
    verifyCodes: { '1': { code: 'sensitive-code-value', index: 'seven' } },
  };
  assert.match(JSON.stringify(describeVerifyResponseShape({
    verifyCodes: {
      '1': { index: 1, code: 'aabbccddeeff00112233445566778899' },
      '2': { index: 2, code: '00112233445566778899aabbccddeeff' },
    },
  })), /"knownKeys":\["1","2"\]/);
  const service = new BleV2MaterialService(async path => path === authPath ? auth() : bad);
  await assert.rejects(service.take('account-a', 'vin-a'), (error: unknown) => {
    const message = String(error);
    assert.match(message, /shape=/);
    assert.match(message, /"charset":"other"/);
    for (const secret of ['sensitive-code-value', 'nested-secret-value', 'sensitive-key-value', 'y'.repeat(65)]) {
      assert.equal(message.includes(secret), false);
    }
    return true;
  });
});
