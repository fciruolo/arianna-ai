import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadDismissed, MAX_REMOTE_DECISIONS, remoteDecisions, REMOTE_WINDOW_MS, saveDismissed } from '../src/lib/remote-decisions.ts';
import type { Approval } from '../src/lib/types.ts';

const NOW = Date.parse('2026-10-02T21:00:00.000Z');

function approval(id: string, over: Partial<Approval> = {}): Approval {
  return {
    id,
    taskId: null,
    kind: 'action',
    action: 'send_external',
    detail: {},
    label: 'L1',
    state: 'approved',
    requestedAt: '2026-10-02T20:00:00.000Z',
    decidedAt: '2026-10-02T20:30:00.000Z',
    decidedVia: 'telegram',
    ...over,
  };
}

test('decisions from Telegram or the phone in the last day become notes, newest first', () => {
  const notes = remoteDecisions(
    [
      approval('old-first', { decidedAt: '2026-10-02T20:00:00.000Z' }),
      approval('phone', { decidedVia: 'phone', state: 'rejected', action: 'payment', decidedAt: '2026-10-02T20:45:00.000Z' }),
      approval('mid'),
    ],
    NOW,
    new Set(),
  );
  assert.deepEqual(notes, [
    { approvalId: 'phone', state: 'rejected', via: 'phone', action: 'payment', ts: '2026-10-02T20:45:00.000Z' },
    { approvalId: 'mid', state: 'approved', via: 'telegram', action: 'send_external', ts: '2026-10-02T20:30:00.000Z' },
    { approvalId: 'old-first', state: 'approved', via: 'telegram', action: 'send_external', ts: '2026-10-02T20:00:00.000Z' },
  ]);
});

test('web decisions, expired or pending approvals, old, undated and dismissed ones make no note', () => {
  const tooOld = new Date(NOW - REMOTE_WINDOW_MS - 1).toISOString();
  const notes = remoteDecisions(
    [
      approval('web', { decidedVia: 'web' }),
      approval('expired', { state: 'expired', decidedVia: null }),
      approval('pending', { state: 'pending', decidedAt: null, decidedVia: null }),
      approval('too-old', { decidedAt: tooOld }),
      approval('undated', { decidedAt: null }),
      approval('dismissed'),
      approval('kept'),
    ],
    NOW,
    new Set(['dismissed']),
  );
  assert.deepEqual(notes.map((note) => note.approvalId), ['kept']);
});

test('at most a few notes are shown', () => {
  const many = Array.from({ length: 9 }, (_, index) => approval(`a${String(index)}`, { decidedAt: new Date(NOW - index * 1000).toISOString() }));
  assert.deepEqual(remoteDecisions(many, NOW, new Set()).map((note) => note.approvalId), ['a0', 'a1', 'a2', 'a3', 'a4']);
  assert.equal(MAX_REMOTE_DECISIONS, 5);
});

test('dismissed notes are remembered, pruned, and survive a broken storage', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  saveDismissed(storage, new Set(['a', 'gone']), new Set(['a', 'b']));
  assert.deepEqual([...loadDismissed(storage)], ['a']);

  store.set('arianna.dismissedDecisions', '{not json');
  assert.deepEqual([...loadDismissed(storage)], []);
  store.set('arianna.dismissedDecisions', '["x", 3, null]');
  assert.deepEqual([...loadDismissed(storage)], ['x']);
  assert.deepEqual([...loadDismissed(undefined)], []);
  const throwing = {
    getItem: (): string => {
      throw new Error('blocked');
    },
    setItem: (): void => {
      throw new Error('full');
    },
  };
  assert.deepEqual([...loadDismissed(throwing)], []);
  assert.doesNotThrow(() => {
    saveDismissed(throwing, new Set(['a']), new Set(['a']));
  });
});
