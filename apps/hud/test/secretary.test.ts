// The secretary in the chat (I-12, D-144): the list beside its conversation and the Segretaria card of the settings.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { closedText, dayLabel, dueCount, groupCommitments, outcomeText, postponedText, reportEntries, SESSION_LINE, sessionStart } from '../src/lib/commitments.ts';
import { reasonText } from '../src/lib/italian.ts';
import { DEFAULT_SECRETARY, secretaryBody, secretaryProblem } from '../src/lib/settings.ts';
import { resolveSection } from '../src/lib/settings-index.ts';
import type { Commitment } from '../src/lib/types.ts';

const TODAY = '2026-10-09';

function item(id: string, day: string, status: Commitment['status'] = 'open', time: string | null = null): Commitment {
  return { id, body: `Impegno ${id}`, day, time, status, reason: null, rescheduledFrom: null, postponedFrom: null, label: 'L2' };
}

test('days in Italian: Oggi, Domani, then the weekday and the date, the year only when another', () => {
  assert.equal(dayLabel(TODAY, TODAY), 'Oggi');
  assert.equal(dayLabel('2026-10-10', TODAY), 'Domani');
  assert.equal(dayLabel('2026-10-15', TODAY), 'giovedì 15 ottobre');
  assert.equal(dayLabel('2027-01-04', TODAY), 'lunedì 4 gennaio 2027');
  assert.equal(dayLabel('2027-01-01', '2026-12-31'), 'Domani');
});

test('the list: the late open ones first, then each day; done today stays, cancelled never', () => {
  const groups = groupCommitments(
    [item('a', '2026-10-07'), item('b', TODAY, 'done'), item('c', TODAY, 'open', '15:00'), item('d', '2026-10-15'), item('e', TODAY, 'cancelled'), item('f', '2026-10-01', 'done')],
    TODAY,
  );
  assert.deepEqual(
    groups.map((group) => [group.title, group.late, group.items.map((entry) => entry.id)]),
    [
      ['In ritardo', true, ['a']],
      ['Oggi', false, ['b', 'c']],
      ['giovedì 15 ottobre', false, ['d']],
    ],
  );
  assert.equal(dueCount([item('a', '2026-10-07'), item('c', TODAY), item('b', TODAY, 'done'), item('d', '2026-10-15')], TODAY), 2);
  assert.deepEqual(groupCommitments([], TODAY), []);
});

