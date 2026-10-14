import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHAT_DEFAULT_MODEL, CHAT_PROMPT, DIRECT_PROMPT, directBrief, directModelOf, isPlainClaudeChat } from '../src/orchestrator/claude-direct.ts';

const ALL = ['sonnet', 'opus', 'fable', 'codex'];

test('Claude answers directly only a work system chat with Sonnet or Opus chosen', () => {
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'sonnet', agent: null, workspace: null }, ALL), 'sonnet');
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'opus', agent: null, workspace: null }, ALL), 'opus');
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: null, agent: null, workspace: null }, ALL), undefined, 'Arianna answers');
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'fable', agent: null, workspace: null }, ALL), undefined, 'never behind a budget approval');
  assert.equal(directModelOf({ origin: 'system', mode: 'private', model: 'sonnet', agent: null, workspace: null }, ALL), undefined, 'a private chat stays local');
  assert.equal(directModelOf({ origin: 'user', mode: 'work', model: 'sonnet', agent: null, workspace: null }, ALL), undefined, "in a user conversation the model is the Coder's");
  assert.equal(directModelOf({ origin: 'user', mode: 'work', model: 'sonnet', agent: 'coder', workspace: 'demo' }, ALL), undefined, 'the Coder answers on its chain');
  assert.equal(directModelOf(undefined, ALL), undefined);
});

test('a Claude model turned off in [cloud.models] leaves the answer to Arianna (D-071)', () => {
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'opus', agent: null, workspace: null }, ['sonnet', 'fable', 'codex']), undefined);
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'sonnet', agent: null, workspace: null }, ['sonnet']), 'sonnet');
});

test('the plain chat with Claude the user opened (D-111, tappa B): Sonnet when no model is chosen, Opus when chosen, never Fable nor in private', () => {
  const plain = { origin: 'user', mode: 'work', agent: 'claude', workspace: null } as const;
  assert.equal(directModelOf({ ...plain, model: null }, ALL), CHAT_DEFAULT_MODEL);
  assert.equal(CHAT_DEFAULT_MODEL, 'sonnet');
  assert.equal(directModelOf({ ...plain, model: 'opus' }, ALL), 'opus');
  assert.equal(directModelOf({ ...plain, model: 'fable' }, ALL), undefined);
  assert.equal(directModelOf({ ...plain, model: null }, ['opus']), undefined, 'Sonnet turned off: nobody answers');
  assert.equal(directModelOf({ ...plain, mode: 'private', model: null }, ALL), undefined);
  assert.equal(directModelOf({ ...plain, workspace: 'demo', model: null }, ALL), undefined, 'never on a project');
  assert.equal(directModelOf({ ...plain, agent: 'codex', model: null }, ALL), undefined);
  assert.equal(isPlainClaudeChat({ ...plain }), true);
  assert.equal(isPlainClaudeChat({ ...plain, origin: 'system' }), false);
});

test('the prompt of the plain chat is ours and says there are no tools', () => {
  assert.match(CHAT_PROMPT, /no tools/);
  assert.doesNotMatch(CHAT_PROMPT, /Riprova/);
});

test('the brief is the prompt at L0, then each message with who wrote it and its own label', () => {
  const brief = directBrief([
    { value: { role: 'user', content: '[Messaggio del sistema]\nCodice: local-model.unavailable' }, label: 'L1', source: 'message:1' },
    { value: { role: 'assistant', content: 'Controlla oMLX.' }, label: 'L0', source: 'message:2' },
  ]);
  assert.deepEqual(brief, [
    { text: DIRECT_PROMPT, label: 'L0', source: 'prompt:claude-direct' },
    { text: 'User:\n[Messaggio del sistema]\nCodice: local-model.unavailable', label: 'L1', source: 'message:1' },
    { text: 'Assistant:\nControlla oMLX.', label: 'L0', source: 'message:2' },
  ]);
  assert.equal(directBrief([], 'scenario: ok')[0]?.text, 'scenario: ok');
});
