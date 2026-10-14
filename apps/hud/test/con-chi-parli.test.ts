// «Con chi parli» (D-111, tappa B, D-212): how "+ Nuovo" names the local model and
// the plain chats, and why one cannot answer now.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudNotice, draftFromAddress, draftPath, localNote, offReason, PLAIN_DEFAULT_MODEL, PLAIN_MODELS, whoAnswers } from '../src/lib/draft.ts';
import { agentDescription, agentTitle } from '../src/lib/italian.ts';

test('the interlocutors have names of what they are, not their ids', () => {
  assert.equal(agentTitle('local-chat'), 'Modello locale');
  assert.equal(agentTitle('claude'), 'Claude');
  assert.equal(agentTitle('codex'), 'ChatGPT');
  assert.match(agentDescription('local-chat', 'Chats on the local model with the knowledge base read only; nothing leaves this computer'), /sola lettura/);
});

test('the local model says nothing leaves the Mac and the knowledge base is read only; another local agent keeps its note', () => {
  assert.match(localNote('local-chat'), /sola lettura: niente esce dal Mac/);
  assert.match(localNote('traduttore'), /^traduttore risponde con il modello locale/);
});

test('the plain chat with Claude warns that every message goes to Anthropic', () => {
  assert.equal(cloudNotice('claude', undefined, ['claude']).title, 'Va a Claude (Anthropic)');
});

test('the plain chat with Claude says Sonnet answers when no model is chosen, never the router', () => {
  assert.doesNotMatch(whoAnswers('claude', null, null), /router/);
  assert.match(whoAnswers('coder', null, null), /router/);
});

test('ChatGPT or Claude off say why: turned off or not running here (D-212)', () => {
  assert.match(offReason('codex'), /Codex è spento/);
  assert.doesNotMatch(offReason('codex'), /non c’è ancora/);
  assert.match(offReason('claude'), /spento/);
});

test('the plain chat with ChatGPT warns that every message goes to OpenAI, and Sol answers when no model is chosen (D-212)', () => {
  assert.equal(cloudNotice('codex', undefined, ['codex']).title, 'Va a Codex (OpenAI)');
  assert.equal(whoAnswers('codex', null, null), 'Risponde ChatGPT, con Codex Sol');
  assert.equal(whoAnswers('codex', 'astra', 'luna'), 'Risponde ChatGPT, con Codex Astra · ultima risposta: Codex Luna');
  assert.equal(PLAIN_DEFAULT_MODEL.codex, 'sol');
  assert.deepEqual(PLAIN_MODELS.codex, ['luna', 'sol', 'astra']);
  assert.equal(PLAIN_DEFAULT_MODEL.coder, undefined, 'the Coder has the router');
});

test('a draft with Claude or the local model has its address, and a reload comes back to it', () => {
  assert.equal(draftPath({ mode: 'work', agent: 'claude' }), '/nuova?con=claude&tipo=lavoro');
  assert.deepEqual(draftFromAddress('/nuova', '?con=local-chat&tipo=privata'), { mode: 'private', agent: 'local-chat' });
});
