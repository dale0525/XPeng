/**
 * 亮/暗两套颜色取值，逐项抄自设计稿 `docs/design/*.html` 的 `tailwind.config` 段。
 *
 * 暗色 = `Horizon Pulse Telematics`（五份暗色稿里完全一致的那组）；亮色 = `Horizon
 * Pulse Daylight`（另五份）。两套是同一个语义名在两种明暗下的取值，不是反相——亮色
 * 的 `primary` 是压深的琥珀墨 `#8A5A00`，暗色才是发光的 `#ffdba0`。
 *
 * 组件里只写 `bg-surface` 这类语义类，切换主题只换根节点上注入的变量，不重写任何
 * className。这也是设计稿 `darkMode: "class"` 的等价做法。
 */
export const LIGHT_COLORS: Record<string, string> = {
  surface: '#FFFFFF',
  'surface-dim': '#F4F1EA',
  'surface-bright': '#FFFFFF',
  'surface-container-lowest': '#FFFFFF',
  'surface-container-low': '#F8F5EF',
  'surface-container': '#F1ECE2',
  'surface-container-high': '#E9E2D4',
  'surface-container-highest': '#E0D8C7',
  'on-surface': '#1C1A15',
  'on-surface-variant': '#5C5442',
  'inverse-surface': '#1C1A15',
  'inverse-on-surface': '#F4F1EA',
  outline: '#8A7F68',
  'outline-variant': '#D6CCB8',
  'surface-tint': '#B37400',
  primary: '#8A5A00',
  'on-primary': '#FFFFFF',
  'primary-container': '#FFB703',
  'on-primary-container': '#3A2600',
  'inverse-primary': '#FFB703',
  'primary-fixed': '#FFB703',
  'primary-fixed-dim': '#B37400',
  'on-primary-fixed': '#3A2600',
  'on-primary-fixed-variant': '#8A5A00',
  secondary: '#00626D',
  'on-secondary': '#FFFFFF',
  'secondary-container': '#00D4E5',
  'on-secondary-container': '#00363B',
  'secondary-fixed': '#00D4E5',
  'secondary-fixed-dim': '#007A87',
  'on-secondary-fixed': '#00363B',
  'on-secondary-fixed-variant': '#00626D',
  tertiary: '#A80050',
  'on-tertiary': '#FFFFFF',
  'tertiary-container': '#FF4F94',
  'on-tertiary-container': '#3D001C',
  'tertiary-fixed': '#FF4F94',
  'tertiary-fixed-dim': '#C2005E',
  'on-tertiary-fixed': '#3D001C',
  'on-tertiary-fixed-variant': '#A80050',
  error: '#B3261E',
  'on-error': '#FFFFFF',
  'error-container': '#FFDAD6',
  'on-error-container': '#410E0B',
  background: '#F4F1EA',
  'on-background': '#1C1A15',
  'surface-variant': '#E9E2D4',
  /** 设计稿里反复出现的成功绿（胎压「正常」徽章、在线指示灯）。 */
  success: '#0F7B5A',
};

export const DARK_COLORS: Record<string, string> = {
  surface: '#12131a',
  'surface-dim': '#12131a',
  'surface-bright': '#383941',
  'surface-container-lowest': '#0d0e15',
  'surface-container-low': '#1a1b22',
  'surface-container': '#1e1f26',
  'surface-container-high': '#292931',
  'surface-container-highest': '#34343c',
  'on-surface': '#e3e1ec',
  'on-surface-variant': '#d5c4ac',
  'inverse-surface': '#e3e1ec',
  'inverse-on-surface': '#2f3038',
  outline: '#9e8f78',
  'outline-variant': '#514532',
  'surface-tint': '#ffba27',
  primary: '#ffdba0',
  'on-primary': '#422c00',
  'primary-container': '#ffb703',
  'on-primary-container': '#6b4b00',
  'inverse-primary': '#7d5800',
  'primary-fixed': '#ffdea9',
  'primary-fixed-dim': '#ffba27',
  'on-primary-fixed': '#271900',
  'on-primary-fixed-variant': '#5e4100',
  secondary: '#d3fbff',
  'on-secondary': '#00363a',
  'secondary-container': '#00eefc',
  'on-secondary-container': '#00686f',
  'secondary-fixed': '#7df4ff',
  'secondary-fixed-dim': '#00dbe9',
  'on-secondary-fixed': '#002022',
  'on-secondary-fixed-variant': '#004f54',
  tertiary: '#ffd5dd',
  'on-tertiary': '#66002c',
  'tertiary-container': '#ffadc0',
  'on-tertiary-container': '#a1004b',
  'tertiary-fixed': '#ffd9e0',
  'tertiary-fixed-dim': '#ffb1c3',
  'on-tertiary-fixed': '#3f0019',
  'on-tertiary-fixed-variant': '#8f0041',
  error: '#ffb4ab',
  'on-error': '#690005',
  'error-container': '#93000a',
  'on-error-container': '#ffdad6',
  background: '#12131a',
  'on-background': '#e3e1ec',
  'surface-variant': '#34343c',
  /** 暗色稿里没有成功绿：胎压「正常」用的是青色 `secondary-fixed`。 */
  success: '#00dbe9',
};

/** 转成 NativeWind `vars()` 需要的 `--c-*` 键名。 */
export function toVars(colors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) out[`--c-${k}`] = v;
  return out;
}
