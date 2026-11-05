export interface BleConnectPermissions {
  granted: boolean;
  missing: string[];
  bluetoothEnabled: boolean;
  supported: boolean;
}

interface BleConnectBridge {
  permissionStatus(): Promise<BleConnectPermissions>;
  connect(mac: string): Promise<void>;
  connectDiagnostic(mac: string): Promise<void>;
}

export async function connectPreparedBle(bridge: BleConnectBridge, mac: string): Promise<void> {
  const status = await bridge.permissionStatus();
  if (!status.supported) throw new Error('BLE is not supported on this device');
  if (!status.granted) throw new Error('Bluetooth permission is required');
  if (!status.bluetoothEnabled) throw new Error('Bluetooth is switched off');
  await bridge.connectDiagnostic(mac.toUpperCase());
}
