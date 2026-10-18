// The routines (D-110 tappa A, D-254) without the database: the form checked
// on closed lists, the report written by code for each source, its label, and
// the summary of the local model read through a closed schema.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dueText, numbersIn, parseRoutineInput, readSummary, reportFacts, reportLabel, reportText, RoutineError, scheduleText, summaryChecked, summaryInput, summaryText, type ReportData } from '../src/routines.ts';

const ON_TIME = { kind: 'on-time', due: new Date('2026-10-19T16:00:00Z') } as const;
const ROME = 'Europe/Rome';
const TODAY = new Date('2026-10-19T08:00:00Z');

function invalid(body: Record<string, unknown>, partial = false): boolean {
  try {
    parseRoutineInput(body, partial);
    return false;
  } catch (error) {
    if (error instanceof RoutineError && error.code === 'invalid') return true;
    throw error;
  }
}

test('the form takes closed choices and one line of title', () => {
  const input = parseRoutineInput({ title: '  Buona   sera ', days: [5, 1, 1], at: '18:00', sources: ['notes', 'todo'], summary: false, timezone: 'Europe/Rome' }, false);
  assert.deepEqual(input, { title: 'Buona sera', days: [1, 5], at: '18:00', timezone: 'Europe/Rome', sources: ['todo', 'notes'], summary: false });
  assert.deepEqual(parseRoutineInput({ at: '07:15' }, true), { at: '07:15' });
});

test('the form refuses what is not in the lists', () => {
  const good = { title: 'Sera', days: [1], at: '18:00', sources: ['todo'] };
  assert.ok(!invalid(good));
  assert.ok(invalid({ ...good, title: '' }));
  assert.ok(invalid({ ...good, title: 'x'.repeat(81) }));
  assert.ok(invalid({ ...good, days: [] }));
  assert.ok(invalid({ ...good, days: [0] }));
  assert.ok(invalid({ ...good, at: '6:00' }));
  assert.ok(invalid({ ...good, sources: ['email.important'] }));
  assert.ok(invalid({ ...good, timezone: 'Europe/Nowhere' }));
  // No free prompt, no other channel: unknown fields are refused.
  assert.ok(invalid({ ...good, prompt: 'dimmi le email' }));
  assert.ok(invalid({ ...good, channel: 'call' }));
  assert.ok(invalid({ title: 'Sera' }));
});

test('todo: the cards named with their due date, the rest counted; none says the list is empty', () => {
  const data: ReportData = {
    todo: {
      shown: [{ title: 'Pagare la bolletta finta', label: 'L2', due: new Date('2026-10-20T10:00:00Z') }, { title: 'Chiamare il fornitore finto', label: 'L1', due: null }],
      more: 2,
      secret: 1,
    },
  };
  const text = reportText(data, ON_TIME, ROME, TODAY);
  assert.match(text, /^Resoconto di lunedì 19 ottobre alle 18:00\.\n\nDa fare \(5\):\n- Pagare la bolletta finta · scade domani\n- Chiamare il fornitore finto\n- e altre 2\n- 1 riservata, solo contata$/);
  assert.match(reportText({ todo: { shown: [], more: 0, secret: 0 } }, ON_TIME, ROME, TODAY), /Da fare: niente, la lista è vuota\./);
});

test('waiting: the count of D-091; none says none', () => {
  assert.match(reportText({ waiting: 3 }, ON_TIME, ROME, TODAY), /Decisioni in attesa: Arianna aspetta 3 tue decisioni\./);
  assert.match(reportText({ waiting: 0 }, ON_TIME, ROME, TODAY), /Decisioni in attesa: nessuna\./);
});

test('cards: at work named, to verify counted; none at work says so', () => {
  assert.match(reportText({ cards: { running: { shown: [{ title: 'Preventivo finto', label: 'L1', due: null }], more: 0, secret: 0 }, toVerify: 2 } }, ON_TIME, ROME, TODAY), /In corso \(1\): 2 carte sono da verificare\.\n- Preventivo finto/);
  assert.match(reportText({ cards: { running: { shown: [], more: 0, secret: 0 }, toVerify: 0 } }, ON_TIME, ROME, TODAY), /In corso: nessuna carta al lavoro\./);
});

