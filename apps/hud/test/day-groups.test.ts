import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupByDay } from '../src/lib/day-groups.ts';
import type { Conversation } from '../src/lib/types.ts';

function conversation(id: string, lastMessageAt: Date | null, createdAt = new Date(2026, 9, 1)): Conversation {
  return {
    id,
    mode: 'private',
    clearance: 'L2',
    effectiveLabel: 'L0',
    workspace: null,
    model: null,
    title: id,
    archivedAt: null,
    telegram: false,
    origin: 'user',
    systemReason: null,
    sourceTaskId: null,
    sourceConversationId: null,
    questionAttached: false,
    sourceTaskStatus: null,
    createdAt: createdAt.toISOString(),
    lastMessageAt: lastMessageAt?.toISOString() ?? null,
  };
}

test('conversations fall into today, yesterday, the last 7 days and earlier, in their order', () => {
  const now = new Date(2026, 9, 4, 10, 30);
  const groups = groupByDay(
    [
      conversation('a', new Date(2026, 9, 4, 0, 5)),
      conversation('b', new Date(2026, 9, 3, 23, 59)),
      conversation('c', new Date(2026, 9, 3, 8, 0)),
      conversation('d', new Date(2026, 8, 28, 12, 0)),
      conversation('e', new Date(2026, 8, 27, 12, 0)),
      conversation('f', null, new Date(2026, 9, 4, 9, 0)),
    ],
    now,
  );
  assert.deepEqual(
    groups.map((group) => [group.title, group.conversations.map((item) => item.id)]),
    [
      ['Oggi', ['a', 'f']],
      ['Ieri', ['b', 'c']],
      ['Ultimi 7 giorni', ['d']],
      ['Prima', ['e']],
    ],
  );
});

test('empty sections are left out; a date in the future counts as today', () => {
  const now = new Date(2026, 9, 4, 10, 30);
  assert.deepEqual(groupByDay([], now), []);
  assert.deepEqual(groupByDay([conversation('x', new Date(2026, 9, 5, 1, 0))], now).map((group) => group.title), ['Oggi']);
});
