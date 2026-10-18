// A routine Arianna proposes in the chat (D-110, tappa A2; D-256): the card of
// the approval and the badge of the page, without a browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pendingAskText } from '../src/lib/pending-text.ts';
import { ROUTINE_NO, ROUTINE_YES, routineProposal } from '../src/lib/routine-approval.ts';
import { PROPOSED_BADGE, statusText } from '../src/lib/routines.ts';

const DETAIL = { routineId: '6f1c2a34-0b5d-4e6f-8a9b-0c1d2e3f4a5b', title: 'Resoconto finto', days: [1, 4], at: '09:00', timezone: 'Europe/Rome', sources: ['todo', 'waiting'], summary: true, step: 1 };

test('the card of a proposed routine: title, days and time, what goes in the report, the two buttons', () => {
  assert.deepEqual(routineProposal({ kind: 'routine', detail: DETAIL }, 'Europe/Rome'), {
    title: 'Resoconto finto',
    when: 'lun e gio alle 09:00',
    zone: null,
    sources: ['Da fare', 'Decisioni in attesa'],
    summary: true,
  });
  assert.equal(routineProposal({ kind: 'routine', detail: { ...DETAIL, summary: false } }, 'UTC')?.zone, 'Europe/Rome');
  assert.equal(routineProposal({ kind: 'routine', detail: { ...DETAIL, summary: false } }, 'UTC')?.summary, false);
  assert.deepEqual([ROUTINE_YES, ROUTINE_NO], ['Attiva', 'Scarta']);
});

test('not a card of a routine: another kind, a purged detail, no valid day or source', () => {
  assert.equal(routineProposal({ kind: 'fact', detail: DETAIL }), undefined);
  assert.equal(routineProposal({ kind: 'routine', detail: { purged: true } }), undefined);
  assert.equal(routineProposal({ kind: 'routine', detail: { ...DETAIL, days: [9] } }), undefined);
  assert.equal(routineProposal({ kind: 'routine', detail: { ...DETAIL, sources: ['email.important'] } }), undefined);
});

test('the page marks a proposal «Da approvare»; «Decisioni in attesa» names it', () => {
  assert.equal(statusText({ status: 'proposed', pausedBy: null }), PROPOSED_BADGE);
  assert.equal(PROPOSED_BADGE, 'Da approvare');
  assert.equal(pendingAskText({ kind: 'routine', action: 'routine.propose', detail: DETAIL }), 'Attivare la routine «Resoconto finto»');
});
