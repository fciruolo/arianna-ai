// The page "Progetti" revised (D-191): pure helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImBillingRow, ImInvoice, ImOverview } from '../src/lib/im-billing.ts';
import {
  changesText,
  fallbackCents,
  codeParts,
  folderCounts,
  imFilterCounts,
  imFilterMatch,
  imListText,
  isPartTab,
  nextIm,
  noteDateText,
  noteDayText,
  noteGroups,
  noteHeading,
  noteMeta,
  notesCountText,
  overdueInvoices,
  overdueText,
  paidInYear,
  partPressed,
  priceChanges,
  priceChangeText,
  priceEditable,
  raisedLabel,
  PROJECT_TABS,
  ruleChanges,
  ruleRows,
  settingsChanges,
  settingsOf,
  settingsProblem,
  settingsSummary,
  settingsWrites,
  shortDay,
  statusTone,
  todoText,
  type ImSettings,
} from '../src/lib/projects-page.ts';
import type { KnowledgeFolder, KnowledgeNote } from '../src/lib/projects.ts';

const row = (number: number, change: Partial<ImBillingRow> = {}): ImBillingRow => ({
  number,
  date: `2026-10-${String(number).padStart(2, '0')} 10:00`,
  call: null,
  status: 'chiuso',
  label: 'L1',
  path: `IM/IM-${String(number)}.md`,
  counts: { todo: 0, doing: 0, done: 1, postponed: 0, cancelled: 0 },
  amountCents: 45000,
  currency: 'EUR',
  overrideCents: null,
  notBilled: false,
  closedCents: 45000,
  invoice: null,
  state: 'to-invoice',
  ...change,
});

const invoice = (change: Partial<ImInvoice> = {}): ImInvoice => ({
  id: 'a',
  number: 'T-1/2026',
  issuedOn: '2026-09-12',
  paidOn: null,
  currency: 'EUR',
  note: null,
  ims: [29],
  totalCents: 45000,
  documentCents: 54900,
  dueOn: null,
  due: '2026-10-09',
  createdAt: '2026-09-12T10:00:00Z',
  ...change,
});

test('the tabs in one row; the part tabs are File, Git and Servizi; a part is pressed only there', () => {
  assert.deepEqual(
    PROJECT_TABS.map((item) => item.text),
    ['File', 'Git', 'Servizi', 'Conoscenza', 'IM', 'Regole'],
  );
  assert.equal(isPartTab('file'), true);
  assert.equal(isPartTab('svc'), true);
  assert.equal(isPartTab('im'), false);
  assert.equal(isPartTab('know'), false);
  assert.equal(partPressed('git', 'admin', 'admin'), true);
  // The defect of before: the part stayed lit in IM and Regole.
  assert.equal(partPressed('im', 'admin', 'admin'), false);
  assert.equal(partPressed('rules', 'admin', 'admin'), false);
  assert.equal(partPressed('file', 'client', 'admin'), false);
});

test('the next IM is the earliest not closed, an undated one last', () => {
  assert.equal(nextIm([row(1), row(2)]), null);
  const rows = [row(30, { status: 'previsto', date: null }), row(28, { status: 'in corso', date: '2026-10-08 10:00' }), row(29, { status: 'previsto', date: '2026-10-15 10:00' })];
  assert.equal(nextIm(rows)?.number, 28);
  assert.equal(nextIm([row(30, { status: 'previsto', date: null })])?.number, 30);
});

test('invoices past due: not paid and due before today', () => {
  const list = [invoice({ id: 'late' }), invoice({ id: 'paid', paidOn: '2026-10-01' }), invoice({ id: 'later', due: '2026-11-01' }), invoice({ id: 'none', due: null })];
  assert.deepEqual(
    overdueInvoices(list, '2026-10-12').map((item) => item.id),
    ['late'],
  );
  assert.deepEqual(overdueInvoices(list, '2026-10-09'), []);
});

test('the money paid in a year, by currency, at the total of the document', () => {
  const list = [
    invoice({ paidOn: '2026-09-30' }),
    invoice({ paidOn: '2026-10-02', documentCents: null, totalCents: 30000 }),
    invoice({ paidOn: '2025-12-30' }),
    invoice({ paidOn: '2026-05-01', currency: 'USD', documentCents: 1000 }),
    invoice(),
  ];
  assert.deepEqual(paidInYear(list, 2026), [
    { currency: 'EUR', cents: 84900 },
    { currency: 'USD', cents: 1000 },
  ]);
  assert.deepEqual(paidInYear(list, 2024), []);
});

