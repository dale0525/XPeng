export interface BleConnectPermissions {
  granted: boolean;
  missing: string[];
  bluetoothEnabled: boolean;
  supported: boolean;
}

/**
 * 重试也没有意义的前置条件（权限、蓝牙关闭、设备不支持）。
 *
 * 常驻连接会按退避无限重连，所以这一类错误必须能被识别出来区别对待，
 * 否则用户拒绝一次权限就会看到每 30 s 一次的无效重连。
 */
export class BlePreconditionError extends Error {}

interface BleConnectBridge {
  permissionStatus(): Promise<BleConnectPermissions>;
  connect(mac: string): Promise<void>;
}

export async function connectPreparedBle(bridge: BleConnectBridge, mac: string): Promise<void> {
  const status = await bridge.permissionStatus();
  if (!status.supported) throw new BlePreconditionError('BLE is not supported on this device');
  if (!status.granted) throw new BlePreconditionError('Bluetooth permission is required');
  if (!status.bluetoothEnabled) throw new BlePreconditionError('Bluetooth is switched off');
  // 必须走前向连接（`autoConnect=false`）：后台连接（`autoConnect=true`）不主动寻呼，
  // 只登记一个等待广播的连接，实测 45 秒内拿不到任何 onConnectionStateChange，然后被超时取消。
  // 原生模块的重试逻辑也只在 `autoConnect=false` 上验证成功过。
  await bridge.connect(mac.toUpperCase());
}
