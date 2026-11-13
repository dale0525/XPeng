import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPush, IPUSH_WINDOW_MS, SEEN_PUSH_LIMIT } from '../packages/protocol/src/status-freshness.ts';

/** 一次查询回执 + 随后到达的推送，按 2026-11-14 PILE_DIAG 实测时序。 */
function seen(ids: string[] = []): Set<string> {
  return new Set(ids);
}

test('a query reply is always accepted', () => {
  assert.equal(acceptPush({ isReply: true, msgId: 'm1', now: 0, ignoreUntil: 0, seen: seen() }), true);
  // 即使在忽略窗口内，回执也照样采纳（它才是权威快照）。
  assert.equal(acceptPush({ isReply: true, msgId: 'm1', now: 500, ignoreUntil: 1000, seen: seen() }), true);
});

test('a push inside the window after the reply is dropped', () => {
  // 实测：回执 01:59:59.398，旧快照 02:00:02.587（+3.19 s）。
  const replyAt = 1_000_000;
  assert.equal(
    acceptPush({ isReply: false, msgId: 'old', now: replyAt + 3_190, ignoreUntil: replyAt + IPUSH_WINDOW_MS, seen: seen() }),
    false,
  );
});

test('the window covers the measured 3.19s late snapshot', () => {
  assert.ok(IPUSH_WINDOW_MS > 3_190, `window ${IPUSH_WINDOW_MS}ms must exceed the measured 3190ms`);
});

test('a push after the window is accepted', () => {
  const replyAt = 1_000_000;
  assert.equal(
    acceptPush({ isReply: false, msgId: 'new', now: replyAt + IPUSH_WINDOW_MS + 1, ignoreUntil: replyAt + IPUSH_WINDOW_MS, seen: seen() }),
    true,
  );
});

test('the same msg_id is never applied twice, even after the window', () => {
  const s = seen();
  const first = acceptPush({ isReply: false, msgId: 'n1', now: 0, ignoreUntil: 0, seen: s });
  assert.equal(first, true);
  // 同一 msg_id 重放：晚一分钟也不采纳。
  assert.equal(acceptPush({ isReply: false, msgId: 'n1', now: 60_000, ignoreUntil: 0, seen: s }), false);
});

test('an empty msg_id is not deduped away', () => {
  const s = seen();
  assert.equal(acceptPush({ isReply: false, msgId: '', now: 0, ignoreUntil: 0, seen: s }), true);
  assert.equal(acceptPush({ isReply: false, msgId: '', now: 1, ignoreUntil: 0, seen: s }), true);
});

test('the dedup set is bounded', () => {
  const s = seen();
  for (let i = 0; i < SEEN_PUSH_LIMIT; i++) {
    assert.equal(acceptPush({ isReply: false, msgId: `id-${i}`, now: 0, ignoreUntil: 0, seen: s }), true);
  }
  assert.ok(s.size <= SEEN_PUSH_LIMIT);
  // 溢出后仍能继续采纳新 id（清空是丢历史，不是卡死）。
  assert.equal(acceptPush({ isReply: false, msgId: 'after', now: 0, ignoreUntil: 0, seen: s }), true);
});
