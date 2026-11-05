import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectPreparedBle } from '../apps/mobile/src/core/ble-connect.ts';

test('production BLE connection uses the background connectDiagnostic bridge', async () => {
  const calls: string[] = [];
  const bridge = {
    async permissionStatus() {
      calls.push('permissions');
      return { supported: true, granted: true, bluetoothEnabled: true };
    },
    async connect(mac: string) {
      calls.push(`direct:${mac}`);
    },
    async connectDiagnostic(mac: string) {
      calls.push(`background:${mac}`);
    },
  };

  await connectPreparedBle(bridge, 'aa:bb:cc:dd:ee:ff');
  assert.deepEqual(calls, ['permissions', 'background:AA:BB:CC:DD:EE:FF']);
});

test('NativeBleTransport delegates its connect method to connectPreparedBle', () => {
  const source = readFileSync(new URL('../apps/mobile/src/core/ble.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ connectPreparedBle, type BleConnectPermissions \} from '\.\/ble-connect';/);
  assert.match(source, /await connectPreparedBle\(bridge, mac\);/);
});
