// The mini cardwall above the secretary's conversation (I-12, D-156).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Card } from '../src/lib/cardwall.ts';
import { compareMini, loadFolded, miniColumn, miniDropDone, miniWall, miniWhen, NEXT_DAYS, saveFolded, wallDay } from '../src/lib/secretary-wall.ts';

const TODAY = '2026-10-10';

function card(id: string, extra: Partial<Card> = {}): Card {
  return {
    kind: 'task',
    id,
    title: `Card ${id}`,
    column: 'ready',
    status: 'ready',
    project: null,
    assignee: 'user',
    due: null,
    time: null,
    late: false,
    label: 'L2',
    waitingReason: null,
    note: null,
    reason: null,
    blockedBy: [],
    dependsOn: [],
    priority: 0,
    planned: null,
    started: false,
    hasBody: false,
    links: 0,
    files: 0,
    checklist: { done: 0, total: 0 },
    updatedAt: '2026-10-10T08:00:00.000Z',
    ...extra,
  };
}

function commitment(id: string, day: string, extra: Partial<Card> = {}): Card {
  return card(id, { kind: 'commitment', title: `Impegno ${id}`, status: 'open', column: 'ready', due: day, ...extra });
}

/** The tests read the day straight from the ISO text: no time zone of the machine in between. */
const dayOf = (iso: string): string => iso.slice(0, 10);

test('the day of a card: the planned day first, else the due day; a planned day gone with a due day to come is today', () => {
  assert.equal(wallDay(card('a', { due: '2026-10-14' }), TODAY), '2026-10-14');
  assert.equal(wallDay(card('b', { due: '2026-10-14', planned: '2026-10-12' }), TODAY), '2026-10-12');
  assert.equal(wallDay(card('c', { due: '2026-10-14', planned: '2026-10-08' }), TODAY), TODAY);
  assert.equal(wallDay(card('d', { due: '2026-10-09', planned: '2026-10-08' }), TODAY), '2026-10-09');
  // Past its due day a card is late even when planned later, as on the cardwall.
  assert.equal(wallDay(card('i', { due: '2026-10-09', planned: '2026-10-12' }), TODAY), '2026-10-09');
  assert.equal(miniColumn(card('i', { due: '2026-10-09', planned: '2026-10-12' }), TODAY), 'late');
  assert.equal(wallDay(card('e', { planned: '2026-10-08' }), TODAY), '2026-10-08');
  assert.equal(wallDay(card('f'), TODAY), null);
  // A commitment counts on its day, whatever else.
  assert.equal(wallDay(commitment('g', '2026-10-07'), TODAY), '2026-10-07');
});

test('the columns by day: late, today, tomorrow, the next seven days, then later', () => {
  assert.equal(miniColumn(commitment('a', '2026-10-09'), TODAY), 'late');
  assert.equal(miniColumn(commitment('b', TODAY), TODAY), 'today');
  assert.equal(miniColumn(commitment('c', '2026-10-11'), TODAY), 'tomorrow');
  assert.equal(miniColumn(commitment('d', '2026-10-12'), TODAY), 'next');
  assert.equal(NEXT_DAYS, 7);
  assert.equal(miniColumn(commitment('e', '2026-10-18'), TODAY), 'next');
  assert.equal(miniColumn(commitment('f', '2026-10-19'), TODAY), 'later');
  // Across the end of the year.
  assert.equal(miniColumn(commitment('g', '2027-01-01'), '2026-12-31'), 'tomorrow');
  assert.equal(miniColumn(commitment('h', '2027-01-08'), '2026-12-31'), 'next');
});

test('what the mini wall leaves out: closed ones, cards of agents, cards without a day', () => {
  assert.equal(miniColumn(commitment('a', TODAY, { status: 'done' }), TODAY), undefined);
  assert.equal(miniColumn(commitment('b', TODAY, { status: 'postponed' }), TODAY), undefined);
  assert.equal(miniColumn(card('c', { due: TODAY, assignee: 'coder' }), TODAY), undefined);
  assert.equal(miniColumn(card('d'), TODAY), undefined);
  assert.equal(miniColumn(card('e', { due: TODAY, status: 'done' }), TODAY), undefined);
  assert.equal(miniColumn(card('f', { due: TODAY, status: 'failed' }), TODAY), undefined);
  // The user's open cards with a day are there, in any open state.
  assert.equal(miniColumn(card('g', { due: TODAY, status: 'waiting_user' }), TODAY), 'today');
  assert.equal(miniColumn(card('h', { planned: '2026-10-11', status: 'inbox' }), TODAY), 'tomorrow');
});

