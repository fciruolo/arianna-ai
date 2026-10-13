import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executorText, isAddingLine, isEventLine, participantPose, removeText, stackOf, withoutParticipant, withText } from '../src/lib/participants.ts';
import type { Participant } from '../src/lib/types.ts';

const coder: Participant = { agent: 'coder', addedBy: 'arianna', addedAt: '2026-10-05T10:00:00.000Z', executor: 'claude' };
const translator: Participant = { agent: 'traduttore', addedBy: 'arianna', addedAt: '2026-10-05T10:05:00.000Z', executor: 'local' };

test('a system line with its task is an event of the chat; a system message without one, or any other, is not', () => {
  assert.equal(isEventLine({ role: 'system', taskId: 'a1' }), true);
  assert.equal(isEventLine({ role: 'system', taskId: null }), false);
  assert.equal(isEventLine({ role: 'assistant', taskId: 'a1' }), false);
  assert.equal(isEventLine({ role: 'user', taskId: 'a1' }), false);
});

test('only the line of Arianna bringing an agent in stands out among the events', () => {
  assert.equal(isAddingLine({ role: 'system', taskId: 'a1', body: 'Arianna aggiunge traduttore: Traduzione richiesta' }), true);
  assert.equal(isAddingLine({ role: 'system', taskId: 'a1', body: 'Arianna aggiunge Coder' }), true);
  assert.equal(isAddingLine({ role: 'system', taskId: 'a1', body: 'traduttore è stato aggiunto' }), false);
  assert.equal(isAddingLine({ role: 'system', taskId: 'a1', body: 'Hai tolto traduttore' }), false);
  assert.equal(isAddingLine({ role: 'system', taskId: null, body: 'Arianna aggiunge Coder' }), false);
  assert.equal(isAddingLine({ role: 'assistant', taskId: 'a1', body: 'Arianna aggiunge Coder' }), false);
});

test('the bar says where each agent works, and when it is no longer active', () => {
  assert.equal(executorText(coder), 'Claude Code');
  assert.equal(executorText(translator), 'modello locale');
  assert.equal(executorText({ executor: 'altro' }), 'altro');
  assert.equal(executorText({ executor: null }), 'non più attivo');
  assert.equal(removeText(coder), 'Togli Coder dalla conversazione');
  assert.equal(removeText(translator), 'Togli traduttore dalla conversazione');
});

test('taking one out leaves the others in order', () => {
  assert.deepEqual(withoutParticipant([coder, translator], 'coder'), [translator]);
  assert.deepEqual(withoutParticipant([coder, translator], 'revisore'), [coder, translator]);
});

test('a participant moves while the core says it works, else stands still', () => {
  assert.equal(participantPose('coder', [{ id: 'coder', state: 'working' }]), 'working');
  assert.equal(participantPose('coder', [{ id: 'coder', state: 'thinking' }]), 'thinking');
  assert.equal(participantPose('coder', [{ id: 'coder', state: 'waiting' }]), 'idle');
  assert.equal(participantPose('coder', [{ id: 'traduttore', state: 'working' }]), 'idle');
  assert.equal(participantPose('coder', undefined), 'idle');
});

test('the status line names who is in the chat, the first three and "+N" for the others (D-162)', () => {
  assert.equal(withText([]), '');
  assert.equal(withText([{ agent: 'designer' }]), 'con Designer');
  assert.equal(withText([{ agent: 'designer' }, { agent: 'coder' }]), 'con Designer, Coder');
  assert.equal(withText([{ agent: 'designer' }, { agent: 'coder' }, { agent: 'traduttore' }]), 'con Designer, Coder, traduttore');
  assert.equal(withText([{ agent: 'designer' }, { agent: 'coder' }, { agent: 'traduttore' }, { agent: 'a' }, { agent: 'b' }]), 'con Designer, Coder, traduttore +2');
  assert.equal(withText([{ agent: 'designer' }, { agent: 'coder' }], 1), 'con Designer +1');
});

test('the head shows the avatars one by one up to four, the rest behind "+N"; never a "+1" (D-162)', () => {
  assert.deepEqual(stackOf([]), { shown: [], hidden: [] });
  assert.deepEqual(stackOf([1, 2, 3]), { shown: [1, 2, 3], hidden: [] });
  assert.deepEqual(stackOf([1, 2, 3, 4, 5]), { shown: [1, 2, 3, 4, 5], hidden: [] });
  assert.deepEqual(stackOf([1, 2, 3, 4, 5, 6]), { shown: [1, 2, 3, 4], hidden: [5, 6] });
  assert.deepEqual(stackOf([1, 2, 3], 1), { shown: [1], hidden: [2, 3] });
});
