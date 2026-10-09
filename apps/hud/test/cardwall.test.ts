// The page "Cardwall" (I-13 tappa C2, D-152): pure helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  ALL_FILTERS,
  AGENT_DONE_TEXT,
  assigneeLocked,
  blockedText,
  cardErrorText,
  cardMarks,
  COMMITMENT_MOVE_TEXT,
  dataUrlBase64,
  defaultState,
  ENGINE_STOPPED_TEXT,
  fileKindText,
  fileRefusal,
  fileSizeText,
  historyLines,
  historyText,
  isWebAddress,
  MAX_FILE_BYTES,
  moveRefusal,
  NOT_BY_HAND_TEXT,
  plannedText,
  priorityText,
  progressPercent,
  RUNNING_TEXT,
  sortCards,
  stateText,
  dependencyChoices,
  dropAction,
  dueText,
  filtersActive,
  groupCards,
  isCardwallPath,
  loadState,
  matches,
  moveButtons,
  saveState,
  wallColumns,
  weekOf,
  type Card,
} from '../src/lib/cardwall.ts';

function card(fields: Partial<Card>): Card {
  return {
    kind: 'task',
    id: 'a',
    title: 'Card',
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
    ...fields,
  };
}

function memory(): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
}

test('the address of the page', () => {
  assert.equal(isCardwallPath('/cardwall'), true);
  assert.equal(isCardwallPath('/cardwall/'), true);
  assert.equal(isCardwallPath('/cardwal'), false);
  assert.equal(isCardwallPath('/progetti'), false);
});

test('five columns by default; Inbox and Falliti apart on request', () => {
  assert.deepEqual(
    wallColumns({ splitInbox: false, splitFailed: false }).map((column) => [column.id, column.holds]),
    [
      ['todo', ['inbox', 'ready']],
      ['running', ['running']],
      ['waiting', ['waiting', 'failed']],
      ['to_verify', ['to_verify']],
      ['done', ['done']],
    ],
  );
  const split = wallColumns({ splitInbox: true, splitFailed: true });
  assert.deepEqual(
    split.map((column) => column.id),
    ['inbox', 'todo', 'running', 'waiting', 'failed', 'to_verify', 'done'],
  );
  assert.deepEqual(split.find((column) => column.id === 'todo')?.holds, ['ready']);
  assert.deepEqual(split.find((column) => column.id === 'waiting')?.holds, ['waiting']);
});

test('cards go in their column: failed with Aspetta, late first, closed newest first', () => {
  const columns = wallColumns({ splitInbox: false, splitFailed: false });
  const cards = [
    card({ id: 'later', due: '2026-10-20' }),
    card({ id: 'none' }),
    card({ id: 'late', due: '2026-10-01', late: true }),
    card({ id: 'inbox', column: 'inbox', status: 'inbox', due: '2026-10-12' }),
    card({ id: 'failed', column: 'failed', status: 'failed' }),
    card({ id: 'old', column: 'done', status: 'done', updatedAt: '2026-10-01T00:00:00.000Z' }),
    card({ id: 'new', column: 'done', status: 'done', updatedAt: '2026-10-09T00:00:00.000Z' }),
  ];
  const groups = groupCards(cards, columns);
  assert.deepEqual(groups.get('todo')?.map((item) => item.id), ['late', 'inbox', 'later', 'none']);
  assert.deepEqual(groups.get('waiting')?.map((item) => item.id), ['failed']);
  assert.deepEqual(groups.get('done')?.map((item) => item.id), ['new', 'old']);
  assert.deepEqual(groups.get('running'), []);
  // A hidden column holds nothing, and no other takes its cards.
  const shown = columns.filter((column) => column.id !== 'done');
  assert.equal(groupCards(cards, shown).has('done'), false);
});

