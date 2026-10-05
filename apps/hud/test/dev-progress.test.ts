import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANSWER_EMPTY_TEXT,
  answerStatus,
  answerTooLongText,
  barSegments,
  checkAnswer,
  countStates,
  filterItems,
  filterQuestions,
  groupItems,
  groupQuestions,
  markAnswered,
  pendingBadge,
  pendingCount,
  pendingFromBody,
  pendingText,
  percentDone,
  phases,
  skippedText,
  type OpenQuestion,
  type ProgressItem,
} from '../src/lib/dev-progress.ts';
import { DEV_PATH, isDevPath, isSettingsPath } from '../src/lib/route.ts';

const ITEMS: ProgressItem[] = [
  { id: 'D-001', kind: 'decision', title: 'Livelli di privacy L0-L3', state: 'done', status: 'Accettata', phase: null, source: 'DECISIONS.md' },
  { id: 'D-081', kind: 'decision', title: 'Prova di un modello del catalogo', state: 'doing', status: 'Proposta, applicata: da confermare', phase: null, source: 'DECISIONS.md' },
  { id: '1.16', kind: 'task', title: 'Adattatore codex exec', state: 'todo', status: 'Da fare', phase: '1B', source: 'PHASE-0-1-TASKS.md' },
  { id: '0.1', kind: 'task', title: 'Monorepo pnpm', state: 'done', status: 'Ore reali: 0,1', phase: '0', source: 'PHASE-0-1-TASKS.md' },
  { id: 'F2.3', kind: 'epic', title: 'Archivio e ingestione', state: 'doing', status: 'in parte anticipati', phase: '2', source: 'ROADMAP.md' },
  { id: 'Idea 3', kind: 'idea', title: 'DBOS per esecuzione durevole', state: 'todo', status: 'Da scegliere', phase: null, source: 'OPEN-QUESTIONS.md' },
];

function question(key: string, overrides: Partial<OpenQuestion> = {}): OpenQuestion {
  return { key, kind: 'proposal', ref: 'D-078', topic: 'Arianna sviluppata da dentro Arianna', text: 'Domanda?', detail: null, source: 'PROPOSTE.md', answer: null, ...overrides };
}

test('the bar has three parts summing to 100, empty without items', () => {
  const segments = barSegments({ done: 2, doing: 1, todo: 1 });
  assert.deepEqual(
    segments.map((segment) => [segment.state, segment.count, segment.percent]),
    [
      ['done', 2, 50],
      ['doing', 1, 25],
      ['todo', 1, 25],
    ],
  );
  assert.deepEqual(
    barSegments({ done: 0, doing: 0, todo: 0 }).map((segment) => segment.percent),
    [0, 0, 0],
  );
});

test('the share done rounds down', () => {
  assert.equal(percentDone({ done: 2, doing: 0, todo: 1 }), 66);
  assert.equal(percentDone({ done: 249, doing: 1, todo: 0 }), 99);
  assert.equal(percentDone({ done: 0, doing: 0, todo: 0 }), 0);
});

test('items filter by state, kind, phase and text without accents', () => {
  const ids = (filter: Parameters<typeof filterItems>[1]) => filterItems(ITEMS, filter).map((item) => item.id);
  assert.deepEqual(ids({ state: 'all', phase: 'all', kind: 'all', query: '' }).length, ITEMS.length);
  assert.deepEqual(ids({ state: 'doing', phase: 'all', kind: 'all', query: '' }), ['D-081', 'F2.3']);
  assert.deepEqual(ids({ state: 'all', phase: 'all', kind: 'task', query: '' }), ['1.16', '0.1']);
  assert.deepEqual(ids({ state: 'all', phase: '1B', kind: 'all', query: '' }), ['1.16']);
  assert.deepEqual(ids({ state: 'all', phase: 'none', kind: 'all', query: '' }), ['D-001', 'D-081', 'Idea 3']);
  assert.deepEqual(ids({ state: 'all', phase: 'all', kind: 'all', query: 'esecuzione DURÉVOLE' }), ['Idea 3']);
  assert.deepEqual(ids({ state: 'done', phase: 'all', kind: 'all', query: 'codex' }), []);
});

test('phases come in roadmap order and counts per state', () => {
  assert.deepEqual(phases(ITEMS), ['0', '1B', '2']);
  assert.deepEqual(countStates(ITEMS), { all: 6, done: 2, doing: 2, todo: 2 });
});

test('items are grouped by kind, empty groups left out', () => {
  assert.deepEqual(
    groupItems(ITEMS.filter((item) => item.kind !== 'idea')).map((group) => [group.kind, group.items.length]),
    [
      ['decision', 2],
      ['task', 2],
      ['epic', 1],
    ],
  );
});

