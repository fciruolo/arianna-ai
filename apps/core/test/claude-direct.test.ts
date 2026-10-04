import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DIRECT_PROMPT, directBrief, directModelOf } from '../src/orchestrator/claude-direct.ts';

test('Claude answers directly only a work system chat with Sonnet or Opus chosen', () => {
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'sonnet' }), 'sonnet');
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'opus' }), 'opus');
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: null }), undefined, 'Arianna answers');
  assert.equal(directModelOf({ origin: 'system', mode: 'work', model: 'fable' }), undefined, 'never behind a budget approval');
  assert.equal(directModelOf({ origin: 'system', mode: 'private', model: 'sonnet' }), undefined, 'a private chat stays local');
  assert.equal(directModelOf({ origin: 'user', mode: 'work', model: 'sonnet' }), undefined, "in a user conversation the model is the Coder's");
  assert.equal(directModelOf(undefined), undefined);
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
