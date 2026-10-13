// The section "IM" of the cardwall (D-167, I-11 tappa P4a): pure helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { defaultState, loadState } from '../src/lib/cardwall.ts';
import {
  answeredText,
  callText,
  closingAskText,
  closingHint,
  closingsByMessage,
  closingTitle,
  type ImClosing,
  IM_OUTCOME_TEXT,
  IM_OUTCOMES,
  itemRef,
  openClosings,
  openItems,
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
  isReportConflict,
  REPORT_AGENT_TEXT,
  REPORT_REPLACE_TEXT,
  reportDoneText,
  reportErrorText,
  REPORT_LANGUAGE_TEXT,
  loadReportLanguage,
  reportRunningText,
  saveReportLanguage,
  reportStartErrorText,
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
    report: '',
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

// I-11 tappa P4b: the card of an item and the closing in the secretary conversation.

const closing = (id: string, over: Partial<ImClosing> = {}): ImClosing => ({
  id,
  project: 'progetto-test',
  im: 33,
  messageId: `m${id}`,
  openedAt: '2026-10-15T08:00:00.000Z',
  closedAt: null,
  ...over,
});

test('the three answers of a closing, in order, with their Italian words', () => {
  assert.deepEqual(IM_OUTCOMES, ['done', 'part', 'not-done']);
  assert.deepEqual(IM_OUTCOMES.map((outcome) => IM_OUTCOME_TEXT[outcome]), ['Fatta', 'In parte', 'Non fatta']);
});

test('itemRef keeps only the address of an item', () => {
  const linked: ImItem = { ...item(4, 'todo', 'Login'), part: 2, card: 'abcd1234' };
  assert.deepEqual(itemRef(linked), { line: 4, title: 'Login', part: 2 });
});

test('openItems: only Da fare and In corso, in the order of the file', () => {
  const items = [item(1, 'done', 'a'), item(2, 'doing', 'b'), item(3, 'postponed', 'c'), item(4, 'todo', 'd'), item(5, 'cancelled', 'e')];
  assert.deepEqual(openItems(items).map((entry) => entry.title), ['b', 'd']);
  assert.deepEqual(openItems([item(1, 'done', 'a')]), []);
});

test('answeredText: how an item ended, nothing for an open one', () => {
  assert.equal(answeredText({ state: 'done' }), 'Fatta');
  assert.equal(answeredText({ state: 'postponed' }), 'Passa all’IM successivo');
  assert.equal(answeredText({ state: 'cancelled' }), 'Annullata');
  assert.equal(answeredText({ state: 'todo' }), undefined);
  assert.equal(answeredText({ state: 'doing' }), undefined);
});

test('closingHint names the next part', () => {
  assert.match(closingHint({ part: null }), /«Parte 2»/);
  assert.match(closingHint({ part: 3 }), /«Parte 4»/);
  assert.match(closingHint({ part: null }), /Non fatta: passa all’IM successivo/);
});

test('closingTitle and closingAskText', () => {
  assert.equal(closingTitle(closing('1')), 'IM-33 · progetto-test');
  assert.equal(closingAskText(closing('1')), 'Chiudere l’IM-33 di progetto-test');
});

test('openClosings keeps those not closed yet', () => {
  assert.deepEqual(openClosings([closing('1'), closing('2', { closedAt: '2026-10-15T09:00:00.000Z' })]).map((entry) => entry.id), ['1']);
});

test('closingsByMessage: by message, without those that have none, the most recent first', () => {
  const byMessage = closingsByMessage([closing('3', { messageId: 'x' }), closing('2', { messageId: null }), closing('1', { messageId: 'x' }), closing('4')]);
  assert.equal(byMessage.size, 2);
  assert.equal(byMessage.get('x')?.id, '3');
  assert.equal(byMessage.get('m4')?.id, '4');
  assert.equal(byMessage.get('m2'), undefined);
});

// "Scrivi il report" (D-167, P4c).
test('the two agents of the report, as the user reads them', () => {
  assert.deepEqual(REPORT_AGENT_TEXT, { arianna: 'Arianna (sul Mac)', claude: 'Claude (nel cloud, consuma quota)' });
});

test('isReportConflict: only a 409 with has-report asks to replace', () => {
  assert.equal(isReportConflict(new ApiError(409, 'the IM has a report already', { code: 'has-report' })), true);
  assert.equal(isReportConflict(new ApiError(409, 'busy', { code: 'busy' })), false);
  assert.equal(isReportConflict(new ApiError(403, 'x', { code: 'has-report' })), false);
  assert.equal(isReportConflict(new Error('x')), false);
});

test('reportErrorText names why in Italian, from code and detail only', () => {
  assert.equal(reportErrorText({ code: 'has-report', detail: null }, 'claude'), REPORT_REPLACE_TEXT);
  const diary = reportErrorText({ code: 'above-label', detail: 'diary:2026-10-13:L2' }, 'claude');
  assert.match(diary, /^Il diario dei lavori del 13 ottobre è Privato \(L2\): Claude non può leggerlo/);
  assert.match(diary, /Arianna \(sul Mac\)/);
  assert.match(reportErrorText({ code: 'above-label', detail: 'im:L2' }, 'claude'), /^L’IM è Privato \(L2\): Claude/);
  assert.match(reportErrorText({ code: 'above-label', detail: 'im:L3' }, 'arianna'), /^L’IM è Segreto \(L3\): nemmeno il modello locale/);
  assert.match(reportErrorText({ code: 'quota', detail: null }, 'claude', '2026-10-15T08:30:00.000Z'), /^Claude ha finito la quota fino alle \d{2}:\d{2}/);
  assert.match(reportErrorText({ code: 'unavailable', detail: 'claude' }, 'claude'), /^Claude non è disponibile/);
  assert.match(reportErrorText({ code: 'unavailable', detail: 'unavailable' }, 'arianna'), /^Il modello locale non risponde/);
  assert.match(reportErrorText({ code: 'changed', detail: null }, 'arianna'), /non ho sovrascritto niente/);
  assert.match(reportErrorText({ code: 'something-new', detail: null }, 'arianna'), /^Il modello non è riuscito/);
});

test('reportStartErrorText reads the code in the body; without one, the usual words', () => {
  assert.match(reportStartErrorText(new ApiError(403, 'x', { code: 'above-label', detail: 'diary:2026-10-13:L2' }), 'claude'), /13 ottobre/);
  assert.equal(reportStartErrorText(new ApiError(404, 'not found'), 'claude'), 'Questo IM non c’è più: ricarica la pagina.');
});

test('reportDoneText: only for a finished job, with the language and the diary days left out', () => {
  assert.equal(reportDoneText({ state: 'running', agent: 'claude', left: 0, language: 'it' }), undefined);
  assert.equal(reportDoneText({ state: 'done', agent: 'claude', left: 0, language: 'it' }), 'Claude ha scritto il report: rileggilo prima di mandarlo al cliente.');
  assert.equal(reportDoneText({ state: 'done', agent: 'claude', left: 0, language: 'en' }), 'Claude ha scritto il report in inglese: rileggilo prima di mandarlo al cliente.');
  assert.match(reportDoneText({ state: 'done', agent: 'arianna', left: 2, language: 'it' }) ?? '', /^Arianna ha scritto il report.* 2 giorni del diario non sono entrati \(sopra l’etichetta dell’IM o illeggibili\)\.$/);
});

test('the language of the report: words, the running line, the last choice per project in this browser', () => {
  assert.deepEqual(REPORT_LANGUAGE_TEXT, { it: 'Italiano', en: 'English' });
  assert.equal(reportRunningText('it'), 'Scrivo il report…');
  assert.equal(reportRunningText('en'), 'Scrivo il report in inglese…');
  const storage = memory();
  assert.equal(loadReportLanguage(storage, 'progetto-test'), 'it');
  saveReportLanguage(storage, 'progetto-test', 'en');
  saveReportLanguage(storage, 'altro', 'it');
  assert.equal(loadReportLanguage(storage, 'progetto-test'), 'en');
  assert.equal(loadReportLanguage(storage, 'altro'), 'it');
  assert.equal(loadReportLanguage(storage, null), 'it');
  storage.setItem('arianna.cardwall.im.report-language', '{rotto');
  assert.equal(loadReportLanguage(storage, 'progetto-test'), 'it');
  saveReportLanguage(storage, 'progetto-test', 'en');
  assert.equal(loadReportLanguage(storage, 'progetto-test'), 'en', 'a broken value is written again');
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadReportLanguage(throwing, 'progetto-test'), 'it');
  saveReportLanguage(throwing, 'progetto-test', 'en');
});
