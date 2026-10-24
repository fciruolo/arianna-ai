// The milestones on the cardwall (D-313): bands, words, folds, drags. Fake data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Card } from '../src/lib/cardwall.ts';
import {
  bandDrop,
  blockerChoices,
  chosenProject,
  CLOSED_BAND_TEXT,
  COMMITMENT_BAND_TEXT,
  isFolded,
  loadFolds,
  type Milestone,
  milestoneBlockedText,
  milestoneChoices,
  milestoneClosing,
  noMilestoneId,
  progressText,
  progressValue,
  saveFolds,
  toggleFold,
  wallBands,
} from '../src/lib/milestones.ts';
import { pendingAskText } from '../src/lib/pending-text.ts';

function milestone(id: string, fields: Partial<Milestone> = {}): Milestone {
  return {
    id,
    project: 'panificio-rossi',
    title: id,
    description: null,
    due: null,
    late: false,
    position: 0,
    label: 'L2',
    status: 'open',
    closedAt: null,
    cards: { done: 0, total: 0 },
    dependsOn: [],
    blockedBy: [],
    proposal: null,
    ...fields,
  };
}

function card(id: string, fields: Partial<Card> = {}): Card {
  return {
    kind: 'task',
    id,
    title: id,
    column: 'inbox',
    status: 'inbox',
    project: 'panificio-rossi',
    milestone: null,
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
    turn: null,
    hasBody: false,
    links: 0,
    files: 0,
    checklist: { done: 0, total: 0 },
    updatedAt: '2026-10-24T08:00:00.000Z',
    ...fields,
  };
}

test('the project of the filter: only a chosen project gets bands', () => {
  assert.equal(chosenProject('p:panificio-rossi'), 'panificio-rossi');
  assert.equal(chosenProject('all'), null);
  assert.equal(chosenProject('general'), null);
  assert.equal(chosenProject('p:'), null);
});

test('the bands: the milestones of the project in order, then «Senza milestone»; a card of a milestone not listed is not lost', () => {
  const accessi = milestone('accessi');
  const dashboard = milestone('dashboard');
  const other = milestone('altro', { project: 'demo' });
  const cards = [card('design', { milestone: 'accessi' }), card('db', { milestone: 'accessi' }), card('ui', { milestone: 'dashboard' }), card('sola'), card('persa', { milestone: 'sparita' })];
  const bands = wallBands(cards, [accessi, dashboard, other], 'panificio-rossi');
  assert.deepEqual(bands.map((band) => band.id), ['accessi', 'dashboard', 'none:panificio-rossi']);
  assert.notEqual(noMilestoneId('panificio-rossi'), noMilestoneId('demo'));
  assert.deepEqual(bands.map((band) => band.cards.map((item) => item.id)), [['design', 'db'], ['ui'], ['sola', 'persa']]);
});

test('the words of a band: progress, «bloccata da» only while the other is open', () => {
  assert.equal(progressText(milestone('a', { cards: { done: 2, total: 3 } })), '2 di 3 fatte');
  assert.equal(progressText(milestone('a', { cards: { done: 1, total: 1 } })), '1 di 1 fatta');
  assert.equal(progressText(milestone('a')), 'Nessuna card');
  assert.equal(progressValue(milestone('a', { cards: { done: 2, total: 3 } })), 67);
  assert.equal(progressValue(milestone('a')), 0);
  const blocked = milestone('dashboard', { blockedBy: [{ id: 'accessi', title: 'Accessi', status: 'open' }] });
  assert.equal(milestoneBlockedText(blocked), 'bloccata da: Accessi');
  assert.equal(milestoneBlockedText(milestone('dashboard')), undefined);
  assert.equal(milestoneBlockedText({ ...blocked, status: 'closed' }), undefined);
});

test('the choices: a card only in the open milestones of its project (or the one it is in); a milestone waits only for one of its project', () => {
  const list = [milestone('accessi'), milestone('chiusa', { status: 'closed' }), milestone('altro', { project: 'demo' })];
  assert.deepEqual(milestoneChoices(card('x'), list).map((item) => item.id), ['accessi']);
  assert.deepEqual(milestoneChoices(card('x', { milestone: 'chiusa' }), list).map((item) => item.id), ['accessi', 'chiusa']);
  assert.deepEqual(milestoneChoices(card('x', { project: null }), list), []);
  assert.deepEqual(milestoneChoices(card('x', { kind: 'commitment' }), list), []);
  assert.deepEqual(blockerChoices(list[0] as Milestone, list).map((item) => item.id), ['chiusa']);
});

test('a drag into another band changes the milestone; never a commitment, never into a closed one', () => {
  const accessi = { id: 'accessi', milestone: milestone('accessi') };
  const none = { id: noMilestoneId('panificio-rossi'), milestone: null };
  assert.deepEqual(bandDrop(card('x'), accessi), { kind: 'change', milestone: 'accessi' });
  assert.deepEqual(bandDrop(card('x', { milestone: 'accessi' }), none), { kind: 'change', milestone: null });
  assert.deepEqual(bandDrop(card('x', { milestone: 'accessi' }), accessi), { kind: 'same' });
  assert.deepEqual(bandDrop(card('x'), none), { kind: 'same' });
  assert.deepEqual(bandDrop(card('x', { kind: 'commitment' }), accessi), { kind: 'refuse', message: COMMITMENT_BAND_TEXT });
  assert.deepEqual(bandDrop(card('x'), { id: 'c', milestone: milestone('c', { status: 'closed' }) }), { kind: 'refuse', message: CLOSED_BAND_TEXT });
});

test('the folds: a closed milestone starts folded, the choice is kept in this browser, bad data is ignored', () => {
  const open = { id: 'a', milestone: milestone('a') };
  const closed = { id: 'b', milestone: milestone('b', { status: 'closed' }) };
  assert.equal(isFolded(open, {}), false);
  assert.equal(isFolded(closed, {}), true);
  const folds = toggleFold(closed, toggleFold(open, {}));
  assert.equal(isFolded(open, folds), true);
  assert.equal(isFolded(closed, folds), false);
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  saveFolds(storage, folds);
  assert.deepEqual(loadFolds(storage), folds);
  store.set('arianna.cardwall.milestones', '{"a": "sì", "b": true}');
  assert.deepEqual(loadFolds(storage), { b: true });
  store.set('arianna.cardwall.milestones', 'non json');
  assert.deepEqual(loadFolds(storage), {});
  assert.deepEqual(loadFolds(undefined), {});
});

test('the approval of the closing: its card and its line in «Decisioni in attesa»', () => {
  const approval = { kind: 'milestone' as const, action: 'milestone.close', detail: { milestoneId: 'm', project: 'panificio-rossi', title: 'Accessi' } };
  assert.deepEqual(milestoneClosing(approval), { title: 'Accessi', project: 'panificio-rossi' });
  assert.equal(milestoneClosing({ kind: 'plan', detail: {} }), undefined);
  assert.equal(milestoneClosing({ kind: 'milestone', detail: { title: 3 } }), undefined);
  assert.equal(pendingAskText(approval), 'Chiudere la milestone «Accessi» di panificio-rossi');
  assert.equal(pendingAskText({ ...approval, detail: {} }), 'Chiudere una milestone');
});