test('done and failed since the last report; none says nothing', () => {
  const one = { shown: [{ title: 'Fatta finta', label: 'L2' as const, due: null }], more: 0, secret: 0 };
  const none = { shown: [], more: 0, secret: 0 };
  const text = reportText({ done: one, failed: none }, ON_TIME, ROME, TODAY);
  assert.match(text, /Fatto dall’ultimo resoconto \(1\):\n- Fatta finta/);
  assert.match(text, /Fallito dall’ultimo resoconto: niente\./);
});

test('notes: only their number', () => {
  assert.match(reportText({ notes: 4 }, ON_TIME, ROME, TODAY), /Pensieri da riordinare: 4\./);
  assert.match(reportText({ notes: 0 }, ON_TIME, ROME, TODAY), /Pensieri da riordinare: nessuno\./);
});

test('the opening: late with an apology, a trial with the next run', () => {
  assert.match(reportText({ notes: 1 }, { kind: 'late', due: new Date('2026-10-19T16:00:00Z') }, ROME, TODAY), /^Scusa il ritardo: il resoconto doveva arrivare lunedì 19 ottobre alle 18:00, ma il Mac era spento/);
  assert.match(reportText({ notes: 1 }, { kind: 'trial', next: new Date('2026-10-20T16:00:00Z') }, ROME, TODAY), /^Prova della routine: ecco il resoconto di adesso\. Il prossimo arriva martedì 20 ottobre alle 18:00\./);
  assert.match(reportText({ notes: 1 }, { kind: 'trial', next: null }, ROME, TODAY), /^Prova della routine: ecco il resoconto di adesso\.\n/);
});

test('the label of the report is at least L2 and never names what is above', () => {
  assert.equal(reportLabel({ notes: 2 }), 'L2');
  assert.equal(reportLabel({ todo: { shown: [{ title: 'x', label: 'L1', due: null }], more: 0, secret: 3 } }), 'L2');
});

test('the summary of the model: up to three lines in the schema, inert in the chat', () => {
  assert.deepEqual(readSummary({ value: { lines: ['Oggi conta la bolletta finta.'] }, finishReason: 'stop' }), ['Oggi conta la bolletta finta.']);
  assert.deepEqual(readSummary({ value: { lines: ['Guarda ![x](https://esempio.invalid/a.png) <b>ora</b>'] }, finishReason: 'stop' }), ['Guarda !\\[x]\\(https[://]esempio.invalid/a.png) ‹b›ora‹/b›']);
  assert.deepEqual(readSummary({ value: { lines: ['a', 'b', 'c', 'd'] }, finishReason: 'stop' }), { reason: 'bad-response' });
  assert.deepEqual(readSummary({ value: { lines: [] }, finishReason: 'stop' }), { reason: 'bad-response' });
  assert.deepEqual(readSummary({ value: { lines: ['ok'], extra: 1 }, finishReason: 'stop' }), { reason: 'bad-response' });
  assert.deepEqual(readSummary({ value: { lines: ['x'.repeat(201)] }, finishReason: 'stop' }), { reason: 'bad-response' });
  assert.deepEqual(readSummary({ value: { lines: ['ok'] }, finishReason: 'length' }), { reason: 'truncated' });
  assert.equal(summaryText(['Uno.', 'Due.']), 'In sintesi:\n- Uno.\n- Due.');
});

test('the schedule in words', () => {
  assert.equal(scheduleText({ days: [1, 2, 3, 4, 5], at: '10:00' }), 'lun-ven alle 10:00');
});

test('the deadlines as the code says them against the day of the report', () => {
  // Monday 19 October 2026 in Rome.
  assert.equal(dueText(new Date('2026-10-09T10:00:00Z'), ROME, TODAY), 'scaduta da 10 giorni (9 ott)');
  assert.equal(dueText(new Date('2026-10-18T10:00:00Z'), ROME, TODAY), 'scaduta ieri (18 ott)');
  assert.equal(dueText(new Date('2026-10-19T20:00:00Z'), ROME, TODAY), 'scade oggi');
  assert.equal(dueText(new Date('2026-10-20T10:00:00Z'), ROME, TODAY), 'scade domani');
  assert.equal(dueText(new Date('2026-10-23T10:00:00Z'), ROME, TODAY), 'scade fra 4 giorni (23 ott)');
});

/** The report of the real case (D-254): 16 to do, 7 named and «e altre 9», 2 to verify. */
function realReport(): string {
  const shown = [
    { title: 'Rinnovare il dominio (prova)', label: 'L2' as const, due: new Date('2026-10-09T10:00:00Z') },
    ...Array.from({ length: 6 }, (_, index) => ({ title: `Card finta ${String(index + 1)}`, label: 'L2' as const, due: null })),
  ];
  return reportText({ todo: { shown, more: 9, secret: 0 }, cards: { running: { shown: [], more: 0, secret: 0 }, toVerify: 2 }, notes: 4 }, ON_TIME, ROME, TODAY);
}

