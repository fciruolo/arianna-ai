import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadAnswer } from '@arianna/agents';

import { livelierReply } from '../src/orchestrator/orchestrator.ts';

const FIRST: ReadAnswer = { answer: { action: 'reply', text: 'Ciao.' }, thought: 'Saluto.' };

test('livelierReply (D-225): the second writing wins when it is a reply with a text', () => {
  const second: ReadAnswer = { answer: { action: 'reply', text: 'Ciao, novellino!' }, thought: 'Saluto da Cox.' };
  assert.equal(livelierReply(FIRST, second), second);
});

test('livelierReply (D-225): a tool, a refusal, an empty text or nothing keep the first reply', () => {
  const tool: ReadAnswer = { answer: { action: 'call', tool: 'kb.search', arguments: { query: 'contratto' } } };
  const refuse: ReadAnswer = { answer: { action: 'refuse', reason: 'No.' } };
  const empty: ReadAnswer = { answer: { action: 'reply', text: '  ' } };
  for (const second of [tool, refuse, empty, undefined]) assert.equal(livelierReply(FIRST, second), FIRST);
});