test('a drop: where a task goes, what does nothing, what is refused', () => {
  const [todo, running, waiting, toVerify, done] = wallColumns({ splitInbox: false, splitFailed: false });
  const split = wallColumns({ splitInbox: true, splitFailed: true });
  const failed = split.find((column) => column.id === 'failed');
  const inbox = split.find((column) => column.id === 'inbox');
  const splitTodo = split.find((column) => column.id === 'todo');
  assert.ok(todo && running && waiting && toVerify && done && failed && inbox && splitTodo);
  assert.equal(inbox.drop, null);
  assert.deepEqual(dropAction(card({ status: 'ready', column: 'ready' }), inbox), { kind: 'none' });
  assert.deepEqual(dropAction(card({ status: 'waiting_user', column: 'waiting' }), todo), { kind: 'move', to: 'ready' });
  assert.deepEqual(dropAction(card({ status: 'inbox', column: 'inbox' }), todo), { kind: 'noop' });
  assert.deepEqual(dropAction(card({ status: 'inbox', column: 'inbox' }), splitTodo), { kind: 'move', to: 'ready' });
  assert.deepEqual(dropAction(card({ status: 'ready' }), todo), { kind: 'noop' });
  assert.deepEqual(dropAction(card({ status: 'ready' }), waiting), { kind: 'move', to: 'waiting_user' });
  assert.deepEqual(dropAction(card({ status: 'waiting_user', column: 'waiting' }), waiting), { kind: 'noop' });
  assert.deepEqual(dropAction(card({ status: 'failed', column: 'failed' }), waiting), { kind: 'noop' });
  assert.deepEqual(dropAction(card({ status: 'to_verify', column: 'to_verify' }), done), { kind: 'move', to: 'done' });
  assert.deepEqual(dropAction(card({ status: 'ready' }), failed), { kind: 'move', to: 'failed' });
  assert.deepEqual(dropAction(card({ status: 'ready' }), running), { kind: 'none' });
  assert.deepEqual(dropAction(card({ status: 'ready' }), toVerify), { kind: 'none' });
  // What the core refuses is refused here, with its reason.
  assert.deepEqual(dropAction(card({ status: 'to_verify', column: 'to_verify' }), todo), { kind: 'refuse', message: NOT_BY_HAND_TEXT });
  assert.deepEqual(dropAction(card({ status: 'running', column: 'running' }), done), { kind: 'refuse', message: RUNNING_TEXT });
  assert.deepEqual(dropAction(card({ status: 'ready', assignee: 'coder' }), done), { kind: 'refuse', message: AGENT_DONE_TEXT });
  assert.deepEqual(dropAction(card({ status: 'failed', column: 'failed', started: true }), todo), { kind: 'refuse', message: ENGINE_STOPPED_TEXT });
  assert.deepEqual(dropAction(card({ status: 'failed', column: 'failed' }), todo), { kind: 'move', to: 'ready' });
  // A commitment: only Fatto, and only while open.
  const open = card({ kind: 'commitment', status: 'open' });
  assert.deepEqual(dropAction(open, done), { kind: 'commitment-done' });
  assert.deepEqual(dropAction(card({ kind: 'commitment', status: 'done', column: 'done' }), done), { kind: 'noop' });
  assert.deepEqual(dropAction(open, waiting), { kind: 'refuse', message: COMMITMENT_MOVE_TEXT });
  assert.deepEqual(dropAction(open, running), { kind: 'none' });
});

test('the moves by hand are those of the core (userMovesInto)', () => {
  // ready from inbox, waiting_user, failed; waiting_user from inbox, ready; done and failed from inbox, ready, waiting_user, to_verify.
  assert.equal(moveRefusal(card({ status: 'inbox' }), 'ready'), undefined);
  assert.equal(moveRefusal(card({ status: 'waiting_user' }), 'ready'), undefined);
  assert.equal(moveRefusal(card({ status: 'to_verify' }), 'ready'), NOT_BY_HAND_TEXT);
  assert.equal(moveRefusal(card({ status: 'done' }), 'ready'), NOT_BY_HAND_TEXT);
  assert.equal(moveRefusal(card({ status: 'ready' }), 'waiting_user'), undefined);
  assert.equal(moveRefusal(card({ status: 'failed' }), 'waiting_user'), NOT_BY_HAND_TEXT);
  assert.equal(moveRefusal(card({ status: 'to_verify' }), 'waiting_user'), NOT_BY_HAND_TEXT);
  assert.equal(moveRefusal(card({ status: 'to_verify', assignee: 'coder' }), 'done'), undefined);
  assert.equal(moveRefusal(card({ status: 'waiting_user', assignee: 'coder' }), 'done'), AGENT_DONE_TEXT);
  assert.equal(moveRefusal(card({ status: 'failed' }), 'done'), NOT_BY_HAND_TEXT);
  assert.equal(moveRefusal(card({ status: 'to_verify' }), 'failed'), undefined);
  assert.equal(moveRefusal(card({ status: 'running' }), 'failed'), RUNNING_TEXT);
  assert.equal(moveRefusal(card({ status: 'waiting_user', started: true }), 'ready'), ENGINE_STOPPED_TEXT);
  assert.equal(moveRefusal(card({ status: 'waiting_user', started: true }), 'done'), undefined);
  assert.equal(moveRefusal(card({ kind: 'commitment', status: 'open' }), 'done'), NOT_BY_HAND_TEXT);
});

