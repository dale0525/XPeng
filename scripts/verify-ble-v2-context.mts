import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BleV2ContextService, isP5BleV2Vehicle } from '../packages/protocol/src/ble-v2-context.ts';

test('only the evidenced DF vehicle code enables P5 V2 preparation', () => {
  assert.equal(isP5BleV2Vehicle({ vehicleTypeCode: 'DF' }), true);
  for (const vehicleTypeCode of ['D55', 'P5', 'E28', '', 'df']) {
    assert.equal(isP5BleV2Vehicle({ vehicleTypeCode }), false);
  }
});

const path = '/digital-key/v2/key/ble/getBleInfo';
function fixture() {
  const calls: { path: string; body: unknown }[] = [];
  const prepared: unknown[][] = [];
  const service = new BleV2ContextService(async (path, body) => {
    calls.push({ path, body });
    return { macAddress: 'aa:bb:cc:dd:ee:ff' };
  }, { prepare: async (...args) => { prepared.push(args); } });
  return { service, calls, prepared };
}

test('prepare obtains MAC and prepares material without consuming or using a radio', async () => {
  const { service, calls, prepared } = fixture();
  const context = await service.prepare('account-a', 'vin-a');
  assert.deepEqual(calls, [{ path, body: { vin: 'vin-a' } }]);
  assert.deepEqual(prepared, [['account-a', 'vin-a']]);
  assert.deepEqual(context, { vin: 'vin-a', mac: 'AA:BB:CC:DD:EE:FF', keyMac: 'AA:BB:CC:DD:EE:FF', messageId: 1 });
  assert.deepEqual(service.get('account-a', 'vin-a'), context);
  assert.equal(service.get('account-b', 'vin-a'), undefined);
  assert.equal(service.get('account-a', 'vin-b'), undefined);
});

test('concurrent preparation shares requests and caches the prepared context', async () => {
  const { service, calls, prepared } = fixture();
  await Promise.all([service.prepare(1, 'vin-a'), service.prepare(1, 'vin-a')]);
  await service.prepare(1, 'vin-a');
  assert.equal(calls.length, 1);
  assert.equal(prepared.length, 1);
});

test('unsupported external MAC shapes fail before material preparation', async () => {
  for (const response of [null, {}, { macAddress: 5 }, { macAddress: '' }, { macAddress: 'aabbccddeeff' }]) {
    let prepared = false;
    const service = new BleV2ContextService(async () => response, {
      prepare: async () => { prepared = true; },
    });
    await assert.rejects(service.prepare(1, 'vin-a'), /getBleInfo.*macAddress/i);
    assert.equal(prepared, false);
    assert.equal(service.get(1, 'vin-a'), undefined);
  }
});

test('MAC and material failures propagate and do not cache a successful context', async () => {
  const failure = new Error('fixture failure');
  for (const stage of ['mac', 'material']) {
    const service = new BleV2ContextService(async () => {
      if (stage === 'mac') throw failure;
      return { macAddress: 'AA:BB:CC:DD:EE:FF' };
    }, { prepare: async () => { throw failure; } });
    await assert.rejects(service.prepare(1, 'vin-a'), error => error === failure);
    assert.equal(service.get(1, 'vin-a'), undefined);
  }
});

test('reset invalidates in-flight context and clears account and VIN caches', async () => {
  let release!: () => void;
  const service = new BleV2ContextService(async () => ({ macAddress: 'AA:BB:CC:DD:EE:FF' }), {
    prepare: () => new Promise<void>(resolve => { release = resolve; }),
  });
  const pending = service.prepare(1, 'vin-a');
  await Promise.resolve();
  service.reset();
  release();
  await assert.rejects(pending, /reset/i);
  assert.equal(service.get(1, 'vin-a'), undefined);
  const { service: cached } = fixture();
  await cached.prepare(1, 'vin-a');
  cached.reset();
  assert.equal(cached.get(1, 'vin-a'), undefined);
});
