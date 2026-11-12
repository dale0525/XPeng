import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectPreparedBle } from '../apps/mobile/src/core/ble-connect.ts';

test('production BLE connection uses the forward connect bridge, not the background one', async () => {
  const calls: string[] = [];
  const bridge = {
    async permissionStatus() {
      calls.push('permissions');
      return { supported: true, granted: true, bluetoothEnabled: true };
    },
    async connect(mac: string) {
      calls.push(`forward:${mac}`);
    },
  };

  await connectPreparedBle(bridge, 'aa:bb:cc:dd:ee:ff');
  // 后台连接（connectDiagnostic / autoConnect=true）实测 45 秒拿不到连接回调，
  // 生产路径必须是前向连接。
  assert.deepEqual(calls, ['permissions', 'forward:AA:BB:CC:DD:EE:FF']);
});

test('NativeBleTransport delegates its connect method to connectPreparedBle', () => {
  const source = readFileSync(new URL('../apps/mobile/src/core/ble.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*connectPreparedBle[^}]*\} from '\.\/ble-connect';/);
  assert.match(source, /await connectPreparedBle\(bridge, mac\);/);
  assert.doesNotMatch(source, /connectDiagnostic/);
});
