// Which agents that answer on the local model read the chat besides the
// brief (D-107, tappa B2, D-220): only within the clearance of the whole
// conversation, only in a conversation with Arianna.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readsChat } from '../src/orchestrator/chat-window.ts';

const arianna = { agent: null, secretary: false } as const;

test('an agent whose clearance covers the conversation reads the chat', () => {
  assert.equal(readsChat({ ...arianna, clearance: 'L1' }, 'L1'), true);
  assert.equal(readsChat({ ...arianna, clearance: 'L1' }, 'L2'), true);
  assert.equal(readsChat({ ...arianna, clearance: 'L0' }, 'L0'), true);
});

test('a conversation above the agent leaves it with the brief alone', () => {
  // A private conversation and an agent of the user (at most L1).
  assert.equal(readsChat({ ...arianna, clearance: 'L2' }, 'L1'), false);
  assert.equal(readsChat({ ...arianna, clearance: 'L1' }, 'L0'), false);
  assert.equal(readsChat({ ...arianna, clearance: 'L3' }, 'L2'), false);
});

test('never in a direct chat nor in the secretary’s conversation', () => {
  assert.equal(readsChat({ agent: 'coder', secretary: false, clearance: 'L1' }, 'L2'), false);
  assert.equal(readsChat({ agent: null, secretary: true, clearance: 'L1' }, 'L2'), false);
});