test('the buttons of the detail are only the moves the core allows', () => {
  assert.deepEqual(
    moveButtons(card({ status: 'inbox' })).map((item) => item.to),
    ['waiting_user', 'done', 'failed'],
  );
  assert.deepEqual(
    moveButtons(card({ status: 'inbox' }), true).map((item) => item.to),
    ['ready', 'waiting_user', 'done', 'failed'],
  );
  assert.deepEqual(
    moveButtons(card({ status: 'waiting_user' })).map((item) => item.to),
    ['ready', 'done', 'failed'],
  );
  assert.deepEqual(
    moveButtons(card({ status: 'waiting_user', started: true, assignee: 'coder' })).map((item) => item.to),
    ['failed'],
  );
  assert.deepEqual(
    moveButtons(card({ status: 'to_verify', assignee: 'coder' })).map((item) => item.to),
    ['done', 'failed'],
  );
  assert.deepEqual(
    moveButtons(card({ status: 'failed' })).map((item) => item.to),
    ['ready'],
  );
  assert.deepEqual(moveButtons(card({ status: 'running' })), []);
  assert.deepEqual(moveButtons(card({ status: 'done' })), []);
  assert.deepEqual(moveButtons(card({ kind: 'commitment', status: 'open' })), []);
});

test('who does a card is locked once started, done or at work', () => {
  assert.equal(assigneeLocked(card({ status: 'inbox' })), false);
  assert.equal(assigneeLocked(card({ status: 'waiting_user' })), false);
  assert.equal(assigneeLocked(card({ status: 'waiting_user', started: true })), true);
  assert.equal(assigneeLocked(card({ status: 'done' })), true);
  assert.equal(assigneeLocked(card({ status: 'running' })), true);
});

