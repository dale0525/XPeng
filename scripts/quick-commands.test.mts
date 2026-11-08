import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickCommands } from '../apps/mobile/src/core/quick-commands.ts';

const DEFAULTS = ['doorLock', 'remoteUnlock', 'acOn', 'flash'];

test('falls back to the four designed shortcuts when nothing is stored', () => {
  assert.deepEqual(parseQuickCommands(null), DEFAULTS);
  assert.deepEqual(parseQuickCommands('not json'), DEFAULTS);
  assert.deepEqual(parseQuickCommands('{}'), DEFAULTS);
});

test('keeps only known shortcut ids in stored order and caps at four', () => {
  const saved = JSON.stringify(['flash', 'notAnId', 'windowClose', 'acOn', 'tempPark', 'shadeOpen']);
  assert.deepEqual(parseQuickCommands(saved), ['flash', 'windowClose', 'acOn', 'tempPark']);
});