test('the words of the numbers at the top', () => {
  assert.equal(imListText([]), '');
  assert.equal(imListText([33]), 'IM-33');
  assert.equal(imListText([33, 32]), 'IM-33 e IM-32');
  assert.equal(imListText([33, 32, 31]), 'IM-33, IM-32 e IM-31');
  assert.equal(imListText([1, 2, 3, 4, 5]), '5 IM');
  assert.equal(shortDay('2026-10-09'), '09/10');
  assert.equal(todoText({ todo: 3, doing: 1 }), '4 voci da fare');
  assert.equal(todoText({ todo: 1, doing: 0 }), '1 voce da fare');
  assert.equal(todoText({ todo: 0, doing: 0 }), 'nessuna voce da fare');
  assert.equal(overdueText(1), '1 fattura scaduta');
  assert.equal(overdueText(2), '2 fatture scadute');
});

const overview = (change: Partial<Pick<ImOverview, 'calendar' | 'price'>> = {}): Pick<ImOverview, 'calendar' | 'price'> => ({
  calendar: { calendar: { weekday: 4, time: '10:00', every: 1 }, issue: null, end: null, exists: true, path: 'IM/calendario.md', version: 'v1' },
  price: { amountCents: 45000, currency: 'EUR' },
  ...change,
});

test('the form of calendar and price, from the core', () => {
  assert.deepEqual(settingsOf(overview()), { calendar: { weekday: 4, time: '10:00', every: 1 }, end: '', price: '450', currency: 'EUR' });
  const empty = settingsOf(overview({ calendar: { calendar: null, issue: null, end: null, exists: false, path: 'IM/calendario.md', version: '' }, price: null }));
  assert.deepEqual(empty, { calendar: null, end: '', price: '', currency: 'EUR' });
});

test('the writes of a save: the file first, then the price; nothing when nothing changed', () => {
  const before = settingsOf(overview());
  assert.deepEqual(settingsWrites(before, { ...before }), { calendar: false, end: false, price: false });
  assert.deepEqual(settingsWrites(before, { ...before, calendar: { weekday: 4, time: '11:00', every: 1 }, price: '500' }), { calendar: true, end: false, price: true });
  assert.deepEqual(settingsWrites(before, { ...before, end: '2026-12-31' }), { calendar: false, end: true, price: false });
  // "450,00" is the same price as "450".
  assert.deepEqual(settingsWrites(before, { ...before, price: '450,00' }), { calendar: false, end: false, price: false });
  assert.deepEqual(settingsWrites(before, { ...before, currency: 'USD' }), { calendar: false, end: false, price: true });
  // Without a price, another currency writes nothing.
  assert.deepEqual(settingsWrites({ ...before, price: '' }, { ...before, price: '', currency: 'USD' }), { calendar: false, end: false, price: false });
  // A calendar created where there was none.
  assert.deepEqual(settingsWrites({ ...before, calendar: null }, before), { calendar: true, end: false, price: false });
  assert.deepEqual(settingsWrites(before, { ...before, calendar: null }), { calendar: false, end: false, price: false });
});

test('what changed, in words, for the save bar', () => {
  const before: ImSettings = settingsOf(overview());
  const after: ImSettings = { ...before, calendar: { weekday: 5, time: '11:00', every: 2 }, end: '2026-12-31', price: '500' };
  assert.deepEqual(settingsChanges(before, after), ['giorno giovedì → venerdì', 'ora 10:00 → 11:00', 'ogni 1 → 2 settimane', 'fine degli IM nessuna → 31/12/2026', 'prezzo 450,00 € → 500,00 €']);
  assert.deepEqual(settingsChanges(before, { ...before, currency: 'CHF' }), ['valuta EUR → CHF']);
  assert.deepEqual(settingsChanges({ ...before, calendar: null }, before), ['calendario nuovo: ogni giovedì alle 10:00']);
  assert.deepEqual(settingsChanges(before, { ...before, price: '' }), ['prezzo 450,00 € → nessuno']);
  assert.deepEqual(settingsChanges(before, before), []);
  assert.equal(changesText([]), '');
  assert.equal(changesText(['ora 10:00 → 11:00']), '1 modifica: ora 10:00 → 11:00.');
  assert.equal(changesText(['a', 'b']), '2 modifiche: a, b.');
  assert.equal(changesText(['a', 'b'], ['prezzo cambiato', 'prezzi cambiati']), '2 prezzi cambiati: a, b.');
});

