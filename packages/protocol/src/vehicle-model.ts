/**
 * 把车端自报的车型代码映射成对外公开的车型名称。
 *
 * 数据源是官方安装包内 `assets/vehicle/config/<配置键>VehicleAbilityConfig.json`
 * 自带的 `carTypeCode → carTypeName`（见 docs/research/xpeng-app-teardown.md §5.11）。
 * 官方 App 展示的「P5」就是这张表里的 `carTypeName`，不是 `/biz/v5/vehicle/v2/myVehicles`
 * 下发的 `vehicleTypeName`。
 *
 * 对外接口的 `vehicleTypeCode` 与配置文件键**不是同一套**（本车 D55 / DF 两值都出现过），
 * 因此配置键与 `carTypeCode` 一起收进来，谁命中都能还原成公开名。
 */
const MODEL_NAME_BY_CODE: Record<string, string> = {
  // G3 车系（含 G3i）
  D20: 'G3',
  D20P: 'G3',
  D21: 'G3',
  DB: 'G3',
  DC: 'G3',
  DE: 'G3',
  D22: 'G3i',
  DG: 'G3i',
  // P5
  D55: 'P5',
  DF: 'P5',
  // P7 车系
  E28: 'P7',
  E29: 'P7',
  ED: 'P7',
  EH: 'P7',
  E28A: 'P7i',
  EF: 'P7i',
  F57: 'P7+',
  F57A: 'P7+',
  FC: 'P7+',
  FJ: 'P7+',
  // G9 车系
  E38: 'G9',
  E38B: 'G9',
  EA: 'G9',
  EE: 'G9',
  G02: 'G9L',
  GB: 'G9L',
  // G6
  F30: 'G6',
  F30B: 'G6',
  F30BS: 'G6',
  FA: 'G6',
  FF: 'G6',
  FK: 'G6',
  // G7
  F01: 'G7',
  F01S: 'G7',
  FE: 'G7',
  FH: 'G7',
  // GX
  G01ES: 'GX',
  GA: 'GX',
  // X9
  H93: 'X9',
  H93AE: 'X9',
  H93AS: 'X9',
  HA: 'X9',
  HE: 'X9',
  HR: 'X9',
  // MONA M03 / L03 / L05
  D01: 'M03',
  D01A: 'M03',
  DM: 'M03',
  DP: 'M03',
  D02: 'L05',
  DJ: 'L05',
  D03: 'L03',
  DS: 'L03',
};

/** 车型代码 → 对外公开车型名；未知代码返回 undefined，由调用方决定怎么兜底。 */
export function publicModelName(code: string | null | undefined): string | undefined {
  return code ? MODEL_NAME_BY_CODE[code] : undefined;
}

/**
 * 车辆对外展示用的车型名：优先按代码映射成公开名，映射不到再退回车端原始名。
 * `Vehicle.vehicleTypeCode` 与 `Vehicle.vehicleTypeName` 都可能是内部代码，故两者都查一遍。
 */
export function vehicleModelLabel(vehicle: { vehicleTypeCode?: string; vehicleTypeName?: string }): string | undefined {
  return (
    publicModelName(vehicle.vehicleTypeCode) ??
    publicModelName(vehicle.vehicleTypeName) ??
    vehicle.vehicleTypeName ??
    undefined
  );
}
