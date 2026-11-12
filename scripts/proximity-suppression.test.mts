import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUPPRESSION,
  distanceMeters,
  normalizeSsid,
  parseSuppression,
  placeMatches,
  serializeSuppression,
  suppressReason,
  suppressionPlan,
  wifiMatches,
  type ProximitySuppression,
} from '../packages/protocol/src/proximity-suppression.ts';

const empty: ProximitySuppression = { wifiSsids: [], places: [] };

function wifiOnly(...ssids: string[]): ProximitySuppression {
  return { wifiSsids: ssids, places: [] };
}

function placesOnly(...places: ProximitySuppression['places']): ProximitySuppression {
  return { wifiSsids: [], places };
}

// ── WiFi 命中 ──

test('an empty config matches nothing', () => {
  assert.equal(wifiMatches(empty, 'home'), false);
  assert.equal(placeMatches(empty, { lat: 31.2, lon: 121.4 }), false);
});

test('the listed wifi matches when the phone is connected to it', () => {
  assert.equal(wifiMatches(wifiOnly('home'), 'home'), true);
});

test('an unlisted wifi does not match', () => {
  assert.equal(wifiMatches(wifiOnly('home'), 'office'), false);
});

test('matching ignores case and the quotes Android puts around SSIDs', () => {
  // Android's WifiManager reports SSIDs wrapped in double quotes on many builds,
  // and the list comes from the same source, so both sides get normalised.
  assert.equal(normalizeSsid('"Home-Net"'), 'home-net');
  assert.equal(normalizeSsid('  HOME-NET  '), 'home-net');
  assert.equal(wifiMatches(wifiOnly('home-net'), '"Home-Net"'), true);
});

test('an unknown current ssid matches nothing: unknown is not a hit', () => {
  // Android returns null/`<unknown ssid>` when the SSID cannot be read (permission
  // withdrawn, location off). Treating that as "connected to home" would silently
  // disable the whole feature.
  assert.equal(wifiMatches(wifiOnly('home'), null), false);
  assert.equal(wifiMatches(wifiOnly('home'), ''), false);
  assert.equal(wifiMatches(wifiOnly('home'), '<unknown ssid>'), false);
});

// ── 坐标命中 ──

test('a place matches inside its radius and not outside it', () => {
  const rules = placesOnly({ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 100 });
  // 0.001° of latitude is ~111 m at this scale, so 0.0005° is ~55 m.
  assert.equal(placeMatches(rules, { lat: 31.2005, lon: 121.4 }), true);
  assert.equal(placeMatches(rules, { lat: 31.2035, lon: 121.4 }), false);
});

test('each place keeps its own radius', () => {
  const rules = placesOnly(
    { id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 30 },
    { id: 'p2', name: '公司', lat: 31.2, lon: 121.4, radiusM: 20 },
  );
  // ~55 m out: outside both, the larger radius being 30 m.
  assert.equal(placeMatches(rules, { lat: 31.2005, lon: 121.4 }), false);
  // ~11 m out: inside both.
  assert.equal(placeMatches(rules, { lat: 31.2001, lon: 121.4 }), true);
});

test('a missing fix matches nothing: no location is not a hit', () => {
  const rules = placesOnly({ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 100 });
  assert.equal(placeMatches(rules, null), false);
});

test('radius is inclusive at the boundary', () => {
  const rules = placesOnly({ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 100 });
  const d = distanceMeters({ lat: 31.2, lon: 121.4 }, { lat: 31.2005, lon: 121.4 });
  assert.ok(d > 50 && d < 60, `expected ~55 m, got ${d}`);
  const exact = placesOnly({ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: d });
  assert.equal(placeMatches(exact, { lat: 31.2005, lon: 121.4 }), true);
});

test('distance is symmetric and zero for a point against itself', () => {
  const a = { lat: 31.2, lon: 121.4 };
  const b = { lat: 31.23, lon: 121.44 };
  assert.equal(distanceMeters(a, a), 0);
  assert.ok(Math.abs(distanceMeters(a, b) - distanceMeters(b, a)) < 0.001);
});

// ── 两段式判定 ──

test('wifi wins over place, so the cheaper probe short-circuits the GPS fix', () => {
  const rules: ProximitySuppression = {
    wifiSsids: ['home'],
    places: [{ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 100 }],
  };
  assert.equal(suppressReason({ rules, ssid: 'home', location: { lat: 31.2, lon: 121.4 } }), 'wifi');
  assert.equal(suppressReason({ rules, ssid: 'office', location: { lat: 31.2, lon: 121.4 } }), 'place');
  assert.equal(suppressReason({ rules, ssid: 'office', location: { lat: 31.3, lon: 121.4 } }), null);
});

// ── 省电：什么条件下才值得去探一次 ──

test('an empty config probes nothing, so leaving the feature unused costs zero', () => {
  assert.deepEqual(suppressionPlan(empty), { probeWifi: false, probeLocation: false });
});

test('a wifi-only config never asks for a location fix', () => {
  assert.deepEqual(suppressionPlan(wifiOnly('home')), { probeWifi: true, probeLocation: false });
});

test('a place-only config still probes the wifi: it is the cheap way to short-circuit', () => {
  // Not strictly needed for correctness, but a phone sitting on the configured home
  // wifi is exactly the place case, and reading the SSID costs no radio time.
  const plan = suppressionPlan(placesOnly({ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 100 }));
  assert.equal(plan.probeWifi, true);
  assert.equal(plan.probeLocation, true);
});

