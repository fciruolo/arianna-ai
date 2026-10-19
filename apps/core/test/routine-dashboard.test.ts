// The source «Dashboard» of the routines (D-258) without the database: the
// choice of tiles in the form, the section of the report written by code
// (the tiles started named, Segreto, busy and unavailable only counted), its
// label, the facts read back for the summary and the check of the numbers;
// routine.propose takes the source but never a choice of tiles. Fake data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkRoutineProposal } from '../src/routine-proposals.ts';
import {
  dashboardReport,
  DASHBOARD_NONE_TEXT,
  DASHBOARD_WHERE_TEXT,
  parseRoutineInput,
  reportFacts,
  reportLabel,
  reportText,
  RoutineError,
  summaryChecked,
  type ReportData,
} from '../src/routines.ts';
import type { RefreshCandidate } from '../src/dashboard.ts';

const ON_TIME = { kind: 'on-time', due: new Date('2026-10-19T06:00:00Z') } as const;
const ROME = 'Europe/Rome';
const TODAY = new Date('2026-10-19T06:00:00Z');
const A = '0b6f1c1e-6c1a-4a7e-9a52-6b8e2f0c0001';
const B = '0b6f1c1e-6c1a-4a7e-9a52-6b8e2f0c0002';

function tile(title: string, skip?: RefreshCandidate['skip'], label: RefreshCandidate['label'] = 'L2'): RefreshCandidate {
  return { id: `0b6f1c1e-6c1a-4a7e-9a52-${String(title.length).padStart(12, '0')}`, title, label, skip };
}

function invalid(body: Record<string, unknown>, partial = false): boolean {
  try {
    parseRoutineInput(body, partial);
    return false;
  } catch (error) {
    if (error instanceof RoutineError && error.code === 'invalid') return true;
    throw error;
  }
}

test('the form takes the source «Dashboard» with every tile (null) or a list of tile ids', () => {
  const good = { title: 'Mattina', days: [1, 2, 3, 4, 5], at: '08:00', sources: ['dashboard'] };
  assert.deepEqual(parseRoutineInput({ ...good, dashboardTiles: null }, false).dashboardTiles, null);
  assert.deepEqual(parseRoutineInput({ ...good, dashboardTiles: [A, B, A.toUpperCase()] }, false).dashboardTiles, [A, B]);
  assert.equal(parseRoutineInput(good, false).dashboardTiles, undefined);
  assert.deepEqual(parseRoutineInput({ dashboardTiles: [B] }, true), { dashboardTiles: [B] });
  // Never an empty list, never a title or another value in place of an id, never more than 200.
  assert.ok(invalid({ ...good, dashboardTiles: [] }));
  assert.ok(invalid({ ...good, dashboardTiles: ['Spese del mese'] }));
  assert.ok(invalid({ ...good, dashboardTiles: 'all' }));
  assert.ok(invalid({ ...good, dashboardTiles: Array.from({ length: 201 }, (_, index) => `0b6f1c1e-6c1a-4a7e-9a52-${String(index).padStart(12, '0')}`) }));
  assert.ok(invalid({ ...good, sources: ['dashbord'] }));
});

test('the tiles judged: those to start named in the order of the page, the others counted by why', () => {
  const report = dashboardReport([tile('Spese del mese'), tile('Diario', 'secret', 'L3'), tile('Scadenze'), tile('Clienti', 'busy'), tile('Conti di casa', 'unavailable')]);
  assert.deepEqual(report.queued.shown.map((item) => item.title), ['Spese del mese', 'Scadenze']);
  assert.equal(report.ids.length, 2);
  assert.deepEqual([report.secret, report.busy, report.unavailable], [1, 1, 1]);
  // More than seven: seven named, the others counted, every id still started.
  const many = dashboardReport(Array.from({ length: 9 }, (_, index) => tile(`Riquadro ${'x'.repeat(index)}`)));
  assert.equal(many.queued.shown.length, 7);
  assert.equal(many.queued.more, 2);
  assert.equal(many.ids.length, 9);
  // A Segreto tile not marked by the rules is never named either.
  assert.deepEqual(dashboardReport([tile('Diario', undefined, 'L3')]).ids, []);
});

test('the section of the report: titles of the tiles started, Segreto never named; none says none', () => {
  const data: ReportData = { dashboard: dashboardReport([tile('Spese del mese'), tile('Diario segreto', 'secret', 'L3'), tile('Scadenze'), tile('Clienti', 'busy')]) };
  const text = reportText(data, ON_TIME, ROME, TODAY);
  assert.match(text, /^Dashboard, riquadri in aggiornamento \(2\):\n- Spese del mese\n- Scadenze\n\+ 1 Segreto, non si aggiorna\n\+ 1 già in aggiornamento\n/m);
  assert.ok(text.endsWith(DASHBOARD_WHERE_TEXT));
  assert.doesNotMatch(text, /Diario/);
  const none = reportText({ dashboard: dashboardReport([]) }, ON_TIME, ROME, TODAY);
  assert.ok(none.endsWith(`\n\n${DASHBOARD_NONE_TEXT}`));
  assert.doesNotMatch(none, /Le risposte nuove/);
  const skipped = reportText({ dashboard: dashboardReport([tile('A', 'secret', 'L3'), tile('BB', 'secret', 'L3'), tile('CCC', 'unavailable'), tile('DDDD', 'unavailable')]) }, ON_TIME, ROME, TODAY);
  assert.match(skipped, /Dashboard: nessun riquadro da aggiornare\.\n\+ 2 Segreti, non si aggiornano\n\+ 2 non aggiornabili adesso$/);
});

