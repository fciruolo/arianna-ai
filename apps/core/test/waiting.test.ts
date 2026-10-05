import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shortText, WAITING_QUESTION_MAX } from '../src/waiting.ts';

test('shortText keeps a short question as one line', () => {
  assert.equal(shortText('  Quale giorno\n preferisci?  '), 'Quale giorno preferisci?');
  assert.equal(shortText('a'.repeat(WAITING_QUESTION_MAX)), 'a'.repeat(WAITING_QUESTION_MAX));
});

test('shortText cuts a long question to the maximum, with an ellipsis, counting characters', () => {
  const cut = shortText('è'.repeat(WAITING_QUESTION_MAX + 1));
  assert.equal(Array.from(cut).length, WAITING_QUESTION_MAX);
  assert.ok(cut.endsWith('…'));
  assert.equal(shortText('uno   due', 5), 'uno…');
});