test('the Segretaria card: three clocks in order and at least one day, days sent Monday first', () => {
  assert.equal(secretaryProblem(DEFAULT_SECRETARY), undefined);
  assert.deepEqual(DEFAULT_SECRETARY.days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.deepEqual([DEFAULT_SECRETARY.morning, DEFAULT_SECRETARY.afternoon, DEFAULT_SECRETARY.evening], ['09:00', '14:30', '18:30']);
  assert.match(secretaryProblem({ ...DEFAULT_SECRETARY, morning: '' }) ?? '', /tre orari/);
  assert.match(secretaryProblem({ ...DEFAULT_SECRETARY, evening: '12:00' }) ?? '', /in ordine/);
  assert.match(secretaryProblem({ ...DEFAULT_SECRETARY, days: [] }) ?? '', /almeno un giorno/);
  assert.deepEqual(secretaryBody({ ...DEFAULT_SECRETARY, days: ['sun', 'mon'] }).days, ['mon', 'sun']);
  assert.equal(resolveSection('segretaria').item.id, 'secretary');
});

test('the waits of the secretary are said in Italian', () => {
  assert.equal(reasonText('approval needed: commitment.add'), 'aspetta la tua conferma per segnare l’impegno');
  assert.equal(reasonText('approval needed: commitment.done'), 'aspetta la tua conferma per segnare l’impegno come fatto');
});

test('the session of the secretary (D-146): the line above the first message from the last click', () => {
  const messages = [{ ts: '2026-10-09T08:00:00.000Z' }, { ts: '2026-10-09T09:00:00.000Z' }, { ts: '2026-10-09T10:00:00.000Z' }];
  assert.equal(sessionStart(messages, '2026-10-09T08:30:00.000Z'), 1);
  assert.equal(sessionStart(messages, '2026-10-09T09:00:00.000Z'), 1);
  assert.equal(sessionStart(messages, '2026-10-09T07:00:00.000Z'), 0);
  // Clicked after the last message: the line closes the chat, the next message starts below it.
  assert.equal(sessionStart(messages, '2026-10-09T11:00:00.000Z'), 3);
  // No session yet, no message, or a core without it: no line.
  assert.equal(sessionStart(messages, null), -1);
  assert.equal(sessionStart(messages, undefined), -1);
  assert.equal(sessionStart([], '2026-10-09T08:30:00.000Z'), -1);
  assert.equal(sessionStart(messages, 'non una data'), -1);
  assert.match(SESSION_LINE, /^Nuova sessione/);
});

test('a closed commitment of today (D-151): a short tag, the reason only for not done and postponed', () => {
  assert.deepEqual(closedText(item('a', TODAY, 'done')), { tag: 'Fatto', reason: null });
  assert.deepEqual(closedText({ status: 'not_done', reason: ' pioveva ' }), { tag: 'Non fatto', reason: 'pioveva' });
  assert.deepEqual(closedText({ status: 'postponed', reason: null }), { tag: 'Rinviato', reason: null });
  assert.deepEqual(closedText({ status: 'postponed', reason: '  ' }), { tag: 'Rinviato', reason: null });
  assert.equal(closedText(item('b', TODAY)), undefined);
  assert.equal(closedText(item('c', TODAY, 'cancelled')), undefined);
  // Closed today stays in the list under Oggi; only the open ones are counted.
  const list = [item('a', TODAY, 'not_done'), item('b', TODAY, 'postponed'), item('c', TODAY)];
  assert.deepEqual(groupCommitments(list, TODAY).map((group) => group.items.map((entry) => entry.id)), [['a', 'b', 'c']]);
  assert.equal(dueCount(list, TODAY), 1);
});

test('an open commitment born from a postponement says where it comes from (D-151)', () => {
  assert.equal(postponedText({ status: 'open', postponedFrom: '2026-10-08' }, TODAY), 'rinviato da giovedì 8 ottobre');
  assert.equal(postponedText({ status: 'open', postponedFrom: TODAY }, TODAY), 'rinviato da oggi');
  assert.equal(postponedText({ status: 'open', postponedFrom: null }, TODAY), undefined);
  assert.equal(postponedText({ status: 'done', postponedFrom: '2026-10-08' }, TODAY), undefined);
  assert.equal(postponedText({ status: 'open', postponedFrom: 'ieri' }, TODAY), undefined);
});

test('the report card (D-151): the valid lines in words, the malformed ones left out', () => {
  const entries = reportEntries({
    op: 'report',
    step: 3,
    entries: [
      { commitmentId: 'a', text: 'Banca', day: TODAY, time: '15:00', dayText: 'venerdì 9 ottobre 2026', outcome: 'done', reason: null },
      { commitmentId: 'b', text: 'Palestra', day: TODAY, time: null, dayText: 'venerdì 9 ottobre 2026', outcome: 'not_done', reason: 'ero stanco' },
      { commitmentId: 'c', text: 'Dentista', day: TODAY, time: null, dayText: 'venerdì 9 ottobre 2026', outcome: 'postponed', reason: 'studio chiuso', toDay: '2026-10-12', toTime: '10:00', toDayText: 'lunedì 12 ottobre 2026' },
      { commitmentId: 'd', text: 'Posta', day: TODAY, time: null, dayText: 'venerdì 9 ottobre 2026', outcome: 'postponed', reason: null, toDay: '2026-10-12', toTime: null, toDayText: 'lunedì 12 ottobre 2026' },
      // Malformed: unknown outcome, no text, a postponement without its new day, not an object.
      { commitmentId: 'e', text: 'X', dayText: 'oggi', outcome: 'maybe' },
      { commitmentId: 'f', dayText: 'oggi', outcome: 'done' },
      { commitmentId: 'g', text: 'Y', dayText: 'oggi', outcome: 'postponed' },
      'non una voce',
      null,
    ],
  });
  assert.deepEqual(
    entries.map((entry) => [entry.commitmentId, outcomeText(entry), entry.reason]),
    [
      ['a', 'Fatto', null],
      ['b', 'Non fatto', 'ero stanco'],
      ['c', 'Rinviato a lunedì 12 ottobre 2026, alle 10:00', 'studio chiuso'],
      ['d', 'Rinviato a lunedì 12 ottobre 2026', null],
    ],
  );
  assert.equal(entries[0]?.time, '15:00');
  // Another detail, or a report without entries: nothing, and the card falls back.
  assert.deepEqual(reportEntries({ op: 'add', text: 'Banca', dayText: 'oggi' }), []);
  assert.deepEqual(reportEntries({ op: 'report', entries: 'tutte' }), []);
  assert.deepEqual(reportEntries({ op: 'report', entries: [{ outcome: 'done' }] }), []);
});

test('the wait of the report is said in Italian', () => {
  assert.equal(reasonText('approval needed: commitment.report'), 'aspetta la tua conferma per annotare il resoconto');
});
