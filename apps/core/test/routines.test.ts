// The routines (D-110 tappa A, D-254) without the database: the form checked
// on closed lists, the report written by code for each source, its label, and
// the summary of the local model read through a closed schema.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRoutineInput, readSummary, reportLabel, reportText, RoutineError, scheduleText, summaryText, type ReportData } from '../src/routines.ts';

const ON_TIME = { kind: 'on-time', due: new Date('2026-10-19T16:00:00Z') } as const;
const ROME = 'Europe/Rome';

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
  const text = reportText(data, ON_TIME, ROME);
  assert.match(text, /^Resoconto di lunedì 19 ottobre alle 18:00\.\n\nDa fare \(5\):\n- Pagare la bolletta finta · scade il 20 ott\n- Chiamare il fornitore finto\n- e altre 2\n- 1 riservata, solo contata$/);
  assert.match(reportText({ todo: { shown: [], more: 0, secret: 0 } }, ON_TIME, ROME), /Da fare: niente, la lista è vuota\./);
});

test('waiting: the count of D-091; none says none', () => {
  assert.match(reportText({ waiting: 3 }, ON_TIME, ROME), /Decisioni in attesa: Arianna aspetta 3 tue decisioni\./);
  assert.match(reportText({ waiting: 0 }, ON_TIME, ROME), /Decisioni in attesa: nessuna\./);
});

test('cards: at work named, to verify counted; none at work says so', () => {
  assert.match(reportText({ cards: { running: { shown: [{ title: 'Preventivo finto', label: 'L1', due: null }], more: 0, secret: 0 }, toVerify: 2 } }, ON_TIME, ROME), /In corso \(1\): 2 carte sono da verificare\.\n- Preventivo finto/);
  assert.match(reportText({ cards: { running: { shown: [], more: 0, secret: 0 }, toVerify: 0 } }, ON_TIME, ROME), /In corso: nessuna carta al lavoro\./);
});

test('done and failed since the last report; none says nothing', () => {
  const one = { shown: [{ title: 'Fatta finta', label: 'L2' as const, due: null }], more: 0, secret: 0 };
  const none = { shown: [], more: 0, secret: 0 };
  const text = reportText({ done: one, failed: none }, ON_TIME, ROME);
  assert.match(text, /Fatto dall’ultimo resoconto \(1\):\n- Fatta finta/);
  assert.match(text, /Fallito dall’ultimo resoconto: niente\./);
});

test('notes: only their number', () => {
  assert.match(reportText({ notes: 4 }, ON_TIME, ROME), /Pensieri da riordinare: 4\./);
  assert.match(reportText({ notes: 0 }, ON_TIME, ROME), /Pensieri da riordinare: nessuno\./);
});

test('the opening: late with an apology, a trial with the next run', () => {
  assert.match(reportText({ notes: 1 }, { kind: 'late', due: new Date('2026-10-19T16:00:00Z') }, ROME), /^Scusa il ritardo: il resoconto doveva arrivare lunedì 19 ottobre alle 18:00, ma il Mac era spento/);
  assert.match(reportText({ notes: 1 }, { kind: 'trial', next: new Date('2026-10-20T16:00:00Z') }, ROME), /^Prova della routine: ecco il resoconto di adesso\. Il prossimo arriva martedì 20 ottobre alle 18:00\./);
  assert.match(reportText({ notes: 1 }, { kind: 'trial', next: null }, ROME), /^Prova della routine: ecco il resoconto di adesso\.\n/);
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
