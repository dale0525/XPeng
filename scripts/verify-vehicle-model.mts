import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicModelName, vehicleModelLabel } from '../packages/protocol/src/vehicle-model.ts';

test('maps the internal model code to the public model name', () => {
  assert.equal(publicModelName('D55'), 'P5');
  // The config key (DF) and the carTypeCode (D55) both resolve to P5.
  assert.equal(publicModelName('DF'), 'P5');
  assert.equal(publicModelName('E28'), 'P7');
  assert.equal(publicModelName('E28A'), 'P7i');
  assert.equal(publicModelName('F57'), 'P7+');
  assert.equal(publicModelName('E38'), 'G9');
  assert.equal(publicModelName('F30'), 'G6');
  assert.equal(publicModelName('D22'), 'G3i');
  assert.equal(publicModelName('D01'), 'M03');
  assert.equal(publicModelName('H93'), 'X9');
});

test('unknown, empty and null codes yield no public name', () => {
  for (const code of ['ZZ', '', 'df', 'p5', null, undefined]) {
    assert.equal(publicModelName(code as string | null | undefined), undefined);
  }
});

test('vehicleModelLabel prefers the mapped public name over whatever the car reports', () => {
  // Even if the car reports the internal name, the public name wins.
  assert.equal(vehicleModelLabel({ vehicleTypeCode: 'D55', vehicleTypeName: 'D55' }), 'P5');
  assert.equal(vehicleModelLabel({ vehicleTypeCode: 'DF', vehicleTypeName: 'D55' }), 'P5');
  // Code unknown but the name itself is a known code -> still mapped.
  assert.equal(vehicleModelLabel({ vehicleTypeCode: 'NOPE', vehicleTypeName: 'E38' }), 'G9');
  // Neither is a known code -> fall back to the raw name rather than dropping it.
  assert.equal(vehicleModelLabel({ vehicleTypeCode: 'NOPE', vehicleTypeName: '某车型' }), '某车型');
  // Nothing at all -> undefined so the caller can show its own placeholder.
  assert.equal(vehicleModelLabel({}), undefined);
});
