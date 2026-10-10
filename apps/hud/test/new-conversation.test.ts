import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrowChoice, cloudNotice, SESSION_COPY } from '../src/lib/draft.ts';
import { agentDescription, agentTitle } from '../src/lib/italian.ts';

/** The window "Nuovo" (D-158): the pure parts of its look and its keys. */

test('the arrows move the choice of a radio group, round the corner; other keys do nothing', () => {
  const kinds = ['private', 'work', 'agent', 'incognito'] as const;
  assert.equal(arrowChoice(kinds, 'private', 'ArrowRight'), 'work');
  assert.equal(arrowChoice(kinds, 'work', 'ArrowDown'), 'agent');
  assert.equal(arrowChoice(kinds, 'incognito', 'ArrowRight'), 'private');
  assert.equal(arrowChoice(kinds, 'private', 'ArrowLeft'), 'incognito');
  assert.equal(arrowChoice(kinds, 'agent', 'ArrowUp'), 'work');
  assert.equal(arrowChoice(kinds, 'agent', 'Home'), 'private');
  assert.equal(arrowChoice(kinds, 'work', 'End'), 'incognito');
  assert.equal(arrowChoice(kinds, 'work', 'Enter'), undefined);
  assert.equal(arrowChoice(kinds, 'work', 'a'), undefined);
  assert.equal(arrowChoice([], 'x', 'ArrowRight'), undefined);
  // A choice not in the list: the first arrow lands on the first option, or the last going back.
  assert.equal(arrowChoice(['a', 'b'], 'gone', 'ArrowRight'), 'a');
  assert.equal(arrowChoice(['a', 'b'], 'gone', 'ArrowLeft'), 'b');
});

test('the cloud warning in three parts: a short title, one sentence, the rest in the details', () => {
  const notice = cloudNotice('reviewer', 'demo', ['codex', 'claude']);
  assert.equal(notice.title, 'Va a Codex (OpenAI) o Claude (Anthropic)');
  assert.match(notice.text, /Arianna non lo filtra/);
  assert.match(notice.details, /file del progetto demo/);
  assert.ok(notice.details.endsWith(SESSION_COPY));
  const bare = cloudNotice('coder', undefined);
  assert.equal(bare.title, 'Va a Claude (Anthropic)');
  assert.doesNotMatch(bare.details, /progetto/);
  assert.equal(bare.details, SESSION_COPY);
});

test('agent names start with a capital in the window, ids unchanged', () => {
  assert.equal(agentTitle('oroscopo'), 'Oroscopo');
  assert.equal(agentTitle('traduttore'), 'Traduttore');
  assert.equal(agentTitle('coder'), 'Coder');
  assert.equal(agentTitle('Già'), 'Già');
});

test('official cards described in Italian; a description the user changed stays as it is', () => {
  assert.equal(agentDescription('coder', 'Writes and changes code in a worktree, with tests'), 'Scrive e modifica il codice in un worktree, con i test');
  assert.equal(
    agentDescription('reviewer', 'Reviews changes and their tests in a project, without changing files'),
    'Rivede le modifiche e i loro test in un progetto, senza cambiare file',
  );
  assert.equal(agentDescription('coder', 'Il mio coder personale'), 'Il mio coder personale');
  assert.equal(agentDescription('traduttore', 'Writes and changes code in a worktree, with tests'), 'Writes and changes code in a worktree, with tests');
  assert.equal(agentDescription('toString', 'x'), 'x');
});
