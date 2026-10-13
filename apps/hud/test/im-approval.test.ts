// The confirmation of an IM item in the web chat (D-167, P4b): the exact text, the IM and its label, Sì/No.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IM_NO, IM_YES, imConfirmation } from '../src/lib/im-approval.ts';
import { reasonText } from '../src/lib/italian.ts';
import { ACTION_TEXT } from '../src/lib/labels.ts';

const DETAIL = { project: 'progetto-test', which: 'next', number: 34, date: '2026-10-22 10:00', dateText: 'giovedì 22 ottobre 2026, 10:00', imLabel: 'L1', title: 'Fatture', step: 1 };

test('the card says the exact text, the IM, the project and who will read it', () => {
  assert.deepEqual(imConfirmation(DETAIL), {
    sentence: 'Scrivo «Fatture» nell’IM-34 di progetto-test, che è Interno: il Coder lo potrà leggere.',
    title: 'Fatture',
    where: 'IM-34 · giovedì 22 ottobre 2026, 10:00',
  });
  assert.match(imConfirmation({ ...DETAIL, imLabel: 'L0' })?.sentence ?? '', /che è Pubblico: il Coder lo potrà leggere e potrà uscire dalla macchina\.$/);
  assert.equal(imConfirmation({ ...DETAIL, dateText: undefined })?.where, 'IM-34');
  assert.deepEqual([IM_YES, IM_NO], ['Sì, scrivi', 'No']);
});

test('a detail that is not a whole one falls back to the generic card', () => {
  assert.equal(imConfirmation({ ...DETAIL, title: undefined }), undefined);
  assert.equal(imConfirmation({ ...DETAIL, number: '34' }), undefined);
  assert.equal(imConfirmation({ ...DETAIL, imLabel: 'L2' }), undefined);
  assert.equal(imConfirmation({}), undefined);
});

test('the title of the card and why the task waits, in Italian', () => {
  assert.equal(ACTION_TEXT['im.add'], 'Scrivo nell’IM?');
  assert.equal(reasonText('approval needed: im.add'), 'aspetta la tua conferma per scrivere la voce nell’IM');
});