test('the facts read back from the report: totals as numbers, deadlines as computed', () => {
  const facts = reportFacts(realReport());
  assert.equal(facts.da_fare?.totale, 16);
  assert.equal(facts.da_fare.altre_non_elencate, 9);
  assert.equal(facts.da_fare.elencate.length, 7);
  assert.deepEqual(facts.da_fare.elencate[0], { titolo: 'Rinnovare il dominio (prova)', scadenza: 'scaduta da 10 giorni (9 ott)' });
  assert.deepEqual(facts.da_fare.elencate[1], { titolo: 'Card finta 1' });
  assert.equal(facts.in_corso?.totale, 0);
  assert.equal(facts.in_corso.da_verificare, 2);
  assert.equal(facts.pensieri_da_riordinare, 4);
  // Every section of the report has its facts.
  const all = reportFacts(reportText({ waiting: 1, done: { shown: [{ title: 'Fatta', label: 'L2', due: null }], more: 0, secret: 1 }, failed: { shown: [], more: 0, secret: 0 } }, ON_TIME, ROME, TODAY));
  assert.equal(all.decisioni_in_attesa, 1);
  assert.deepEqual(all.fatto_dall_ultimo_resoconto, { totale: 2, elencate: [{ titolo: 'Fatta' }], altre_non_elencate: 0, riservate_solo_contate: 1 });
  assert.deepEqual(all.fallito_dall_ultimo_resoconto, { totale: 0, elencate: [], altre_non_elencate: 0, riservate_solo_contate: 0 });
});

test('the check of the summary: only numbers of the data, never «oggi» for a deadline that is past', () => {
  const facts = reportFacts(realReport());
  const today = 'lunedì 19 ottobre 2026';
  // Accepted: the totals, the days of a deadline, its date, a total in words.
  assert.ok(summaryChecked(['Hai 16 cose da fare e 2 carte da verificare.'], facts, today));
  assert.ok(summaryChecked(['16 da fare.'], facts, today));
  assert.ok(summaryChecked(['Il dominio (prova) è scaduto da 10 giorni, il 9 ottobre: rinnovalo per primo.'], facts, today));
  assert.ok(summaryChecked(['Hai sedici cose da fare e 4 pensieri da riordinare.'], facts, today));
  // Refused: «9 task» with a total of 16 (the 9 of «e altre 9» is not a total), or a count the data has not.
  assert.ok(!summaryChecked(['2 carte sono da verificare e 9 task sono da fare.'], facts, today));
  assert.ok(!summaryChecked(['Hai nove cose da fare.'], facts, today));
  assert.ok(!summaryChecked(['Hai 15 cose da fare.'], facts, today));
  // Refused: a date the data has not.
  assert.ok(!summaryChecked(['Il dominio scadeva il 12 ottobre.'], facts, today));
  // Refused: a deadline past called «oggi».
  assert.ok(!summaryChecked(['Rinnova il dominio (prova) che scade il 9 ott, è la cosa più urgente oggi'], facts, today));
  assert.ok(!summaryChecked(['Il dominio (prova) scade oggi: è la cosa più urgente.'], facts, today));
  assert.deepEqual(numbersIn('16 cose, 2,5 euro e tre carte'), [16, 2.5, 3]);
});

test('«scaduta da 9 giorni» is accepted when the data says so; «oggi» when one is due today', () => {
  const report = reportText({ todo: { shown: [{ title: 'Bolletta finta', label: 'L2', due: new Date('2026-10-10T10:00:00Z') }, { title: 'Modulo finto', label: 'L2', due: new Date('2026-10-19T15:00:00Z') }], more: 0, secret: 0 } }, ON_TIME, ROME, TODAY);
  const facts = reportFacts(report);
  const today = 'lunedì 19 ottobre 2026';
  assert.equal(facts.da_fare?.elencate[0]?.scadenza, 'scaduta da 9 giorni (10 ott)');
  assert.ok(summaryChecked(['La bolletta finta è scaduta da 9 giorni.', 'Il modulo finto scade oggi.'], facts, today));
  assert.match(summaryInput(facts, today), /"totale":2/);
});
