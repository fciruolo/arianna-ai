// The secretary in the chat (I-12, D-144): the list beside its conversation and the Segretaria card of the settings.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayLabel, dueCount, groupCommitments } from '../src/lib/commitments.ts';
import { reasonText } from '../src/lib/italian.ts';
import { DEFAULT_SECRETARY, secretaryBody, secretaryProblem } from '../src/lib/settings.ts';
import { resolveSection } from '../src/lib/settings-index.ts';
import type { Commitment } from '../src/lib/types.ts';

const TODAY = '2026-10-09';

function item(id: string, day: string, status: Commitment['status'] = 'open', time: string | null = null): Commitment {
  return { id, body: `Impegno ${id}`, day, time, status, reason: null, label: 'L2' };
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