test('a save waits for a valid hour and a valid price', () => {
  const good = settingsOf(overview());
  assert.equal(settingsProblem(good), null);
  assert.match(settingsProblem({ ...good, calendar: { weekday: 4, time: '25:00', every: 1 } }) ?? '', /10:00/);
  assert.match(settingsProblem({ ...good, calendar: { weekday: 4, time: '10:00', every: 0 } }) ?? '', /settimane/);
  assert.match(settingsProblem({ ...good, price: '4x' }) ?? '', /450/);
  assert.equal(settingsProblem({ ...good, price: '' }), null);
});

test('the summary under "Calendario e prezzo"', () => {
  assert.equal(settingsSummary(overview()), 'IM ogni giovedì alle 10:00, senza data di fine · 450,00 € a IM, IVA esclusa');
  assert.equal(settingsSummary(overview({ calendar: { ...overview().calendar, end: '2026-12-31' }, price: null })), 'IM ogni giovedì alle 10:00, fino al 31/12/2026 · nessun prezzo per IM');
  assert.equal(settingsSummary(overview({ calendar: { ...overview().calendar, calendar: null } })), 'Nessun calendario: ogni IM arriva sette giorni dopo l’ultimo · 450,00 € a IM, IVA esclusa');
});

test('the price of one IM changes only out of invoices and when billed', () => {
  assert.equal(priceEditable(row(1)), true);
  assert.equal(priceEditable(row(1, { invoice: { id: 'a', number: 'T-1' } })), false);
  assert.equal(priceEditable(row(1, { notBilled: true })), false);
});

test('the cells changed: an amount, the price of the project, no change, a mistake', () => {
  const rows = [row(33), row(32, { overrideCents: 30000, amountCents: 30000 }), row(31), row(30)];
  const edits = new Map([
    [33, '500'],
    [32, ''],
    [31, '450,00'],
    [30, 'tanti'],
  ]);
  assert.deepEqual(priceChanges(rows, edits), [
    { number: 33, from: 45000, to: 50000, invalid: false },
    { number: 32, from: 30000, to: null, invalid: false },
    { number: 30, from: 45000, to: null, invalid: true },
  ]);
  // The own price typed again is no change; an empty cell without an own price neither.
  assert.deepEqual(priceChanges(rows, new Map([[32, '300']])), []);
  assert.deepEqual(priceChanges(rows, new Map([[33, '']])), []);
  // An IM gone into an invoice or out of billing keeps no change typed before.
  assert.deepEqual(priceChanges([row(33, { invoice: { id: 'a', number: 'T-3' } }), row(32, { notBilled: true })], new Map([[33, '500'], [32, '500']])), []);
  assert.equal(priceChangeText({ number: 33, from: 45000, to: 50000, invalid: false }, 'EUR'), 'IM-33 450,00 € → 500,00 €');
  assert.equal(priceChangeText({ number: 32, from: 30000, to: null, invalid: false }, 'EUR'), 'IM-32 300,00 € → prezzo del progetto');
  assert.equal(priceChangeText({ number: 32, from: 30000, to: null, invalid: false }, 'EUR', 45000), 'IM-32 300,00 € → 450,00 €');
  assert.equal(priceChangeText({ number: 30, from: null, to: null, invalid: true }, 'EUR'), 'IM-30 non è un importo');
  assert.equal(fallbackCents(row(1, { closedCents: 40000 }), 45000), 40000);
  assert.equal(fallbackCents(row(1, { closedCents: null }), 45000), null);
  assert.equal(fallbackCents(row(1, { closedCents: null, status: 'previsto' }), 45000), 45000);
});

