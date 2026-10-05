import assert from 'node:assert/strict';
import { test } from 'node:test';

import { goesToArianna } from '../src/lib/commands.ts';
import { asksBeforeClaude, choiceAgent, longMessageStep, draftFromAddress, draftPath, draftProjectProblem, draftStep, firstMessageProblem, LONG_TO_CLAUDE, sameChoice } from '../src/lib/draft.ts';

test('a draft has an address of its own, and a reload comes back to it', () => {
  assert.equal(draftPath({ mode: 'private' }), '/nuova?tipo=privata');
  assert.equal(draftPath({ mode: 'work' }), '/nuova?tipo=lavoro');
  assert.equal(draftPath({ mode: 'work', project: 'arianna' }), '/nuova?tipo=lavoro&progetto=arianna');
  assert.equal(draftPath({ mode: 'private', project: 'arianna' }), '/nuova?tipo=privata');
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

test('the direct chat with the Coder has its address, always on a project (D-111)', () => {
  assert.equal(draftPath({ mode: 'work', project: 'arianna', agent: 'coder' }), '/nuova?tipo=coder&progetto=arianna');
  // The Coder only in a work conversation: a private choice never says coder.
  assert.equal(draftPath({ mode: 'private', agent: 'coder' }), '/nuova?tipo=privata');
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=coder&progetto=arianna'), { mode: 'work', project: 'arianna', agent: 'coder' });
  // Without a project there is no direct chat: a plain work draft.
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=coder'), { mode: 'work' });
  assert.equal(sameChoice({ mode: 'work', project: 'a', agent: 'coder' }, { mode: 'work', project: 'a' }), false);
  assert.equal(sameChoice({ mode: 'work', project: 'a', agent: 'coder' }, { mode: 'work', project: 'a', agent: 'coder' }), true);
  assert.match(firstMessageProblem('/nota x', goesToArianna, 'coder') ?? '', /scrivi prima al Coder/);
});

test('a long message of the direct chat asks before it goes to Claude; elsewhere never', () => {
  const long = 'a'.repeat(LONG_TO_CLAUDE + 1);
  assert.equal(asksBeforeClaude('coder', long), true);
  assert.equal(asksBeforeClaude('coder', 'a'.repeat(LONG_TO_CLAUDE)), false);
  assert.equal(asksBeforeClaude(null, long), false);
  assert.equal(asksBeforeClaude(undefined, long), false);
});

test('the Coder needs a project: a blank one is a plain work draft', () => {
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=coder&progetto=%20'), { mode: 'work' });
  assert.equal(choiceAgent({ mode: 'work', project: 'sito', agent: 'coder' }), 'coder');
  assert.equal(choiceAgent({ mode: 'work', project: ' ', agent: 'coder' }), undefined);
  assert.equal(choiceAgent({ mode: 'work', agent: 'coder' }), undefined);
  assert.equal(choiceAgent({ mode: 'private', project: 'sito', agent: 'coder' }), undefined);
});

test('a long message asks once, waits while asking, and only the button sends it', () => {
  const long = 'a'.repeat(LONG_TO_CLAUDE + 1);
  assert.equal(longMessageStep('coder', long, true, { asking: false, confirmed: false }), 'ask');
  // Enter again, or a held key, while the question is open: nothing.
  assert.equal(longMessageStep('coder', long, true, { asking: true, confirmed: false }), 'wait');
  assert.equal(longMessageStep('coder', long, true, { asking: true, confirmed: true }), 'send');
  // A note or a command never goes to Claude: no question.
  assert.equal(longMessageStep('coder', long, false, { asking: false, confirmed: false }), 'send');
  assert.equal(longMessageStep('coder', 'breve', true, { asking: false, confirmed: false }), 'send');
  assert.equal(longMessageStep(null, long, true, { asking: false, confirmed: false }), 'send');
});