test('filters: project, kind, who does it, due day, label', () => {
  const today = '2026-10-10'; // a Saturday
  const work = card({ project: 'box', assignee: 'coder', due: '2026-10-11', label: 'L1' });
  const general = card({ due: today });
  const late = card({ due: '2026-10-01', late: true });
  const commitment = card({ kind: 'commitment', status: 'open', due: '2026-10-12', time: '09:00' });
  assert.equal(matches(work, ALL_FILTERS, today), true);
  assert.equal(matches(work, { ...ALL_FILTERS, project: 'p:box' }, today), true);
  assert.equal(matches(general, { ...ALL_FILTERS, project: 'p:box' }, today), false);
  assert.equal(matches(general, { ...ALL_FILTERS, project: 'general' }, today), true);
  assert.equal(matches(work, { ...ALL_FILTERS, project: 'general' }, today), false);
  assert.equal(matches(commitment, { ...ALL_FILTERS, kind: 'commitment' }, today), true);
  assert.equal(matches(work, { ...ALL_FILTERS, kind: 'commitment' }, today), false);
  assert.equal(matches(work, { ...ALL_FILTERS, assignee: 'a:coder' }, today), true);
  assert.equal(matches(work, { ...ALL_FILTERS, assignee: 'user' }, today), false);
  assert.equal(matches(general, { ...ALL_FILTERS, assignee: 'user' }, today), true);
  assert.equal(matches(general, { ...ALL_FILTERS, due: 'today' }, today), true);
  assert.equal(matches(work, { ...ALL_FILTERS, due: 'today' }, today), false);
  assert.equal(matches(work, { ...ALL_FILTERS, due: 'week' }, today), true);
  assert.equal(matches(commitment, { ...ALL_FILTERS, due: 'week' }, today), false);
  assert.equal(matches(late, { ...ALL_FILTERS, due: 'late' }, today), true);
  assert.equal(matches(general, { ...ALL_FILTERS, due: 'late' }, today), false);
  assert.equal(matches(card({}), { ...ALL_FILTERS, due: 'none' }, today), true);
  assert.equal(matches(general, { ...ALL_FILTERS, due: 'none' }, today), false);
  assert.equal(matches(work, { ...ALL_FILTERS, label: 'L1' }, today), true);
  assert.equal(matches(general, { ...ALL_FILTERS, label: 'L1' }, today), false);
  assert.deepEqual(weekOf('2026-10-10'), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(weekOf('2026-10-05'), { from: '2026-10-05', to: '2026-10-11' });
  assert.equal(matches(card({ priority: 3 }), { ...ALL_FILTERS, priority: '3' }, today), true);
  assert.equal(matches(card({ priority: 2 }), { ...ALL_FILTERS, priority: '3' }, today), false);
  assert.equal(matches(card({}), { ...ALL_FILTERS, priority: '0' }, today), true);
  assert.equal(matches(card({ priority: 1 }), { ...ALL_FILTERS, priority: '0' }, today), false);
  assert.equal(filtersActive(ALL_FILTERS), false);
  assert.equal(filtersActive({ ...ALL_FILTERS, priority: '4' }), true);
  assert.equal(filtersActive({ ...ALL_FILTERS, due: 'late' }), true);
});

test('the choices stay in this browser; anything unexpected reads as the default', () => {
  const storage = memory();
  assert.deepEqual(loadState(storage), defaultState());
  assert.deepEqual(loadState(undefined), defaultState());
  const state = defaultState();
  state.prefs = { splitInbox: true, splitFailed: false, hidden: ['done'] };
  state.filters = { ...ALL_FILTERS, project: 'p:box', due: 'week', priority: '4' };
  state.view = 'list';
  state.sort = { key: 'priority', desc: true };
  saveState(storage, state);
  assert.deepEqual(loadState(storage), state);
  storage.setItem(
    'arianna.cardwall',
    JSON.stringify({ prefs: { splitInbox: 'yes', hidden: ['nope', 'running'] }, filters: { project: 'box', kind: 'x', due: 'soon', label: 'L9', priority: 7 }, view: 'grid', sort: { key: 'size' } }),
  );
  assert.deepEqual(loadState(storage), { ...defaultState(), prefs: { splitInbox: false, splitFailed: false, hidden: ['running'] } });
  storage.setItem('arianna.cardwall', '{');
  assert.deepEqual(loadState(storage), defaultState());
  const broken = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: (): void => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(loadState(broken), defaultState());
  assert.doesNotThrow(() => {
    saveState(broken, state);
  });
});

test('what a card says: blocked, due day, the cards it may wait for', () => {
  assert.equal(blockedText(card({ column: 'waiting', blockedBy: [{ id: 'b', title: 'Preventivo', status: 'ready' }] })), 'aspetta: Preventivo');
  assert.equal(
    blockedText(
      card({
        column: 'waiting',
        blockedBy: [
          { id: 'b', title: 'Preventivo', status: 'ready' },
          { id: 'c', title: 'Firma', status: 'inbox' },
        ],
      }),
    ),
    'aspetta: Preventivo +1',
  );
  assert.equal(blockedText(card({ column: 'waiting' })), undefined);
  assert.equal(dueText(card({ due: '2026-10-10' }), '2026-10-10'), 'Oggi');
  assert.equal(dueText(card({ due: '2026-10-11', time: '09:30' }), '2026-10-10'), 'Domani, 09:30');
  assert.equal(dueText(card({}), '2026-10-10'), undefined);
  const me = card({ id: 'me', dependsOn: [{ id: 'dep', title: 'Già', status: 'ready' }] });
  const cards = [me, card({ id: 'dep' }), card({ id: 'free' }), card({ id: 'closed', status: 'done', column: 'done' }), card({ id: 'commitment', kind: 'commitment', status: 'open' })];
  assert.deepEqual(
    dependencyChoices(me, cards).map((item) => item.id),
    ['free'],
  );
});

test('the refusals of the core in Italian', () => {
  assert.equal(cardErrorText(new ApiError(409, 'the card is at work')), 'La card è al lavoro: aspetta che finisca.');
  assert.equal(cardErrorText(new ApiError(409, 'a card cannot move from to_verify to waiting_user by hand')), 'Questo spostamento non si fa a mano.');
  assert.equal(cardErrorText(new ApiError(409, 'a card waits for 12 cards at most')), 'Una card aspetta al massimo 12 card.');
  assert.equal(cardErrorText(new ApiError(409, 'the engine stopped this card: it cannot go back to do by hand yet')), ENGINE_STOPPED_TEXT);
  assert.equal(cardErrorText(new ApiError(409, 'a card already started or done keeps who does it')), 'Una card già partita o fatta non cambia chi la fa.');
  assert.equal(cardErrorText(new ApiError(409, 'only a card still to do waits for another one')), 'Solo una card ancora da fare può aspettarne un’altra.');
  assert.equal(cardErrorText(new ApiError(409, 'a card holds 30 links at most')), 'Una card tiene al massimo 30 link.');
  assert.equal(cardErrorText(new ApiError(409, 'a card holds 50 items at most')), 'Una card tiene al massimo 50 voci.');
  assert.equal(cardErrorText(new ApiError(409, 'a card holds 20 files at most')), 'Una card tiene al massimo 20 allegati.');
  assert.equal(cardErrorText(new ApiError(400, 'url is not a web address')), 'Il link deve essere un indirizzo web (http o https).');
  assert.equal(cardErrorText(new ApiError(400, 'a file is 20 MB at most')), 'Un allegato può essere al massimo di 20 MB.');
  assert.equal(cardErrorText(new ApiError(404, 'no such link')), 'Questo link non c’è più.');
  assert.equal(cardErrorText(new ApiError(404, 'no such item')), 'Questa voce non c’è più.');
  assert.equal(cardErrorText(new ApiError(404, 'no such file')), 'Questo allegato non c’è più.');
  assert.equal(cardErrorText(new ApiError(404, 'the file is missing')), 'Il file di questo allegato manca dal disco.');
  assert.equal(cardErrorText(new ApiError(400, 'priority must be 0-4')), 'La priorità non è valida.');
  assert.equal(cardErrorText(new ApiError(400, 'planned must be YYYY-MM-DD')), 'La data di esecuzione non è valida.');
  assert.equal(cardErrorText(new ApiError(400, 'goal is longer than 10000 characters')), 'La descrizione supera i 10000 caratteri.');
  assert.equal(cardErrorText(new ApiError(400, 'criteria is longer than 2000 characters')), '«Fatto quando» supera i 2000 caratteri.');
  assert.equal(cardErrorText(new ApiError(409, 'something new')), 'Questo spostamento non è permesso.');
  assert.equal(cardErrorText(new ApiError(404, 'no such card')), 'La card non c’è più.');
});

test('what a card shows: priority, state, planned day, marks, order', () => {
  assert.equal(priorityText(0), undefined);
  assert.equal(priorityText(1), 'Bassa');
  assert.equal(priorityText(4), 'Altissima');
  assert.equal(stateText(card({ column: 'waiting', status: 'waiting_user' })), 'Aspetta');
  assert.equal(stateText(card({ column: 'failed', status: 'failed' })), 'Falliti');
  assert.equal(stateText(card({ kind: 'commitment', status: 'open' })), 'Da fare');
  assert.equal(stateText(card({ kind: 'commitment', status: 'postponed', column: 'done' })), 'Rinviato');
  assert.equal(plannedText(card({ planned: '2026-10-11' }), '2026-10-10'), 'Domani');
  assert.equal(plannedText(card({}), '2026-10-10'), undefined);
  assert.deepEqual(cardMarks(card({})), []);
  assert.deepEqual(
    cardMarks(card({ hasBody: true, checklist: { done: 2, total: 5 }, links: 1, files: 3 })).map((mark) => [mark.icon, mark.text]),
    [
      ['card-body', ''],
      ['checklist', '2/5'],
      ['link', '1'],
      ['attach', '3'],
    ],
  );
  const cards = [card({ id: 'low', priority: 1, planned: '2026-10-20' }), card({ id: 'none' }), card({ id: 'top', priority: 4, planned: '2026-10-12', files: 2 })];
  assert.deepEqual(
    sortCards(cards, { key: 'priority', desc: true }).map((item) => item.id),
    ['top', 'low', 'none'],
  );
  assert.deepEqual(
    sortCards(cards, { key: 'priority', desc: false }).map((item) => item.id),
    ['low', 'top', 'none'],
  );
  assert.deepEqual(
    sortCards(cards, { key: 'planned', desc: false }).map((item) => item.id),
    ['top', 'low', 'none'],
  );
  assert.deepEqual(
    sortCards(cards, { key: 'files', desc: true }).map((item) => item.id)[0],
    'top',
  );
  const columns = wallColumns({ splitInbox: false, splitFailed: false });
  assert.deepEqual(
    groupCards(cards, columns, { key: 'priority', desc: true }).get('todo')?.map((item) => item.id),
    ['top', 'low', 'none'],
  );
});

test('files, links and checklist', () => {
  assert.equal(fileRefusal({ name: 'a.pdf', size: MAX_FILE_BYTES }), undefined);
  assert.equal(fileRefusal({ name: 'big.mov', size: MAX_FILE_BYTES + 1 }), '«big.mov» supera i 20 MB: non lo allego.');
  assert.equal(fileSizeText(840), '840 B');
  assert.equal(fileSizeText(2_100), '2,1 kB');
  assert.equal(fileKindText({ name: 'preventivo.pdf', mediaType: 'application/pdf' }), 'PDF');
  assert.equal(fileKindText({ name: 'senza-nome', mediaType: 'image/png' }), 'PNG');
  assert.equal(fileKindText({ name: 'x', mediaType: 'application/octet-stream' }), 'File');
  assert.equal(dataUrlBase64('data:text/plain;base64,aGVsbG8='), 'aGVsbG8=');
  assert.equal(dataUrlBase64('nope'), '');
  assert.equal(isWebAddress('https://example.org/a'), true);
  assert.equal(isWebAddress('javascript:alert(1)'), false);
  assert.equal(isWebAddress('example.org'), false);
  assert.equal(progressPercent([]), 0);
  assert.equal(progressPercent([{ done: true }, { done: false }, { done: false }, { done: true }]), 50);
});

test('the history in Italian, written by the code', () => {
  assert.equal(historyText({ kind: 'task.created', payload: { status: 'inbox' } }), 'Creata');
  assert.equal(historyText({ kind: 'card.changed', payload: { created: true } }), undefined);
  assert.equal(historyText({ kind: 'task.status', payload: { from: 'inbox', to: 'waiting_user', cause: 'user' } }), 'Da «Da fare» a «Aspetta», da te');
  assert.equal(historyText({ kind: 'task.status', payload: { from: 'running', to: 'to_verify', cause: 'engine' } }), 'Da «In corso» a «Da verificare», dal motore');
  assert.equal(historyText({ kind: 'task.status', payload: { from: 'waiting_user', to: 'ready', cause: 'approval' } }), 'Da «Aspetta» a «Da fare», con una decisione');
  assert.equal(historyText({ kind: 'task.status', payload: { from: 'ready', to: 'failed', cause: 'purge' } }), 'Da «Da fare» a «Falliti»');
  assert.equal(historyText({ kind: 'task.blocked', payload: {} }), 'In attesa delle card da cui dipende');
  assert.equal(historyText({ kind: 'task.unblocked', payload: {} }), 'Ripartita');
  assert.equal(historyText({ kind: 'card.changed', payload: { fields: ['goal'] } }), 'Modificato: descrizione');
  assert.equal(historyText({ kind: 'card.changed', payload: { fields: ['title', 'priority', 'planned'] } }), 'Modificati: titolo, priorità e data di esecuzione');
  assert.equal(historyText({ kind: 'card.changed', payload: { link: 'added' } }), 'Link aggiunto');
  assert.equal(historyText({ kind: 'card.changed', payload: { item: 'ticked' } }), 'Voce della checklist spuntata');
  assert.equal(historyText({ kind: 'card.changed', payload: { file: 'removed' } }), 'Allegato tolto');
  assert.equal(historyText({ kind: 'card.changed', payload: { dependsOn: 'x' } }), 'Aspetta un’altra card');
  assert.equal(historyText({ kind: 'other', payload: {} }), undefined);
  const lines = historyLines(
    [
      { at: '2026-10-10T09:55:00.000Z', kind: 'card.changed', payload: { created: true } },
      { at: '2026-10-10T09:55:00.000Z', kind: 'task.created', payload: {} },
    ],
    new Date('2026-10-10T10:00:00.000Z'),
  );
  assert.deepEqual(lines, [{ at: '2026-10-10T09:55:00.000Z', text: 'Creata', when: '5 min fa' }]);
});