test('questions group by proposal and by kind, and filter by answer', () => {
  const questions = [
    question('D-078#1'),
    question('conf-D-081', { kind: 'confirm', ref: 'D-081', topic: 'Prova' }),
    question('D-078#2', { answer: { state: 'new', at: '2026-10-05 07:40' } }),
    question('D-096#1', { ref: 'D-096', topic: '' }),
    question('ho-chiave-age-vera', { kind: 'waiting', ref: 'In attesa', topic: '' }),
  ];
  assert.deepEqual(
    groupQuestions(questions).map((group) => [group.title, group.questions.map((item) => item.key)]),
    [
      ['D-078 — Arianna sviluppata da dentro Arianna', ['D-078#1', 'D-078#2']],
      ['Decisioni applicate da confermare', ['conf-D-081']],
      ['D-096', ['D-096#1']],
      ['In attesa dell’utente (HANDOFF.md)', ['ho-chiave-age-vera']],
    ],
  );
  assert.deepEqual(
    filterQuestions(questions, 'answered').map((item) => item.key),
    ['D-078#2'],
  );
  assert.equal(filterQuestions(questions, 'open').length, 4);
  assert.equal(filterQuestions(questions, 'all').length, 5);
});

test('an answered question says it waits for Claude, or that Claude applied it', () => {
  assert.equal(answerStatus(question('a')), null);
  assert.equal(answerStatus(question('a', { answer: { state: 'new', at: '2026-10-05 07:40' } })), 'Risposta inviata (2026-10-05 07:40), in attesa di Claude');
  assert.match(answerStatus(question('a', { answer: { state: 'done', at: '2026-10-05 07:40' } })) ?? '', /applicata da Claude/);
  // A section of answers in PROPOSTE.md without a date.
  assert.equal(answerStatus(question('a', { answer: { state: 'done', at: '' } })), 'Risposta applicata da Claude');
  const marked = markAnswered([question('a'), question('b')], 'b', '2026-10-05 08:00');
  assert.equal(marked[0]?.answer, null);
  assert.deepEqual(marked[1]?.answer, { state: 'new', at: '2026-10-05 08:00' });
});

test('an answer must not be empty nor longer than the limit', () => {
  assert.deepEqual(checkAnswer('  sì  ', 10), { text: 'sì' });
  assert.deepEqual(checkAnswer(' \n ', 10), { error: ANSWER_EMPTY_TEXT });
  assert.deepEqual(checkAnswer('x'.repeat(11), 10), { error: answerTooLongText(10) });
  assert.deepEqual(checkAnswer('x'.repeat(10), 10), { text: 'x'.repeat(10) });
});

test('skipped lines are named per document, nothing when none', () => {
  assert.equal(skippedText({}), null);
  assert.equal(skippedText({ 'DECISIONS.md': 0 }), null);
  assert.equal(skippedText({ 'DECISIONS.md': 2, 'HANDOFF.md': 1 }), 'Righe non riconosciute e saltate: 2 in DECISIONS.md, 1 in HANDOFF.md.');
});

test('the page of the development has its own address, not the settings one', () => {
  assert.equal(isDevPath(DEV_PATH), true);
  assert.equal(isDevPath(`${DEV_PATH}/`), true);
  assert.equal(isDevPath('/sviluppo/altro'), false);
  assert.equal(isSettingsPath(DEV_PATH), false);
});

test('the dot counts the questions without an answer, sent or applied (D-120)', () => {
  const questions = [
    question('D-078#1'),
    question('D-078#2', { answer: { state: 'new', at: '2026-10-05 07:40' } }),
    question('conf-D-081', { kind: 'confirm', answer: { state: 'done', at: '' } }),
    question('D-078#3'),
  ];
  assert.equal(pendingCount(questions), 2);
  assert.equal(pendingCount(markAnswered(questions, 'D-078#1', '2026-10-05 08:00')), 1);
  assert.equal(pendingCount([]), 0);
});

test('the dot says how many questions wait, singular for one, nothing for none', () => {
  assert.equal(pendingText(1), 'Devi rispondere a 1 quesito');
  assert.equal(pendingText(3), 'Devi rispondere a 3 quesiti');
  assert.equal(pendingText(0), null);
  assert.equal(pendingText(-2), null);
  assert.equal(pendingText(Number.NaN), null);
  assert.equal(pendingBadge(7), '7');
  assert.equal(pendingBadge(99), '99');
  assert.equal(pendingBadge(150), '99+');
  assert.equal(pendingBadge(0), null);
});

test('the number of the core is read only when it is a count', () => {
  assert.equal(pendingFromBody({ pending: 4 }), 4);
  assert.equal(pendingFromBody({ pending: 0 }), 0);
  assert.equal(pendingFromBody({ pending: -1 }), 0);
  assert.equal(pendingFromBody({ pending: 2.5 }), 0);
  assert.equal(pendingFromBody({ pending: '4' }), 0);
  assert.equal(pendingFromBody(null), 0);
  assert.equal(pendingFromBody('4'), 0);
});
