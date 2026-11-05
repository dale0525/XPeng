import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS } from '../packages/protocol/src/commands.ts';
import { BLE_ONLY_V2_COMMAND_IDS, sendVehicleCommand } from '../packages/protocol/src/ble-v2-routing.ts';

const vehicle = { vin: 'fixture-vin', vehicleTypeCode: 'DF' };
const command = (id: string) => COMMANDS.find(def => def.id === id)!;

function fixture(code = 200) {
  const ble: unknown[][] = [];
  const mqtt: unknown[] = [];
  const mqttResult = { ok: true, msgId: 'fixture-msg' };
  return {
    ble, mqtt, mqttResult,
    links: {
      executePreparedV2: async (vin: string, commandCode: number) => {
        ble.push([vin, commandCode]);
        return { code, commandCode };
      },
      send: async (def: (typeof COMMANDS)[number]) => {
        mqtt.push(def);
        return mqttResult;
      },
    },
  };
}

const evidenced = [
  ['door.unlock', 1], ['door.lock', 2], ['trunk.open', 0x04], ['trunk.close', 0x04],
  ['light.flash', 0x26], ['window.down', 0x0c], ['window.up', 0x0d],
] as const;
const evidencedIds = evidenced.map(([id]) => id);

test('DF evidenced buttons send exactly one prepared BLE command with the current VIN', async () => {
  for (const [id, code] of evidenced) {
    const f = fixture();
    const result = await sendVehicleCommand(vehicle, command(id), f.links);
    assert.equal(result.ok, true);
    assert.deepEqual(f.ble, [['fixture-vin', code]]);
    assert.deepEqual(f.mqtt, []);
  }
});

test('DF buttons without BLE evidence retain MQTT semantics', async () => {
  for (const def of COMMANDS.filter(def => !evidencedIds.includes(def.id as typeof evidencedIds[number]))) {
    const f = fixture();
    assert.equal(await sendVehicleCommand(vehicle, def, f.links), f.mqttResult);
    assert.deepEqual(f.mqtt, [def]);
    assert.deepEqual(f.ble, []);
  }
});

test('non-DF vehicles retain MQTT for evidenced MQTT buttons but never send guessed trunk commands', async () => {
  for (const vehicleTypeCode of ['D55', 'P5', 'E28', '', 'df']) {
    for (const def of COMMANDS) {
      const f = fixture();
      const result = await sendVehicleCommand({ ...vehicle, vehicleTypeCode }, def, f.links);
      if (BLE_ONLY_V2_COMMAND_IDS.includes(def.id as typeof BLE_ONLY_V2_COMMAND_IDS[number])) {
        assert.equal(result.ok, false);
        assert.match(result.error ?? '', /no evidenced MQTT fallback/);
        assert.deepEqual(f.mqtt, []);
      } else {
        assert.equal(result, f.mqttResult);
        assert.deepEqual(f.mqtt, [def]);
      }
      assert.deepEqual(f.ble, []);
    }
  }
});

test('BLE acknowledgement other than 200 fails without MQTT fallback or retry', async () => {
  for (const code of [0, 1, 0xffff]) {
    const f = fixture(code);
    assert.equal((await sendVehicleCommand(vehicle, command('door.lock'), f.links)).ok, false);
    assert.equal(f.ble.length, 1);
    assert.deepEqual(f.mqtt, []);
  }
});

test('acknowledgement 163 reports sent but unconfirmed without retry or MQTT fallback', async () => {
  for (const [id, code] of evidenced) {
    const f = fixture(163);
    const result = await sendVehicleCommand(vehicle, command(id), f.links);
    assert.equal(result.ok, false);
    assert.equal(result.unconfirmed, true);
    assert.equal(result.error, 'BLE acknowledgement code: 163');
    assert.equal(f.ble.length, 1);
    assert.deepEqual(f.ble[0][1], code);
    assert.deepEqual(f.mqtt, []);
  }
});

test('unprepared, preparation failure and BLE rejection fail without fallback or retry', async () => {
  for (const synchronous of [true, false]) {
    const f = fixture();
    let attempts = 0;
    const failure = new Error(synchronous ? 'context not prepared' : 'fixture BLE failure');
    f.links.executePreparedV2 = () => {
      attempts++;
      if (synchronous) throw failure;
      return Promise.reject(failure);
    };
    const result = await sendVehicleCommand(vehicle, command('door.unlock'), f.links);
    assert.equal(result.ok, false);
    assert.equal(result.error, failure.message);
    assert.equal(attempts, 1);
    assert.deepEqual(f.mqtt, []);
  }
});

test('MQTT rejection result remains failed', async () => {
  const f = fixture();
  f.mqttResult.ok = false;
  assert.equal((await sendVehicleCommand(vehicle, command('hvac.on'), f.links)).ok, false);
  assert.deepEqual(f.ble, []);
});
