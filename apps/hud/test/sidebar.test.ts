import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEV_PREFIX, markTitle, parseInstallation } from '../src/lib/installation.ts';
import {
  enterRow,
  highlightParts,
  IDLE_SEARCH,
  moveSelection,
  noteGraphId,
  resultsText,
  searchAnswered,
  searchFailed,
  searchFootnote,
  searchGroups,
  searchQuery,
  searchStarted,
  textChanged,
  type SearchResult,
} from '../src/lib/search.ts';
import { activeText, callTarget, splitPinned } from '../src/lib/sidebar.ts';
import type { Conversation } from '../src/lib/types.ts';

function conversation(id: string, pinnedAt: string | null, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    mode: 'private',
    clearance: 'L2',
    effectiveLabel: 'L0',
    agent: null,
    contextTokens: null,
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
    createdAt: '2026-10-01T10:00:00.000Z',
    lastMessageAt: null,
    pinnedAt,
    ...extra,
  };
}

test('pinned conversations come first, the latest pin on top, the others keep their order', () => {
  const list = [conversation('a', null), conversation('b', '2026-10-01T10:00:00.000Z'), conversation('c', null), conversation('d', '2026-10-02T10:00:00.000Z')];
  const { pinned, others } = splitPinned(list);
  assert.deepEqual(
    pinned.map((item) => item.id),
    ['d', 'b'],
  );
  assert.deepEqual(
    others.map((item) => item.id),
    ['a', 'c'],
  );
  assert.deepEqual(splitPinned([]), { pinned: [], others: [] });
});

test('"Chiama" calls in the open private conversation, otherwise in a new private one', () => {
  const open = conversation('p', null);
  assert.deepEqual(callTarget(open, true), { here: 'p' });
  assert.equal(callTarget(open, false), 'new');
  assert.equal(callTarget(undefined, true), 'new');
  assert.equal(callTarget(conversation('w', null, { mode: 'work' }), true), 'new');
  assert.equal(callTarget(conversation('x', null, { archivedAt: '2026-10-02T10:00:00.000Z' }), true), 'new');
  assert.equal(callTarget(conversation('s', null, { origin: 'system' }), true), 'new');
});

test('the active agents are said in Italian', () => {
  assert.equal(activeText(0), 'nessuno attivo');
  assert.equal(activeText(1), '1 attivo');
  assert.equal(activeText(3), '3 attivi');
});

test('a query is asked only with 2-200 characters, white space collapsed', () => {
  assert.equal(searchQuery(' a '), undefined);
  assert.equal(searchQuery(''), undefined);
  assert.equal(searchQuery('  ciao   mondo '), 'ciao mondo');
  assert.equal(searchQuery('è'.repeat(200)), 'è'.repeat(200));
  assert.equal(searchQuery('x'.repeat(201)), undefined);
});

test('the excerpt is cut around the highlight; a highlight out of range marks nothing', () => {
  assert.deepEqual(highlightParts('la torta di mele', { start: 3, length: 5 }), [
    { text: 'la ', mark: false },
    { text: 'torta', mark: true },
    { text: ' di mele', mark: false },
  ]);
  assert.deepEqual(highlightParts('mele', { start: 0, length: 4 }), [{ text: 'mele', mark: true }]);
  assert.deepEqual(highlightParts('mele', { start: 2, length: 9 }), [{ text: 'mele', mark: false }]);
  assert.deepEqual(highlightParts('mele', { start: -1, length: 2 }), [{ text: 'mele', mark: false }]);
  assert.deepEqual(highlightParts('mele', null), [{ text: 'mele', mark: false }]);
  assert.deepEqual(highlightParts('', null), []);
});

const RESULT: SearchResult = {
  conversations: [{ id: 'c1', title: 'Torta', mode: 'work', origin: 'user', label: 'L1', archived: false, pinned: false, lastMessageAt: null }],
  messages: [
    {
      conversationId: 'c2',
      messageId: '42',
      title: null,
      role: 'assistant',
      at: '2026-10-01T10:00:00.000Z',
      label: 'L2',
      archived: true,
      snippet: 'una torta',
      highlight: { start: 4, length: 5 },
    },
  ],
  notes: [
    {
      name: 'x.md',
      path: 'kb/inbox/x.md',
      title: null,
      tags: ['cucina', 'dolci'],
      status: 'organized',
      capturedAt: null,
      label: 'L2',
      field: 'body',
      snippet: 'torta',
      highlight: { start: 0, length: 5 },
    },
  ],
  pages: [],
  hidden: 0,
  truncated: false,
};

test('the results become groups in a fixed order, each row with where it leads', () => {
  const groups = searchGroups(RESULT);
  assert.deepEqual(
    groups.map((group) => group.title),
    ['Conversazioni', 'Messaggi', 'Pensieri e note'],
  );
  assert.deepEqual(groups.at(0)?.rows.at(0)?.target, { conversation: 'c1' });
  assert.equal(groups.at(0)?.rows.at(0)?.meta, 'lavoro');
  assert.deepEqual(groups.at(1)?.rows.at(0)?.target, { conversation: 'c2', message: '42' });
  assert.equal(groups.at(1)?.rows.at(0)?.title, 'Nuova conversazione');
  assert.equal(groups.at(1)?.rows.at(0)?.meta, 'Arianna · archiviata');
  assert.deepEqual(groups.at(2)?.rows.at(0)?.target, { graph: 'inbox/x.md' });
  assert.equal(groups.at(2)?.rows.at(0)?.title, 'x.md');
  assert.equal(groups.at(2)?.rows.at(0)?.meta, '#cucina #dolci');
  assert.deepEqual(searchGroups({ ...RESULT, conversations: [], messages: [], notes: [] }), []);
});

