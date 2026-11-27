import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNetworkChangeAction,
  MQTT_RECONNECT_DELAYS_MS,
  nextMqttReconnectDelay,
} from '../packages/protocol/src/mqtt-reconnect.ts';

test('nextMqttReconnectDelay follows backoff sequence and caps at max', () => {
  assert.equal(nextMqttReconnectDelay(-1), MQTT_RECONNECT_DELAYS_MS[0]);
  assert.equal(nextMqttReconnectDelay(0), 2_000);
  assert.equal(nextMqttReconnectDelay(1), 5_000);
  assert.equal(nextMqttReconnectDelay(2), 10_000);
  assert.equal(nextMqttReconnectDelay(3), 20_000);
  assert.equal(nextMqttReconnectDelay(4), 30_000);
  assert.equal(nextMqttReconnectDelay(5), 60_000);
  assert.equal(nextMqttReconnectDelay(99), 60_000);
});

test('decideNetworkChangeAction ignores events without active session', () => {
  assert.equal(
    decideNetworkChangeAction({ hasSession: false, state: 'offline', available: true, switched: true }),
    'none',
  );
  assert.equal(
    decideNetworkChangeAction({ hasSession: false, state: 'online', available: false, switched: false }),
    'none',
  );
});

test('decideNetworkChangeAction pauses reconnect when network is lost', () => {
  for (const state of ['idle', 'connecting', 'online', 'offline'] as const) {
    assert.equal(
      decideNetworkChangeAction({ hasSession: true, state, available: false, switched: false }),
      'pause',
    );
  }
});

test('decideNetworkChangeAction reconnects immediately on WiFi/cellular switch even while online', () => {
  // 2026-11-27 实测：前台 WiFi 切移动数据时旧 socket 可能尚未报 IOException，
  // 必须主动切到新网络，不能等 45 s 心跳失败才发现连接已死。
  assert.equal(
    decideNetworkChangeAction({ hasSession: true, state: 'online', available: true, switched: true }),
    'reconnect-now',
  );
  // 同一网络重复通知（未切换）且已在线，不需要折腾重连。
  assert.equal(
    decideNetworkChangeAction({ hasSession: true, state: 'online', available: true, switched: false }),
    'none',
  );
});

test('decideNetworkChangeAction reconnects immediately when offline or idle and network becomes available', () => {
  assert.equal(
    decideNetworkChangeAction({ hasSession: true, state: 'offline', available: true, switched: false }),
    'reconnect-now',
  );
  assert.equal(
    decideNetworkChangeAction({ hasSession: true, state: 'offline', available: true, switched: true }),
    'reconnect-now',
  );
  assert.equal(
    decideNetworkChangeAction({ hasSession: true, state: 'idle', available: true, switched: false }),
    'reconnect-now',
  );
});

test('decideNetworkChangeAction defers reconnect if network changes mid-connect', () => {
  assert.equal(
    decideNetworkChangeAction({ hasSession: true, state: 'connecting', available: true, switched: true }),
    'defer-after-connect',
  );
  assert.equal(
    decideNetworkChangeAction({ hasSession: true, state: 'connecting', available: true, switched: false }),
    'defer-after-connect',
  );
});
