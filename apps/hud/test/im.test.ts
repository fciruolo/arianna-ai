// The section "IM" of the cardwall (D-167, I-11 tappa P4a): pure helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { defaultState, loadState } from '../src/lib/cardwall.ts';
import {
  callText,
  countItems,
  defaultIm,
  fromDateTimeInput,
  groupItems,
  IM_STATE_TEXT,
  imDateText,
  type ImDetail,
  type ImItem,
  imOptionText,
  isStale,
  imTitleText,
  loadImPrefs,
  needsFirstDate,
  pickIm,
  saveImPrefs,
  summaryOf,
  withSummary,
} from '../src/lib/im.ts';

const item = (line: number, state: ImItem['state'], title: string): ImItem => ({ line, state, title, part: null, card: null });

function memory(initial?: string): { getItem(key: string): string | null; setItem(key: string, value: string): void; saved: Map<string, string> } {
  const saved = new Map<string, string>();
  if (initial !== undefined) saved.set('arianna.cardwall.im', initial);
  return { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), saved };
}

test('groupItems puts every item in its column, in the order of the file', () => {
  const groups = groupItems([item(8, 'done', 'A'), item(9, 'todo', 'B'), item(10, 'done', 'C'), item(11, 'cancelled', 'D')]);
  assert.deepEqual(
    groups.done.map((entry) => entry.title),
    ['A', 'C'],
  );
  assert.deepEqual(
    groups.todo.map((entry) => entry.title),
    ['B'],
  );
  assert.deepEqual(groups.doing, []);
  assert.deepEqual(groups.postponed, []);
  assert.equal(groups.cancelled.length, 1);
});

test('the five columns have their Italian names', () => {
  assert.deepEqual(Object.values(IM_STATE_TEXT), ['Da fare', 'In corso', 'Fatto', 'Rimandato', 'Annullato']);
});

test('imDateText reads the stamp of the file in Italian', () => {
  assert.equal(imDateText('2026-10-15 10:00'), 'gio 15 ott, 10:00');
  assert.equal(imDateText('2026-10-16 09:30'), 'ven 16 ott, 09:30');
  assert.equal(imDateText('2026-10-15'), 'gio 15 ott');
});

test('imDateText leaves a stamp it does not understand as it is', () => {
  assert.equal(imDateText('giovedì'), 'giovedì');
  assert.equal(imDateText('2026-02-30 10:00'), '2026-02-30 10:00');
});

test('imOptionText and callText', () => {
  assert.equal(imOptionText({ number: 33, date: '2026-10-15 10:00', status: 'previsto' }), 'IM-33 · gio 15 ott · Previsto');
  assert.equal(callText('2026-10-16 10:00'), 'call spostata a ven 16 ott, 10:00');
  assert.equal(callText(null), undefined);
});

test('defaultIm picks the first IM not closed', () => {
  assert.equal(
    defaultIm([
      { number: 31, status: 'chiuso' },
      { number: 32, status: 'in corso' },
      { number: 33, status: 'previsto' },
    ]),
    32,
  );
});

test('defaultIm falls back to the last IM when every one is closed, and to nothing without IM', () => {
  assert.equal(
    defaultIm([
      { number: 31, status: 'chiuso' },
      { number: 32, status: 'chiuso' },
    ]),
    32,
  );
  assert.equal(defaultIm([]), undefined);
});

test('pickIm keeps the IM chosen before only while it exists', () => {
  const ims = [
    { number: 32, status: 'chiuso' as const },
    { number: 33, status: 'previsto' as const },
  ];
  assert.equal(pickIm(ims, 32), 32);
  assert.equal(pickIm(ims, 7), 33);
  assert.equal(pickIm(ims, undefined), 33);
});

test('fromDateTimeInput turns the value of the input into the stamp of the core', () => {
  assert.equal(fromDateTimeInput('2026-10-15T10:00'), '2026-10-15 10:00');
  assert.equal(fromDateTimeInput('2026-10-15T10:00:00'), '2026-10-15 10:00');
});