test('the label of the report rises with the tiles it names, never below L2', () => {
  assert.equal(reportLabel({ dashboard: dashboardReport([tile('Note di lavoro', undefined, 'L1')]) }), 'L2');
  assert.equal(reportLabel({ dashboard: dashboardReport([tile('Diario', 'secret', 'L3')]) }), 'L2');
});

test('the facts read back from the section, and the summary may use its numbers only', () => {
  const data: ReportData = {
    todo: { shown: [{ title: 'Pagare la bolletta finta', label: 'L2', due: null }], more: 0, secret: 0 },
    dashboard: dashboardReport([tile('Spese del mese'), tile('Scadenze'), tile('Spese 2026 per categoria'), tile('Diario', 'secret', 'L3'), tile('Clienti', 'busy'), tile('Conti', 'unavailable'), tile('Conti 2', 'unavailable')]),
  };
  const facts = reportFacts(reportText(data, ON_TIME, ROME, TODAY));
  assert.deepEqual(facts.dashboard_in_aggiornamento, {
    totale: 3,
    elencate: [{ titolo: 'Spese del mese' }, { titolo: 'Scadenze' }, { titolo: 'Spese 2026 per categoria' }],
    altre_non_elencate: 0,
    riservate_solo_contate: 0,
    segreti_non_aggiornati: 1,
    gia_in_aggiornamento: 1,
    non_aggiornabili_adesso: 2,
  });
  // The todo is still read: the section of the Dashboard does not swallow the others.
  assert.equal(facts.da_fare?.totale, 1);
  const today = 'lunedì 19 ottobre 2026';
  assert.ok(summaryChecked(['Sto aggiornando 3 riquadri della Dashboard, fra cui Spese del mese.', 'Un riquadro Segreto non si aggiorna.'], facts, today));
  assert.ok(summaryChecked(['2 riquadri non si possono aggiornare adesso.'], facts, today));
  // A number not in the data, or the sum of the counts, is refused.
  assert.ok(!summaryChecked(['Sto aggiornando 5 riquadri.'], facts, today));
  assert.ok(!summaryChecked(['In tutto 7 riquadri.'], facts, today));
});

test('every form of the section reads back: more than seven, one and many of each count', () => {
  const tiles = [...Array.from({ length: 8 }, (_, index) => tile(`Riquadro ${'y'.repeat(index)}`)), tile('S', 'secret', 'L3'), tile('B', 'busy'), tile('BB', 'busy'), tile('U', 'unavailable')];
  const facts = reportFacts(reportText({ dashboard: dashboardReport(tiles) }, ON_TIME, ROME, TODAY));
  const read = facts.dashboard_in_aggiornamento;
  assert.ok(read !== undefined);
  assert.equal(read.totale, 8);
  assert.equal(read.elencate.length, 7);
  assert.equal(read.altre_non_elencate, 1);
  assert.equal(read.segreti_non_aggiornati, 1);
  assert.equal(read.gia_in_aggiornamento, 2);
  assert.equal(read.non_aggiornabili_adesso, 1);
  assert.deepEqual(reportFacts(reportText({ dashboard: dashboardReport([]) }, ON_TIME, ROME, TODAY)).dashboard_in_aggiornamento?.totale, 0);
  // A title that looks like a count of the section stays a title.
  const tricky = reportFacts(reportText({ dashboard: dashboardReport([tile('+ 9 già in aggiornamento')]) }, ON_TIME, ROME, TODAY));
  const trickyRead = tricky.dashboard_in_aggiornamento;
  assert.ok(trickyRead !== undefined);
  assert.equal(trickyRead.gia_in_aggiornamento, 0);
  assert.deepEqual(trickyRead.elencate, [{ titolo: '+ 9 già in aggiornamento' }]);
});

test('routine.propose takes the source «Dashboard» (every tile), never a choice of tiles', () => {
  const good = { title: 'Mattina', days: [1, 2, 3, 4, 5], at: '08:00', sources: ['todo', 'dashboard'] };
  const checked = checkRoutineProposal(good, ROME);
  assert.ok(!('error' in checked));
  assert.deepEqual(checked.sources, ['todo', 'dashboard']);
  const refused = checkRoutineProposal({ ...good, dashboardTiles: [A] }, ROME);
  assert.ok('error' in refused && /unknown field/.test(refused.error));
});
