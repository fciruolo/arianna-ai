import assert from 'node:assert/strict';
import { test } from 'node:test';

import { goesToArianna } from '../src/lib/commands.ts';
import { draftFromAddress, draftPath, draftProjectProblem, draftStep, firstMessageProblem } from '../src/lib/draft.ts';

test('a draft has an address of its own, and a reload comes back to it', () => {
  assert.equal(draftPath('private'), '/nuova?tipo=privata');
  assert.equal(draftPath('work'), '/nuova?tipo=lavoro');
  assert.equal(draftPath('work', 'arianna'), '/nuova?tipo=lavoro&progetto=arianna');
  assert.equal(draftPath('private', 'arianna'), '/nuova?tipo=privata');
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=privata'), { mode: 'private' });
  assert.deepEqual(draftFromAddress('/nuova/', ''), { mode: 'private' });
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=strano'), { mode: 'private' });
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=lavoro'), { mode: 'work' });
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=lavoro&progetto=%20arianna%20'), { mode: 'work', project: 'arianna' });
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=lavoro&progetto='), { mode: 'work' });
  assert.equal(draftFromAddress('/', ''), undefined);
  assert.equal(draftFromAddress('/nuova/x', ''), undefined);
});

test('the first message of a draft is a text for Arianna, never empty nor a command', () => {
  assert.equal(firstMessageProblem('ciao', goesToArianna), undefined);
  assert.equal(firstMessageProblem('/etc/hosts è un file?', goesToArianna), undefined);
  assert.equal(firstMessageProblem('/ 2 fa 3', goesToArianna), undefined);
  assert.equal(firstMessageProblem('   ', goesToArianna), 'Scrivi il primo messaggio.');
  assert.match(firstMessageProblem('/nota comprare il pane', goesToArianna) ?? '', /dopo il primo messaggio/);
  assert.match(firstMessageProblem('/sconosciuto', goesToArianna) ?? '', /dopo il primo messaggio/);
});

test('the first "Invia" creates the conversation; a retry sends to the one already created', () => {
  assert.deepEqual(draftStep({ conversationId: null }), { kind: 'create' });
  assert.deepEqual(draftStep({ conversationId: 'c1' }), { kind: 'send', conversationId: 'c1' });
});

test('a work draft on a project no longer approved is said at once; otherwise nothing', () => {
  assert.match(draftProjectProblem({ mode: 'work', project: 'vecchio' }, ['arianna']) ?? '', /non è fra quelli approvati/);
  assert.equal(draftProjectProblem({ mode: 'work', project: 'arianna' }, ['arianna']), undefined);
  assert.equal(draftProjectProblem({ mode: 'work' }, ['arianna']), undefined);
  assert.equal(draftProjectProblem({ mode: 'private', project: 'vecchio' }, ['arianna']), undefined);
  // The list is not read yet: no warning that could be false.
  assert.equal(draftProjectProblem({ mode: 'work', project: 'vecchio' }, undefined), undefined);
});
