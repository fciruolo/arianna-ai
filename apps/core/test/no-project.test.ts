import assert from 'node:assert/strict';
import { test } from 'node:test';

import { noProjectCase, noProjectError, noProjectReply } from '../src/orchestrator/delegate.ts';

// D-303: why the Coder does not work in this conversation, by its mode and its project.

test('a private conversation without a project: the Coder does not work here', () => {
  assert.equal(noProjectCase('private', undefined, undefined), 'private');
  const reply = noProjectReply('coder', 'private');
  assert.equal(
    reply,
    'Il Coder non lavora nelle conversazioni Private: lavora solo in una conversazione di Lavoro con un progetto. Per un lavoro sul codice apri «Nuova conversazione» → «Lavoro» e scegli il progetto; i dati Privati di questa conversazione restano qui e non escono dal computer.',
  );
  // The hint to add a project is not there: the project may well be configured.
  assert.doesNotMatch(reply, /arianna:init|Impostazioni/);
  assert.match(noProjectError('coder', 'private'), /^coder does not work in a private conversation: .*work conversation with the project$/);
});

test('a work conversation without a project: only then the hint to add one', () => {
  assert.equal(noProjectCase('work', undefined, undefined), 'work');
  const reply = noProjectReply('coder', 'work');
  assert.match(reply, /^Questa conversazione di Lavoro non ha un progetto, e il Coder lavora solo dentro un progetto approvato\./);
  assert.match(reply, /Impostazioni → Progetti \(o con `pnpm arianna:init --reconfigure`\)\.$/);
  assert.doesNotMatch(reply, /Private/);
  assert.match(noProjectError('coder', 'work'), /^this work conversation has no project/);
});

test('a work conversation whose project is not an approved work part (taken off the list, or not a git folder)', () => {
  assert.equal(noProjectCase('work', 'other', undefined), 'not-approved');
  assert.match(noProjectReply('coder', 'not-approved'), /^Il progetto di questa conversazione non è fra quelli approvati in cui il Coder può lavorare: /);
  assert.match(noProjectReply('coder', 'not-approved'), /Impostazioni → Progetti/);
  assert.match(noProjectError('coder', 'not-approved'), /^the project of this work conversation is not among the approved projects coder may open/);
});

test('an approved project: no refusal, in a work or a private conversation (D-055: the only project)', () => {
  assert.equal(noProjectCase('work', 'demo', 'demo'), undefined);
  assert.equal(noProjectCase('private', 'demo', 'demo'), undefined);
});

test('another agent is named by its id', () => {
  assert.match(noProjectReply('designer', 'private'), /^L’agente designer non lavora nelle conversazioni Private/);
  assert.match(noProjectReply('designer', 'work'), /e l’agente designer lavora solo/);
});
