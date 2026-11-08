/**
 * 业务接口与它们的返回类型。
 *
 * 字段名全部照抄服务端返回，不做 camelCase 转换——状态里有 80+ 字段且会随车型
 * 增减，改名只会让排查时对不上原始报文。
 */

export interface VehicleAppearance {
  vehicleColorCode: string;
  vehicleColorName: string;
  pictureLeft: string | null;
  topViewUrl: string | null;
  diagramVersion: number;
}

export interface Vehicle {
  vin: string;
  plateNo: string;
  vehicleTypeCode: string;
  vehicleTypeName: string;
  totalMileage: number;
  relationType: number;
  vehicleAppearance: VehicleAppearance;
  /**
   * 车主信息。`/biz/v5/vehicle/v2/myVehicles` 对部分账号（子账号、或车主信息未随列表
   * 下发）返回 null，真机 2026-11-08 复现过，因此按可空处理。
   */
  ownerInfo: { uid: number; nickName: string; mobile: string; headImg: string | null } | null;
  permissions: { remoteControl: { isPermanent: boolean; expireTime: number | null } };
  equipment: { camera360: boolean };
  /** 车型能力表，决定 UI 显示哪些控件；不要硬编码功能可见性。 */
  function: Record<string, boolean>;
}

export interface VehicleStatus {
  instant: {
    door: {
      temp_lock_st: number;
      driver_door_lock_st: number;
      driver_door_ajar_st: number;
      passenger_door_ajar_st: number;
      rear_left_door_ajar_st: number;
      rear_right_door_ajar_st: number;
      trunk_ajar_st: number;
    };
    window: {
      front_left_window_position: number;
      front_right_window_position: number;
      rear_left_window_position: number;
      rear_right_window_position: number;
      sky_sun_shade_position: number;
    };
    hvac: {
      hvac_on: number;
      hvac_temp: number;
      hvac_inner_temp: number;
      hvac_wind_speed: number;
      hvac_auto: number;
      hvac_defrost: number;
      hvac_quick_warm_mode: number;
      hvac_quick_cool_mode: number;
      hvac_high_temp_mode: number;
    };
    charge: {
      battery_soc: number;
      charging_state: number;
      charge_gun_status: number;
      charge_gun_lock_status: number;
      slow_charge_port_status: number;
      fast_charge_port_status: number;
      max_range_charge: number;
      reserve_charge_start_time: string;
      time_to_complete_charge: number;
      time_to_complete_charge_min: number;
      battery_keep_warm_status: number;
      repeat_type: number;
      charge_connector_status: number;
    };
    odometer: {
      total_mileage: number;
      avalible_driving_distance: number;
      range_type: number;
    };
    tpms: {
      tpms_pressure_fl: number;
      tpms_pressure_fr: number;
      tpms_pressure_rl: number;
      tpms_pressure_rr: number;
      tpms_pressure_fl_warn: number;
      tpms_pressure_fr_warn: number;
      tpms_pressure_rl_warn: number;
      tpms_pressure_rr_warn: number;
    };
    seat: {
      driver_seat_state: number;
      driver_seat_heat: number;
      passenger_seat_heat: number;
      left_rear_seat_heat: number;
      right_rear_seat_heat: number;
      driver_seat_ventilation: number;
      passenger_seat_ventilation: number;
      left_rear_seat_ventilation: number;
      right_rear_seat_ventilation: number;
    };
    solarRoof: {
      solarWorkStatus: number;
      solarFaultStatus: number;
      solarVentilateStatus: number;
      solarVentilateToday: number;
      solarVentilateLengthToday: number;
    };
    trunkPower: { powerSwitch: number; timeToPowerOffInMin: number };
    ext: {
      sentinel_mode_sensitivity: number;
      soldier_camera_status: number;
      sentinel_mode_video_enable: number;
      repairMode: number;
    };
    power: {
      remote_start_status: number;
      car_igon_state: number;
      car_power_state: number;
    };
    drive: { shift_state: number };
    chargeStatistics: {
      usageElectricity: number;
      chargeTime: number;
      completeTime: number;
      addedRange: number;
    };
    equipment: { avm_exist: number };
  };
  interval: {
    charge: { electricity: number; charge_rate: number; voltage: number };
    drive: {
      coordType: number;
      latitude: number;
      longitude: number;
      angle: number;
      speed: string;
      coordValid: number;
    };
  };
  digital_vehicle: any;
}

export interface MqttAccount {
  clientId: string;
  username: string;
  password: string;
  serverSsl: string;
  expireTime: number;
}
