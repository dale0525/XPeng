/**
 * Car commands. MQTT entries use documented `service_type` / `msg_content`
 * (docs/research/xpeng-app-teardown.md §5.6). P5 V2 evidenced BLE actions are
 * selected by id in ble-v2-routing.ts. `serviceType: 0` with empty `msgContent`
 * marks a BLE-only command with no MQTT representation; the router refuses to
 * send it over MQTT.
 */

export interface CommandDef {
  /** 稳定 id，同时是持久化与日志里的键。 */
  id: string;
  /** 界面上显示的名字。 */
  label: string;
  /** 分组，决定它在车控页的哪一区。 */
  group: 'door' | 'window' | 'hvac' | 'light' | 'sentinel';
  serviceType: number;
  msgContent: Record<string, unknown>;
  /**
   * 回执里用来判断「这条指令是否真的生效」的字段路径。空表示没有状态字段
   * （例如鸣笛只能靠人耳确认）。
   */
  confirmField?: string;
}

/**
 * 遮阳帘位置字段：`instant.window.sky_sun_shade_position`。
 *
 * 是**百分比**（0=完全关闭，100=完全打开），不是 0/1 布尔值——2026-11-01 用
 * `st=12 ct=4 cv=1` 实测，回执直接给 `sky_sun_shade_position: 100`。
 */
export const SHADE_FIELD = 'instant.window.sky_sun_shade_position';

export const COMMANDS: CommandDef[] = [
  {
    id: 'shade.open',
    label: '打开遮阳帘',
    group: 'window',
    serviceType: 12,
    msgContent: { cmd_type: 4, cmd_value: 1 },
    confirmField: SHADE_FIELD,
  },
  {
    id: 'shade.close',
    label: '关闭遮阳帘',
    group: 'window',
    serviceType: 12,
    msgContent: { cmd_type: 4, cmd_value: 0 },
    confirmField: SHADE_FIELD,
  },
  {
    id: 'window.down',
    label: '全车车窗通风',
    group: 'window',
    serviceType: 12,
    msgContent: { cmd_type: 1, cmd_value: 2 },
    confirmField: 'instant.window.front_left_window_position',
  },
  {
    id: 'window.up',
    label: '全车车窗关闭',
    group: 'window',
    serviceType: 12,
    msgContent: { cmd_type: 1, cmd_value: 1 },
    confirmField: 'instant.window.front_left_window_position',
  },
  {
    id: 'door.unlock',
    label: '解锁车门',
    group: 'door',
    serviceType: 9,
    msgContent: { cmd_type: 0 },
    confirmField: 'instant.door.driver_door_lock_st',
  },
  {
    id: 'door.lock',
    label: '锁车',
    group: 'door',
    serviceType: 9,
    msgContent: { cmd_type: 1 },
    confirmField: 'instant.door.driver_door_lock_st',
  },
  // BLE-only P5 V2 commands. Both share opcode 0x04; the open/close direction is
  // carried by the server-issued material, not by a distinct command byte. The MQTT
  // fields are placeholders: ble-v2-routing rejects these ids outside DF and never
  // forwards them to carLink.send.
  {
    id: 'trunk.open',
    label: '打开后备箱',
    group: 'door',
    serviceType: 0,
    msgContent: {},
  },
  {
    id: 'trunk.close',
    label: '关闭后备箱',
    group: 'door',
    serviceType: 0,
    msgContent: {},
  },
  {
    id: 'hvac.on',
    label: '打开空调',
    group: 'hvac',
    serviceType: 3,
    msgContent: { cmd_type: 1, cmd_value: 1 },
    confirmField: 'instant.hvac.hvac_on',
  },
  {
    id: 'hvac.off',
    label: '关闭空调',
    group: 'hvac',
    serviceType: 3,
    msgContent: { cmd_type: 1, cmd_value: 0 },
    confirmField: 'instant.hvac.hvac_on',
  },
  {
    id: 'hvac.quickCool',
    label: '极速降温',
    group: 'hvac',
    serviceType: 3,
    msgContent: { cmd_type: 6, cmd_value: 1 },
    confirmField: 'instant.hvac.hvac_quick_cool_mode',
  },
  {
    id: 'hvac.quickWarm',
    label: '极速升温',
    group: 'hvac',
    serviceType: 3,
    msgContent: { cmd_type: 8, cmd_value: 1 },
    confirmField: 'instant.hvac.hvac_quick_warm_mode',
  },
  {
    id: 'hvac.highTemp',
    label: '高温抑菌',
    group: 'hvac',
    serviceType: 3,
    msgContent: { cmd_type: 9, cmd_value: 1 },
    confirmField: 'instant.hvac.hvac_high_temp_mode',
  },
  {
    id: 'light.flash',
    label: '闪灯',
    group: 'light',
    serviceType: 5,
    msgContent: { cmd_type: 1, cmd_value: 1 },
    confirmField: 'dipped_headlight_status',
  },
  {
    id: 'light.horn',
    label: '鸣笛',
    group: 'light',
    serviceType: 6,
    msgContent: { cmd_type: 1, cmd_value: 1 },
  },
  {
    id: 'sentinel.on',
    label: '开启哨兵模式',
    group: 'sentinel',
    serviceType: 8,
    msgContent: {
      action: 2,
      settings: [{ code: 'SENTINEL_MODE_VIDEO', value: 1 }],
    },
    confirmField: 'instant.ext.soldier_camera_status',
  },
  {
    id: 'sentinel.off',
    label: '关闭哨兵模式',
    group: 'sentinel',
    serviceType: 8,
    msgContent: {
      action: 2,
      settings: [{ code: 'SENTINEL_MODE_VIDEO', value: 0 }],
    },
    confirmField: 'instant.ext.soldier_camera_status',
  },
];

/** 设温度：`cmd_value` 是整数摄氏度。会顺带开机，需要时补一条关闭。 */
export function setTemperature(celsius: number): { serviceType: number; msgContent: Record<string, unknown> } {
  return { serviceType: 3, msgContent: { cmd_type: 2, cmd_value: Math.round(celsius) } };
}

/** 哨兵灵敏度：1=低 2=中 3=高。 */
export function setSentinelSensitivity(level: 1 | 2 | 3) {
  return {
    serviceType: 8,
    msgContent: {
      action: 2,
      settings: [{ code: 'SENTINEL_MODE_SENSITIVITY', value: level }],
    },
  };
}

/** 读全车状态：`service_type:19 / cmd_type:2`，只读，不需要车辆上电。 */
export const READ_STATUS = { serviceType: 19, msgContent: { cmd_type: 2 } };

/** 读遮阳帘/车窗状态：`service_type:12 / cmd_type:4 cmd_value:0`。 */
export const READ_SHADE = { serviceType: 12, msgContent: { cmd_type: 4, cmd_value: 0 } };
