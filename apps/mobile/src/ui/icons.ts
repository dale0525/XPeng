/**
 * Material Symbols 图标表：字形名 → 字体码位。
 *
 * 字体是子集：完整变量字体 4 MB，只保留设计稿实际用到的 48 个图标后 9 KB
 * （`android/app/src/main/assets/fonts/MaterialSymbols.ttf`）。新增图标要先重新
 * 生成子集再引用，直接写名字不会渲染——字体里没有那个字形。
 *
 * 重新生成时必须用 `fontTools.varLib.instancer` 从官方变量字体实例化出**真静态**
 * 字体，再 `pyftsubset` 裁剪。只改变量字体的 name/OS2 表得到的「静态」字体
 * Android 不接受，表现为所有图标渲染成方框，且日志里没有任何报错。
 *
 * 两个设计稿写过但字体没有同名字形的图标，映射到语义最近的替代字形，见注释。
 */
export const Icon = {
  ac_unit: '\ueb3b',
  add: '\ue145',
  air: '\uefd8',
  airline_seat_recline_extra: '\ue636',
  analytics: '\uef3e',
  bolt: '\uea0b',
  check_box_outline_blank: '\ue835',
  check_circle: '\uf0be',
  clean_hands: '\uf21f',
  close_fullscreen: '\uf1cf',
  directions_car: '\ueff7',
  expand_less: '\ue5ce',
  expand_more: '\ue5cf',
  garage: '\uf011',
  gpp_bad: '\uf012',
  /** 设计稿写 gps_fixed，字体里只有 my_location。 */
  gps_fixed: '\ue55c',
  highlight: '\ue25f',
  insights: '\uf092',
  light_mode: '\ue518',
  lightbulb: '\ue90f',
  /** 设计稿写 location_on，字体里只有 place。 */
  location_on: '\uf1db',
  lock: '\ue899',
  lock_open: '\ue898',
  luggage: '\uf235',
  mode_cool: '\uf166',
  mode_heat: '\uf16a',
  mode_standby: '\uf037',
  open_in_browser: '\ue89d',
  power_off: '\ue646',
  power_settings_new: '\uf8c7',
  refresh: '\ue5d5',
  remove: '\ue15b',
  roller_shades: '\uec12',
  sanitizer: '\uf21d',
  schedule: '\uefd6',
  security: '\ue32a',
  sensor_door: '\uf1b5',
  settings: '\ue8b8',
  shield: '\ue9e0',
  shield_with_heart: '\ue78f',
  solar_power: '\uec0f',
  sync: '\ue627',
  tire_repair: '\uebc8',
  tune: '\ue429',
  verified_user: '\uf013',
  vertical_align_bottom: '\ue258',
  volume_up: '\ue050',
  whatshot: '\ue80e',
} as const;

export type IconName = keyof typeof Icon;