test('fromDateTimeInput refuses what is not a day and an hour', () => {
  assert.equal(fromDateTimeInput(''), undefined);
  assert.equal(fromDateTimeInput('2026-10-15'), undefined);
  assert.equal(fromDateTimeInput('2026-13-01T10:00'), undefined);
  assert.equal(fromDateTimeInput('2026-10-15T25:00'), undefined);
});

test('summaryOf counts the items, withSummary keeps the list in order', () => {
  const im: ImDetail = {
    number: 34,
    date: '2026-10-22 10:00',
    call: null,
    status: 'previsto',
    label: 'L1',
    path: 'IM/IM-34.md',
    version: 'v1',
    items: [item(8, 'todo', 'A'), item(9, 'todo', 'B'), item(10, 'done', 'C')],
  };
  assert.deepEqual(countItems(im.items), { todo: 2, doing: 0, done: 1, postponed: 0, cancelled: 0 });
  assert.equal('version' in summaryOf(im), false);
  const older = { ...summaryOf({ ...im, number: 33, items: [] }) };
  const list = withSummary([older], im);
  assert.deepEqual(
    list.map((entry) => entry.number),
    [33, 34],
  );
  const again = withSummary(list, { ...im, items: [] });
  assert.equal(again.length, 2);
  assert.equal(again[1]?.counts.todo, 0);
});

test('isStale: only a 409 means the file changed', () => {
  assert.equal(isStale(new ApiError(409, 'stale version')), true);
  assert.equal(isStale(new ApiError(400, 'invalid')), false);
  assert.equal(isStale(new TypeError('fetch failed')), false);
});

test('the choice of project and IM survives in the browser', () => {
  const storage = memory();
  saveImPrefs(storage, { project: 'progetto-test', ims: { 'progetto-test': 33 } });
  assert.deepEqual(loadImPrefs(storage), { project: 'progetto-test', ims: { 'progetto-test': 33 } });
});

test('a broken or strange saved choice reads as nothing chosen', () => {
  assert.deepEqual(loadImPrefs(memory('{not json')), { project: null, ims: {} });
  assert.deepEqual(loadImPrefs(memory(JSON.stringify({ project: '../x', ims: { ok: -1, 'a b': 3, good: 4 } }))), { project: null, ims: { good: 4 } });
  assert.deepEqual(loadImPrefs(undefined), { project: null, ims: {} });
  const throwing = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: (): void => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(loadImPrefs(throwing), { project: null, ims: {} });
  assert.doesNotThrow(() => {
    saveImPrefs(throwing, { project: null, ims: {} });
  });
});

test('the cardwall remembers the view IM', () => {
  const state = defaultState();
  state.view = 'im';
  const saved = new Map<string, string>([['arianna.cardwall', JSON.stringify(state)]]);
  assert.equal(loadState({ getItem: (key) => saved.get(key) ?? null, setItem: () => undefined }).view, 'im');
});

test('an IM without a date reads "senza data", never "null"', () => {
  assert.equal(imDateText(null), 'senza data');
  assert.equal(imOptionText({ number: 3, date: null, status: 'previsto' }), 'IM-3 · senza data · Previsto');
  assert.equal(imTitleText({ number: 3, date: null }), 'IM-3 · senza data');
  assert.equal(imTitleText({ number: 33, date: '2026-10-15 10:00' }), 'IM-33 · gio 15 ott, 10:00');
  assert.equal(callText(null), undefined);
});

test('needsFirstDate asks a date with no IM or when the last IM has none', () => {
  assert.equal(needsFirstDate([]), true);
  assert.equal(needsFirstDate([{ number: 3, date: null }]), true);
  assert.equal(needsFirstDate([{ number: 4, date: null }, { number: 2, date: '2026-10-01 10:00' }]), true);
});

test('needsFirstDate does not ask when the last IM has a date', () => {
  assert.equal(needsFirstDate([{ number: 3, date: '2026-10-15 10:00' }]), false);
  assert.equal(needsFirstDate([{ number: 5, date: '2026-10-15 10:00' }, { number: 2, date: null }]), false);
});