test('the filters of the IM table', () => {
  const rows = [row(1), row(2, { state: 'invoiced' }), row(3, { state: 'paid' }), row(4, { state: 'open' })];
  assert.deepEqual(imFilterCounts(rows), { all: 4, 'to-invoice': 1, invoiced: 1, paid: 1 });
  assert.equal(imFilterMatch(row(1, { state: 'open' }), 'all'), true);
  assert.equal(imFilterMatch(row(1, { state: 'open' }), 'paid'), false);
  assert.equal(imFilterMatch(row(1, { state: 'paid' }), 'paid'), true);
});

test('the rules as a list, headings between them and code apart', () => {
  const text = '# Stile\n- Usa pnpm, mai npm.\n- [solo Codex] Non toccare `public/`.\n  sotto\n```\n# non un titolo\n```\n## Lavoro\nPrima di finire esegui `pnpm test`.';
  const rows = ruleRows(text);
  assert.deepEqual(
    rows.map((item) => (item.kind === 'head' ? `# ${item.text}` : `${item.item.audience}: ${item.item.text}`)),
    ['# Stile', 'both: Usa pnpm, mai npm.', 'codex: Non toccare `public/`.', '# Lavoro', 'both: Prima di finire esegui `pnpm test`.'],
  );
  assert.deepEqual(ruleRows(''), []);
  assert.deepEqual(codeParts('Esegui `pnpm test` prima'), [
    { text: 'Esegui ', code: false },
    { text: 'pnpm test', code: true },
    { text: ' prima', code: false },
  ]);
  assert.deepEqual(codeParts('niente codice'), [{ text: 'niente codice', code: false }]);
});

test('what a save of the rules changes, in words', () => {
  const text = '- Usa pnpm.\n- Non toccare public/.';
  assert.deepEqual(ruleChanges({ own: false, text: '' }, { own: true, text }), ['il progetto passa a regole proprie']);
  assert.deepEqual(ruleChanges({ own: true, text }, { own: false, text: '' }), ['il progetto torna al modello comune']);
  assert.deepEqual(ruleChanges({ own: true, text }, { own: true, text }), []);
  assert.deepEqual(ruleChanges({ own: true, text }, { own: true, text: '- Usa pnpm.\n- [solo Codex] Non toccare public/.' }), ['«Non toccare public/.» ora solo per Codex']);
  assert.deepEqual(ruleChanges({ own: true, text: '- [solo Claude Code] Usa pnpm.' }, { own: true, text: '- Usa pnpm.' }), ['«Usa pnpm.» ora per entrambi']);
  assert.deepEqual(ruleChanges({ own: true, text }, { own: true, text: `${text}\n- Una nuova.` }), ['testo delle regole cambiato']);
  assert.deepEqual(ruleChanges({ own: true, text }, { own: true, text: '- Usa yarn.\n- Non toccare public/.' }), ['testo delle regole cambiato']);
});

const folder = (path: string, label: KnowledgeFolder['label'] = 'L1'): KnowledgeFolder => ({ path, label, defaultLabel: label, chosen: false });
const note = (folderPath: string, title: string, extra: Partial<KnowledgeNote> = {}): KnowledgeNote => ({
  folder: folderPath,
  path: `${folderPath}/${title}.md`,
  title,
  label: 'L1',
  date: null,
  status: null,
  excerpt: null,
  ...extra,
});

test('the notes of a folder the most recent first, a search also on the first line, one folder only when chosen (D-193)', () => {
  const folders = [folder('IM'), folder('Workplan')];
  const notes = [
    note('IM', 'IM-32', { date: '2026-10-08T10:00', excerpt: 'Pagamento con carta' }),
    note('IM', 'calendario'),
    note('IM', 'IM-34', { date: '2026-10-22T10:00' }),
    note('IM', 'Avvio', { date: '2026-10-01' }),
    note('Workplan', 'Piano', { date: '2026-09-30' }),
  ];
  assert.deepEqual(noteGroups(folders, notes, '')[0]?.notes.map((item) => item.title), ['IM-34', 'IM-32', 'Avvio', 'calendario']);
  assert.deepEqual(noteGroups(folders, notes, 'carta').map((group) => group.notes.map((item) => item.title).join()), ['IM-32']);
  assert.deepEqual(noteGroups(folders, notes, '', 'Workplan').map((group) => group.folder), ['Workplan']);
  assert.deepEqual(noteGroups(folders, notes, 'carta', 'Workplan'), []);
});