test('inside a column: day, then time (none last), then priority (highest first), then title', () => {
  const list = [
    card('z', { title: 'Zeta', due: TODAY }),
    card('p', { title: 'Alta', due: TODAY, priority: 3 }),
    commitment('t2', TODAY, { title: 'Dopo', time: '15:00' }),
    commitment('t1', TODAY, { title: 'Prima', time: '09:00' }),
    card('a', { title: 'Alfa', due: TODAY }),
    commitment('y', '2026-10-09', { title: 'Ieri' }),
  ];
  assert.deepEqual(
    [...list].sort(compareMini(TODAY)).map((item) => item.id),
    ['y', 't1', 't2', 'p', 'a', 'z'],
  );
});

test('the mini wall: four columns, later counted, done today newest first, open counted', () => {
  const wall = miniWall(
    [
      commitment('late', '2026-10-08'),
      commitment('today', TODAY, { time: '10:00' }),
      card('tomorrow', { due: '2026-10-11' }),
      commitment('next', '2026-10-15'),
      commitment('far1', '2026-10-25'),
      card('far2', { planned: '2026-11-02' }),
      commitment('done1', TODAY, { status: 'done', updatedAt: '2026-10-10T09:00:00.000Z' }),
      card('done2', { due: '2026-10-12', status: 'done', updatedAt: '2026-10-10T11:00:00.000Z' }),
      commitment('doneYesterday', '2026-10-09', { status: 'done', updatedAt: '2026-10-09T18:00:00.000Z' }),
      commitment('notDone', TODAY, { status: 'not_done', updatedAt: '2026-10-10T19:00:00.000Z' }),
      card('agentDone', { due: TODAY, assignee: 'coder', status: 'done', updatedAt: '2026-10-10T12:00:00.000Z' }),
    ],
    TODAY,
    dayOf,
  );
  assert.deepEqual(
    wall.columns.map((column) => [column.id, column.title, column.items.map((item) => item.id)]),
    [
      ['late', 'In ritardo', ['late']],
      ['today', 'Oggi', ['today']],
      ['tomorrow', 'Domani', ['tomorrow']],
      ['next', 'Prossimi giorni', ['next']],
    ],
  );
  assert.equal(wall.later, 2);
  assert.equal(wall.open, 6);
  assert.deepEqual(
    wall.doneToday.map((item) => item.id),
    ['done2', 'done1'],
  );
  const empty = miniWall([], TODAY, dayOf);
  assert.equal(empty.open, 0);
  assert.equal(empty.columns.length, 4);
});

test('the day line: the day where the column does not say it, the time of a commitment', () => {
  assert.equal(miniWhen(commitment('a', '2026-10-08', { time: '09:30' }), 'late', TODAY), 'giovedì 8 ottobre, 09:30');
  assert.equal(miniWhen(commitment('b', TODAY, { time: '15:00' }), 'today', TODAY), '15:00');
  assert.equal(miniWhen(commitment('c', TODAY), 'today', TODAY), undefined);
  assert.equal(miniWhen(card('d', { due: '2026-10-15' }), 'next', TODAY), 'giovedì 15 ottobre');
  assert.equal(miniWhen(card('e', { due: '2026-10-20', planned: '2026-10-14' }), 'next', TODAY), 'mercoledì 14 ottobre');
  assert.equal(miniWhen(card('f', { due: TODAY }), 'today', TODAY), undefined);
});

test('a drop on "Fatti oggi": a commitment is marked done, the user’s card moved to done, an agent’s refused', () => {
  assert.deepEqual(miniDropDone(commitment('a', TODAY)), { kind: 'commitment-done' });
  assert.equal(miniDropDone(commitment('b', TODAY, { status: 'done' })).kind, 'refuse');
  assert.deepEqual(miniDropDone(card('c', { status: 'ready' })), { kind: 'move', to: 'done' });
  assert.deepEqual(miniDropDone(card('d', { status: 'inbox' })), { kind: 'move', to: 'done' });
  assert.deepEqual(miniDropDone(card('e', { status: 'done' })), { kind: 'noop' });
  assert.equal(miniDropDone(card('f', { status: 'running' })).kind, 'refuse');
  assert.equal(miniDropDone(card('g', { assignee: 'coder', status: 'ready' })).kind, 'refuse');
  assert.deepEqual(miniDropDone(card('h', { assignee: 'coder', status: 'to_verify' })), { kind: 'move', to: 'done' });
});

test('folded or open, remembered in the browser: open by default, a broken storage changes nothing', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
  assert.equal(loadFolded(storage), false);
  saveFolded(storage, true);
  assert.equal(loadFolded(storage), true);
  saveFolded(storage, false);
  assert.equal(loadFolded(storage), false);
  assert.equal(loadFolded(undefined), false);
  const broken = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: (): void => {
      throw new Error('blocked');
    },
  };
  assert.equal(loadFolded(broken), false);
  assert.doesNotThrow(() => {
    saveFolded(broken, true);
  });
});