// ── 持久化 ──

test('round-trips a full config', () => {
  const rules: ProximitySuppression = {
    wifiSsids: ['home', 'office'],
    places: [{ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 120 }],
  };
  assert.deepEqual(parseSuppression(serializeSuppression(rules)), rules);
});

test('garbage and missing storage yields the empty default rather than throwing', () => {
  assert.deepEqual(parseSuppression(null), DEFAULT_SUPPRESSION);
  assert.deepEqual(parseSuppression('not json'), DEFAULT_SUPPRESSION);
  assert.deepEqual(parseSuppression('{}'), DEFAULT_SUPPRESSION);
});

test('a half-written place is dropped, not accepted with a NaN radius', () => {
  const parsed = parseSuppression(JSON.stringify({
    wifiSsids: ['home'],
    places: [
      { id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 50 },
      { id: 'p2', name: '坏', lat: 'x', lon: 121.4, radiusM: 50 },
    ],
  }));
  assert.deepEqual(parsed.wifiSsids, ['home']);
  assert.equal(parsed.places.length, 1);
  assert.equal(parsed.places[0].id, 'p1');
});

test('the same wifi cannot be listed twice', () => {
  const parsed = parseSuppression(JSON.stringify({ wifiSsids: ['home', 'Home', '"home"'], places: [] }));
  assert.equal(parsed.wifiSsids.length, 1);
});

test('a place without a name still parses: naming is optional', () => {
  const parsed = parseSuppression(JSON.stringify({
    wifiSsids: [],
    places: [{ id: 'p1', lat: 31.2, lon: 121.4, radiusM: 50 }],
  }));
  assert.equal(parsed.places.length, 1);
  assert.equal(parsed.places[0].name, '');
});

test('an empty config serialises to the same thing the default parses back into', () => {
  assert.deepEqual(parseSuppression(serializeSuppression(DEFAULT_SUPPRESSION)), DEFAULT_SUPPRESSION);
});

test('a radius of zero or a huge radius is rejected: neither is a sensible fence', () => {
  const parsed = parseSuppression(JSON.stringify({
    wifiSsids: [],
    places: [
      { id: 'p1', name: '零', lat: 31.2, lon: 121.4, radiusM: 0 },
      { id: 'p2', name: '太大', lat: 31.2, lon: 121.4, radiusM: 100000 },
    ],
  }));
  assert.equal(parsed.places.length, 0);
});
// ── 回归：2026-11-12 真机故障（车辆在 100 m 半径内仍持续解闭锁） ──
//
// 故障现象：14:49–14:50 抑制生效，14:51 起完全失效，而记录点与当时坐标一致。
// 根因不是坐标算错，而是「候选定位」全被当作过期丢掉了：手机静止时系统不再更新
// last-known，一次判距就必然拿不到新鲜点，于是被判成"没有位置" → 不命中 → 照常解锁。

test('a stale-but-only-available fix still counts:静止时系统不更新 last-known，丢掉它就等于规则永远失效', () => {
  // 模拟：只剩一个 4 小时前的点（真实的 15923 s），但位置确实是家。
  const rules: ProximitySuppression = {
    wifiSsids: [],
    places: [{ id: 'p1', name: '家', lat: 31.131556, lon: 121.743063, radiusM: 100 }],
  };
  const home = { lat: 31.131556, lon: 121.743063 };
  // 旧点照样命中：新鲜度不该参与「命中与否」的判断。
  assert.equal(suppressReason({ rules, ssid: null, location: home }), 'place');
});

test('陈旧定位不得让「别处」误判成命中也仍然成立：距离才是唯一判据', () => {
  const rules: ProximitySuppression = {
    wifiSsids: [],
    places: [{ id: 'p1', name: '家', lat: 31.131556, lon: 121.743063, radiusM: 100 }],
  };
  // 三天前在另一个城市的点：即便"旧点可用"，距离也会把它排除。
  assert.equal(suppressReason({ rules, ssid: null, location: { lat: 39.9, lon: 116.4 } }), null);
});

test('a fresh fix is used as-is and never triggers a costly request path decision', () => {
  const rules: ProximitySuppression = {
    wifiSsids: [],
    places: [{ id: 'p1', name: '家', lat: 31.2, lon: 121.4, radiusM: 100 }],
  };
  const plan = suppressionPlan(rules);
  assert.equal(plan.probeLocation, true);
  // 有坐标配置时才需要位置探针；WiFi 命中后应短路，不再要位置。
  assert.equal(suppressReason({ rules, ssid: null, location: { lat: 31.2005, lon: 121.4 } }), 'place');
});

test('place matching never depends on how old the fix is: same point, same verdict', () => {
  const rules: ProximitySuppression = {
    wifiSsids: [],
    places: [{ id: 'p1', name: '家', lat: 31.131556, lon: 121.743063, radiusM: 100 }],
  };
  const at = { lat: 31.1315, lon: 121.7430 };
  const first = suppressReason({ rules, ssid: null, location: at });
  const second = suppressReason({ rules, ssid: null, location: at });
  assert.equal(first, 'place');
  assert.equal(second, first);
});

