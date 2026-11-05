import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialCallQueue } from '../apps/mobile/src/core/serial-call-queue.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('serial HTTP queue never overlaps requests that consume one-time key pools', async () => {
  const queue = new SerialCallQueue();
  const first = deferred();
  const second = deferred();
  const events: string[] = [];

  const one = queue.run(async () => {
    events.push('first:start');
    await first.promise;
    events.push('first:end');
  });
  const two = queue.run(async () => {
    events.push('second:start');
    await second.promise;
    events.push('second:end');
  });

  await settle();
  assert.deepEqual(events, ['first:start']);

  first.resolve();
  await one;
  await settle();
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);

  second.resolve();
  await two;
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('a rejected request does not poison the queue', async () => {
  const queue = new SerialCallQueue();
  const failure = new Error('upstream rejected stale key pool');
  await assert.rejects(queue.run(async () => { throw failure; }), e => e === failure);
  assert.equal(await queue.run(async () => 'later request'), 'later request');
});