test('a note is a node of the graph by its path under kb/', () => {
  assert.equal(noteGraphId({ path: 'kb/inbox/a.md', name: 'a.md' }), 'inbox/a.md');
  assert.equal(noteGraphId({ path: 'altro/a.md', name: 'a.md' }), 'inbox/a.md');
});

test('the arrows move through the rows and wrap around', () => {
  assert.equal(moveSelection(-1, 3, 1), 0);
  assert.equal(moveSelection(-1, 3, -1), 2);
  assert.equal(moveSelection(2, 3, 1), 0);
  assert.equal(moveSelection(0, 3, -1), 2);
  assert.equal(moveSelection(0, 0, 1), -1);
});

test('the foot of the window says what was hidden or cut, never what it holds', () => {
  assert.equal(searchFootnote({ hidden: 0, truncated: false }), null);
  assert.equal(searchFootnote({ hidden: 1, truncated: false }), '1 elemento sopra Privato non è cercato.');
  assert.equal(
    searchFootnote({ hidden: 3, truncated: true }),
    '3 elementi sopra Privato non sono cercati; la ricerca si è fermata dopo 2 secondi: potrebbe mancare qualcosa.',
  );
  assert.equal(searchFootnote({ hidden: 0, truncated: true }), 'La ricerca si è fermata dopo 2 secondi: potrebbe mancare qualcosa.');
});

test('the tab of a development installation starts with [DEV], once', () => {
  assert.equal(markTitle('Arianna', 'development'), `${DEV_PREFIX}Arianna`);
  assert.equal(markTitle(`${DEV_PREFIX}Arianna`, 'development'), `${DEV_PREFIX}Arianna`);
  assert.equal(markTitle(`${DEV_PREFIX}Arianna`, 'production'), 'Arianna');
  assert.equal(markTitle('Torta · Arianna', undefined), 'Torta · Arianna');
});

test('the answer of /api/installation is checked; anything unexpected is no answer', () => {
  assert.deepEqual(parseInstallation({ installation: { mode: 'development', home: 'arianna-ai', version: 'abc1234' } }), {
    mode: 'development',
    home: 'arianna-ai',
    version: 'abc1234',
  });
  assert.deepEqual(parseInstallation({ installation: { mode: 'production', home: 'arianna', version: null } }), {
    mode: 'production',
    home: 'arianna',
    version: null,
  });
  const bad: unknown[] = [
    null,
    'x',
    {},
    { installation: null },
    { installation: { mode: 'test', home: 'a', version: null } },
    { installation: { mode: 'production', home: 3, version: null } },
    { installation: { mode: 'production', home: 'a', version: 1 } },
  ];
  for (const value of bad) assert.equal(parseInstallation(value), undefined);
});

test('an answer of an older query is dropped and Invio never opens a row of it', () => {
  let state = textChanged(IDLE_SEARCH, 'tor');
  const first = state.round;
  assert.equal(state.phase, 'waiting');
  assert.equal(enterRow(state, 3), undefined);
  state = searchStarted(state, first);
  assert.equal(state.phase, 'loading');
  // The user types again before the answer: a new round, nothing selected.
  state = textChanged(state, 'torta');
  const second = state.round;
  assert.equal(searchAnswered(state, first, RESULT), state);
  assert.equal(searchFailed(state, first, 'x'), state);
  assert.equal(searchStarted(state, first), state);
  assert.equal(enterRow(state, 3), undefined);
  state = searchAnswered(searchStarted(state, second), second, RESULT);
  assert.equal(state.phase, 'done');
  assert.equal(state.selected, 0);
  assert.equal(enterRow(state, 3), 0);
  assert.equal(resultsText(state, 3), '3 risultati');
  // Typing again keeps the old rows on screen but clears the selection at once.
  const typing = textChanged(state, 'torte');
  assert.equal(typing.result, RESULT);
  assert.equal(typing.selected, -1);
  assert.equal(enterRow(typing, 3), undefined);
  assert.equal(resultsText(typing, 3), 'Cerco…');
});

test('an error leaves no stale results; a text too short goes back to idle', () => {
  let state = searchAnswered(textChanged(IDLE_SEARCH, 'torta'), 1, RESULT);
  state = textChanged(state, 'torte');
  state = searchFailed(state, state.round, 'rete');
  assert.equal(state.result, null);
  assert.equal(state.problem, 'rete');
  assert.equal(resultsText(state, 0), 'Ricerca non riuscita');
  const idle = textChanged(state, 'x');
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.result, null);
  assert.equal(idle.problem, null);
  assert.equal(resultsText(idle, 0), '');
  const empty = searchAnswered(textChanged(IDLE_SEARCH, 'zz'), 1, { ...RESULT, conversations: [], messages: [], notes: [] });
  assert.equal(empty.selected, -1);
  assert.equal(enterRow(empty, 0), undefined);
  assert.equal(resultsText(empty, 0), 'Nessun risultato');
  assert.equal(resultsText(searchAnswered(textChanged(IDLE_SEARCH, 'zz'), 1, RESULT), 1), '1 risultato');
});