test('dates of the notes in Italian, short in the list and long in the open note (D-193)', () => {
  assert.equal(noteDayText('2026-10-08T10:00', 2026), '8 ott');
  assert.equal(noteDayText('2025-01-31', 2026), '31 gen 2025');
  assert.equal(noteDayText(null, 2026), '');
  assert.equal(noteDayText('domani', 2026), '');
  assert.equal(noteDateText('2026-10-08 10:00'), '8 ott 2026, 10:00');
  assert.equal(noteDateText('2026-10-09T10:30:00+02:00'), '9 ott 2026, 10:30');
  assert.equal(noteDateText('2026-09-30'), '30 set 2026');
  assert.equal(noteDateText('giovedì'), 'giovedì');
});

test('state pills and the label of a row only above its folder (D-193)', () => {
  assert.equal(statusTone('chiuso'), 'done');
  assert.equal(statusTone('Previsto'), 'next');
  assert.equal(statusTone('in corso'), 'next');
  assert.equal(statusTone('sospeso'), 'plain');
  assert.equal(raisedLabel({ label: 'L2' }, 'L1'), 'L2');
  assert.equal(raisedLabel({ label: 'L1' }, 'L1'), null);
  assert.equal(raisedLabel({ label: 'L2' }, undefined), null);
});

test('a body that starts with a heading gives the title of the open note, once (D-193)', () => {
  assert.deepEqual(noteHeading('IM-32', '# IM-32 · giovedì 8 ottobre 2026\n\n## Lavori\n'), { title: 'IM-32 · giovedì 8 ottobre 2026', body: '## Lavori\n' });
  assert.deepEqual(noteHeading('Piano', 'Testo.\n# Dopo'), { title: 'Piano', body: 'Testo.\n# Dopo' });
  assert.deepEqual(noteHeading('Piano', '## Sezione\nx'), { title: 'Piano', body: '## Sezione\nx' });
  assert.deepEqual(noteHeading('Piano', '#senza spazio'), { title: 'Piano', body: '#senza spazio' });
});

test('the header of an open note as a row of data, the other keys as they are (D-193)', () => {
  assert.deepEqual(noteMeta(['im: 32', 'data: 2026-10-08 10:00', 'stato: chiuso', 'chiamata: 2026-10-09 15:00']), {
    im: '32',
    date: '8 ott 2026, 10:00',
    status: 'chiuso',
    other: [{ key: 'chiamata', value: '2026-10-09 15:00' }],
  });
  assert.deepEqual(noteMeta(['source: capture:hud:x', 'captured_at: 2026-10-09T10:30:00+02:00', 'kind: note']), {
    im: null,
    date: '9 ott 2026, 10:30',
    status: null,
    other: [
      { key: 'source', value: 'capture:hud:x' },
      { key: 'kind', value: 'note' },
    ],
  });
  assert.deepEqual(noteMeta([]), { im: null, date: null, status: null, other: [] });
});

test('the notes by folder, with a search on title and path', () => {
  const folders = [folder('Workplan'), folder('IM'), folder('documenti', 'L2')];
  const notes = [note('Workplan', 'Piano di lavoro'), note('IM', 'Riunione di avvio Rossi'), note('IM', 'IM-34'), note('Verbali', 'Verbale')];
  assert.deepEqual(
    noteGroups(folders, notes, '').map((group) => `${group.folder}:${String(group.notes.length)}`),
    ['Workplan:1', 'IM:2', 'documenti:0', 'Verbali:1'],
  );
  assert.deepEqual(
    noteGroups(folders, notes, ' rossi ').map((group) => `${group.folder}:${group.notes.map((item) => item.title).join()}`),
    ['IM:Riunione di avvio Rossi'],
  );
  assert.deepEqual(noteGroups(folders, notes, 'verbali/').map((group) => group.folder), ['Verbali']);
  assert.deepEqual(noteGroups(folders, notes, 'niente'), []);
  assert.equal(noteGroups(folders, notes, '').find((group) => group.folder === 'Verbali')?.label, undefined);
  assert.equal(folderCounts(notes).get('IM'), 2);
  assert.equal(folderCounts(notes).get('documenti'), undefined);
  assert.equal(notesCountText(0), 'nessuna nota');
  assert.equal(notesCountText(1), '1 nota');
  assert.equal(notesCountText(5), '5 note');
});
