import assert from 'node:assert/strict';
import { test } from 'node:test';

import { goesToArianna } from '../src/lib/commands.ts';
import { asksBeforeClaude, choiceAgent, cloudTargets, cloudWarning, longMessageStep, draftFromAddress, draftPath, draftProjectProblem, draftStep, firstMessageProblem, LONG_TO_CLAUDE, providerText, sameChoice, shortTarget } from '../src/lib/draft.ts';

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

test('the direct chat with an agent has its address (D-111d); the old address of the Coder still opens it', () => {
  assert.equal(draftPath({ mode: 'work', project: 'arianna', agent: 'coder' }), '/nuova?con=coder&tipo=lavoro&progetto=arianna');
  assert.equal(draftPath({ mode: 'private', agent: 'traduttore' }), '/nuova?con=traduttore&tipo=privata');
  assert.deepEqual(draftFromAddress('/nuova', '?con=traduttore&tipo=privata'), { mode: 'private', agent: 'traduttore' });
  assert.deepEqual(draftFromAddress('/nuova', '?con=coder&tipo=lavoro&progetto=arianna'), { mode: 'work', project: 'arianna', agent: 'coder' });
  assert.deepEqual(draftFromAddress('/nuova', '?tipo=coder&progetto=arianna'), { mode: 'work', project: 'arianna', agent: 'coder' });
  // Never Arianna, never an id the core would refuse.
  assert.deepEqual(draftFromAddress('/nuova', '?con=arianna&tipo=privata'), { mode: 'private' });
  assert.deepEqual(draftFromAddress('/nuova', '?con=Bad%20Name&tipo=lavoro'), { mode: 'work' });
  assert.equal(choiceAgent({ mode: 'private', agent: 'traduttore' }), 'traduttore');
  assert.equal(choiceAgent({ mode: 'work', agent: 'arianna' }), undefined);
  assert.equal(sameChoice({ mode: 'work', project: 'a', agent: 'coder' }, { mode: 'work', project: 'a' }), false);
  assert.equal(sameChoice({ mode: 'work', project: 'a', agent: 'coder' }, { mode: 'work', project: 'a', agent: 'coder' }), true);
  assert.match(firstMessageProblem('/nota x', goesToArianna, 'coder') ?? '', /scrivi prima al Coder/);
  assert.match(firstMessageProblem('/nota x', goesToArianna, 'traduttore') ?? '', /scrivi prima a traduttore/);
});

test('a long message of the direct chat asks before it goes to Claude; on the local model never', () => {
  const long = 'a'.repeat(LONG_TO_CLAUDE + 1);
  assert.equal(asksBeforeClaude(true, long), true);
  assert.equal(asksBeforeClaude(true, 'a'.repeat(LONG_TO_CLAUDE)), false);
  assert.equal(asksBeforeClaude(false, long), false);
});

test('a long message asks once, waits while asking, and only the button sends it', () => {
  const long = 'a'.repeat(LONG_TO_CLAUDE + 1);
  assert.equal(longMessageStep(true, long, true, { asking: false, confirmed: false }), 'ask');
  // Enter again, or a held key, while the question is open: nothing.
  assert.equal(longMessageStep(true, long, true, { asking: true, confirmed: false }), 'wait');
  assert.equal(longMessageStep(true, long, true, { asking: true, confirmed: true }), 'send');
  // A note or a command never goes to Claude: no question.
  assert.equal(longMessageStep(true, long, false, { asking: false, confirmed: false }), 'send');
  assert.equal(longMessageStep(true, 'breve', true, { asking: false, confirmed: false }), 'send');
  assert.equal(longMessageStep(false, long, true, { asking: false, confirmed: false }), 'send');
});

test('where the messages of a direct chat go: the chosen model, else what the router picks from (D-140)', () => {
  // The model is a preference: with both executors on, the warning names both, the chosen one first.
  assert.deepEqual(cloudTargets(['claude', 'codex'], 'codex'), ['codex', 'claude']);
  assert.deepEqual(cloudTargets(['claude', 'codex'], 'opus'), ['claude', 'codex']);
  assert.deepEqual(cloudTargets(['codex'], 'codex'), ['codex']);
  assert.deepEqual(cloudTargets(['claude'], 'codex'), ['claude'], 'a model whose executor does not run here is not a target');
  assert.deepEqual(cloudTargets(['codex', 'claude'], null), ['codex', 'claude']);
  assert.deepEqual(cloudTargets(undefined, null), ['claude'], 'an older core says nothing: Claude, as before');
  assert.equal(providerText(['claude', 'codex']), 'Claude (Anthropic) o Codex (OpenAI)');
  assert.equal(shortTarget(['codex']), 'Codex');
  assert.match(cloudWarning('reviewer', 'demo', ['codex']), /^Ogni messaggio va così com'è a Codex \(OpenAI\), insieme ai file del progetto demo/);
  assert.match(cloudWarning('coder', undefined), /a Claude \(Anthropic\)\. Arianna non lo filtra/);
  assert.match(cloudWarning('coder', undefined, ['codex']), /Claude Code e Codex tengono una copia della sessione/);
});
