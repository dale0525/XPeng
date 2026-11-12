/**
 * 靠近解闭锁的「不执行」条件：某些 WiFi 下、某些地点附近，都不要自动解闭锁。
 *
 * 纯逻辑，不碰蓝牙、WiFi、定位与存储，便于单测；探针本身在原生侧与 ble.ts 里做。
 *
 * 设计取舍——省电是硬要求，所以判定被拆成两段：
 * 1. WiFi 探针只读一次 SSID，不占射频、不进定位；
 * 2. 坐标探针会唤醒定位链路（GPS），代价高一个量级。
 * 因此 `suppressionPlan` 只在「配置里真的有坐标」时才允许申请定位，且 WiFi 命中
 * 后直接短路，不再取坐标。配置里一个坐标都没有时，本模块一次定位都不会要。
 *
 * 判「命中」的严格性：拿不到当前 SSID、拿不到坐标（权限被撤、定位关闭、超时）一律
 * 判**不命中**。失败的探针不能让功能静默失效——宁可按原样执行，也不要因为读不到
 * 位置就永远不解锁。
 */
export interface SuppressionPlace {
  /** 稳定 id，用于单独删除某一条。 */
  id: string;
  /** 用户起的名字，可以为空。 */
  name: string;
  lat: number;
  lon: number;
  /** 抑制半径（米）。 */
  radiusM: number;
}

export interface ProximitySuppression {
  /** 命中的 WiFi SSID 列表（用户从手机已保存的网络里挑的）。 */
  wifiSsids: string[];
  places: SuppressionPlace[];
}

export interface GeoPoint { lat: number; lon: number }

export const DEFAULT_SUPPRESSION: ProximitySuppression = { wifiSsids: [], places: [] };

/** 半径的合理区间：太小挡不住抖动，太大等于整片区域都停用。 */
const MIN_RADIUS_M = 5;
const MAX_RADIUS_M = 20000;

/**
 * Android 报回来的 SSID 常带双引号，大小写也不保证一致，两侧都归一化后再比。
 * `<unknown ssid>` 是系统在拿不到 SSID 时给的占位串，归一化后当作"没拿到"。
 */
export function normalizeSsid(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  value = value.trim().toLowerCase();
  if (value === '' || value === '<unknown ssid>' || value === '0x' ) return null;
  return value;
}

/** 当前连着的 WiFi 是否在「不执行」名单里。拿不到 SSID 时一律不命中。 */
export function wifiMatches(rules: ProximitySuppression, currentSsid: string | null | undefined): boolean {
  const current = normalizeSsid(currentSsid);
  if (current === null) return false;
  return rules.wifiSsids.some((s) => normalizeSsid(s) === current);
}

/**
 * 两点间地表距离（米）。Haversine，球半径取 6371000 m。
 * 不做墨卡托近似：半径可以设到几公里，等距圆柱在那种尺度上误差不可忽略。
 */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 当前坐标是否落在任何一个已记录地点的半径内。没有坐标时一律不命中。 */
export function placeMatches(rules: ProximitySuppression, location: GeoPoint | null | undefined): boolean {
  if (!location) return false;
  if (typeof location.lat !== 'number' || typeof location.lon !== 'number') return false;
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return false;
  return rules.places.some((p) => distanceMeters(p, location) <= p.radiusM);
}

/**
 * 一次判定要探哪几样东西。这是省电的唯一判据，调用方据此决定要不要唤醒定位。
 * WiFi 命中后不必再取坐标——调用方要先看 `wifiMatches` 的结果再决定走不走第二段。
 */
export function suppressionPlan(rules: ProximitySuppression): {
  probeWifi: boolean;
  probeLocation: boolean;
} {
  if (rules.wifiSsids.length === 0 && rules.places.length === 0) {
    return { probeWifi: false, probeLocation: false };
  }
  // 只有 WiFi 名单时不必碰定位；只要有坐标就必须能取到位置，否则那条规则永远失效。
  return { probeWifi: true, probeLocation: rules.places.length > 0 };
}

/** 命中原因，用于界面与日志说明"这次为什么没执行"。 */
export type SuppressReason = 'wifi' | 'place';

export function suppressReason(input: {
  rules: ProximitySuppression;
  ssid: string | null | undefined;
  location: GeoPoint | null | undefined;
}): SuppressReason | null {
  if (wifiMatches(input.rules, input.ssid)) return 'wifi';
  if (placeMatches(input.rules, input.location)) return 'place';
  return null;
}

// ── 持久化 ──

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parsePlace(raw: unknown): SuppressionPlace | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id === '') return null;
  if (!isFiniteNumber(p.lat) || p.lat < -90 || p.lat > 90) return null;
  if (!isFiniteNumber(p.lon) || p.lon < -180 || p.lon > 180) return null;
  if (!isFiniteNumber(p.radiusM) || p.radiusM < MIN_RADIUS_M || p.radiusM > MAX_RADIUS_M) return null;
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : '',
    lat: p.lat,
    lon: p.lon,
    radiusM: p.radiusM,
  };
}

/**
 * 存储里读回来的配置。任何一条坏数据只丢那一条，不整份回退——否则用户加的其它
 * WiFi/坐标会跟着一条坏记录一起消失。
 */
export function parseSuppression(raw: string | null | undefined): ProximitySuppression {
  if (!raw) return DEFAULT_SUPPRESSION;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SUPPRESSION;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SUPPRESSION;
  const record = parsed as Record<string, unknown>;

  const ssids: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.wifiSsids)) {
    for (const item of record.wifiSsids) {
      const norm = normalizeSsid(typeof item === 'string' ? item : null);
      if (norm === null || seen.has(norm)) continue;
      seen.add(norm);
      // 保留用户当初挑的原始写法（含大小写），只在比较时归一化。
      ssids.push((item as string).trim());
    }
  }

  const places: SuppressionPlace[] = [];
  if (Array.isArray(record.places)) {
    const ids = new Set<string>();
    for (const item of record.places) {
      const place = parsePlace(item);
      if (place === null || ids.has(place.id)) continue;
      ids.add(place.id);
      places.push(place);
    }
  }

  return { wifiSsids: ssids, places };
}

export function serializeSuppression(rules: ProximitySuppression): string {
  return JSON.stringify({ wifiSsids: rules.wifiSsids, places: rules.places });
}