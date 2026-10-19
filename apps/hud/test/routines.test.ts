// The page «Routine» (D-110 tappa A, D-254) without a browser: the days and
// the outcome in words, the checks of the form, the address of the page.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRoutinesPath } from '../src/lib/route.ts';
import { RING_TEXT } from '../src/lib/calls.ts';
import { CHANNEL_CHOICES, channelText, daysText, emptyForm, formOf, formProblem, lastRunText, RETRY_CHOICES, routineErrorText, scheduleText, statusText, toggled, VOICE_LABEL_CHOICES, type Routine, type RunView } from '../src/lib/routines.ts';

const RUN: RunView = { id: '1', scheduledFor: '2026-10-19T16:00:00.000Z', trigger: 'schedule', status: 'done', reason: null, summaryState: 'done', createdAt: '2026-10-19T16:00:05.000Z' };

test('the days and the time in words, as the core writes them', () => {
  assert.equal(daysText([1, 2, 3, 4, 5, 6, 7]), 'ogni giorno');
  assert.equal(daysText([5, 4, 3, 2, 1]), 'lun-ven');
  assert.equal(daysText([6, 7]), 'sab e dom');
  assert.equal(daysText([1, 3, 5]), 'lun, mer e ven');
  assert.equal(daysText([2]), 'ogni martedì');
  assert.equal(scheduleText({ days: [1, 2, 3, 4, 5, 6, 7], at: '18:00' }), 'ogni giorno alle 18:00');
});

test('the last outcome in words: done, late, missed, trial, the summary', () => {
  assert.match(lastRunText(RUN, 'Europe/Rome') ?? '', /^Ultima: fatta, lunedì 19 ottobre/);
  assert.match(lastRunText({ ...RUN, reason: 'late', summaryState: 'unavailable' }, 'Europe/Rome') ?? '', /^Ultima: fatta in ritardo, .* · senza sintesi: modello non pronto$/);
  assert.match(lastRunText({ ...RUN, status: 'missed-offline', summaryState: 'none' }, 'Europe/Rome') ?? '', /^Ultima: persa: il Mac era spento, /);
  assert.match(lastRunText({ ...RUN, trigger: 'manual', summaryState: 'queued' }, 'Europe/Rome') ?? '', /^Ultima: prova fatta, .* · sintesi in attesa del modello locale$/);
  assert.equal(lastRunText(null, 'Europe/Rome'), null);
});

test('the state in words', () => {
  assert.equal(statusText({ status: 'active', pausedBy: null }), 'Attiva');
  assert.equal(statusText({ status: 'paused', pausedBy: 'user' }), 'In pausa');
  assert.equal(statusText({ status: 'paused', pausedBy: 'archived' }), 'In pausa: chat archiviata');
});

test('the form: a title, a day, a time and a source are needed', () => {
  const form = { ...emptyForm(), title: 'Sera finta' };
  assert.equal(formProblem(form), null);
  assert.equal(formProblem({ ...form, title: '  ' }), 'Scrivi un titolo.');
  assert.equal(formProblem({ ...form, title: 'x'.repeat(81) }), 'Il titolo è più lungo di 80 caratteri.');
  assert.equal(formProblem({ ...form, days: [] }), 'Scegli almeno un giorno.');
  assert.equal(formProblem({ ...form, at: '' }), 'Scegli un’ora.');
  assert.equal(formProblem({ ...form, sources: [] }), 'Scegli almeno una cosa da mettere nel resoconto.');
});

test('the call (D-259): the channel on the card, the choices of the form, never Segreto', () => {
  assert.equal(channelText({ channel: 'chat', voiceMaxLabel: 'L2', retryMinutes: null }), 'in chat');
  assert.equal(channelText({ channel: 'call', voiceMaxLabel: 'L2', retryMinutes: null }), 'chiamata · titoli fino a Privato');
  assert.equal(channelText({ channel: 'call', voiceMaxLabel: 'L0', retryMinutes: 15 }), 'chiamata · titoli fino a Pubblico · richiama dopo 15 min');
  assert.deepEqual(CHANNEL_CHOICES.map((choice) => choice.label), ['In chat', 'Chiamata']);
  assert.deepEqual(VOICE_LABEL_CHOICES.map((choice) => choice.id), ['L0', 'L1', 'L2']);
  assert.equal(RETRY_CHOICES[0]?.minutes, null);
  assert.ok(RETRY_CHOICES.every((choice) => choice.minutes === null || (choice.minutes >= 5 && choice.minutes <= 60)));
  // A new routine is in the chat, Privato at most aloud, no second ring; the form keeps what the routine has.
  const form = emptyForm();
  assert.deepEqual([form.channel, form.voiceMaxLabel, form.retryMinutes], ['chat', 'L2', null]);
  const routine = { id: 'r', title: 'Mattina finta', conversationId: 'c', days: [1], at: '10:00', timezone: 'Europe/Rome', sources: ['todo'], dashboardTiles: null, summary: true, channel: 'call', voiceMaxLabel: 'L1', retryMinutes: 10, status: 'active', pausedBy: null, nextRunAt: null, createdAt: '', updatedAt: '', conversationArchived: false, lastRun: null } satisfies Routine;
  assert.deepEqual([formOf(routine).channel, formOf(routine).voiceMaxLabel, formOf(routine).retryMinutes], ['call', 'L1', 10]);
  assert.equal(RING_TEXT.routine, 'È l’ora della tua routine');
});

test('toggled keeps the order of the list', () => {
  assert.deepEqual(toggled([3, 1], 2, [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(toggled([1, 2, 3], 2, [1, 2, 3]), [1, 3]);
});

test('the refusals of the core in words, and the address of the page', () => {
  assert.equal(routineErrorText(404, 'x'), 'La routine non c’è più.');
  assert.equal(routineErrorText(500, 'fallback'), 'fallback');
  assert.ok(isRoutinesPath('/routine'));
  assert.ok(isRoutinesPath('/routine/'));
  assert.ok(!isRoutinesPath('/routines'));
});
