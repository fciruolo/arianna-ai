import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatError, checkMessageBody, isUuid, MAX_MESSAGE_LENGTH, taskTitle } from '../src/conversations.ts';
import { chunk, notices } from '../src/reply.ts';

test('a message must have text and stay under the limit', () => {
  assert.equal(checkMessageBody('ciao'), 'ciao');
  for (const body of ['', '   \n', 42, undefined, null]) {
    assert.throws(() => checkMessageBody(body), ChatError, String(body));
  }
  assert.equal(checkMessageBody('x'.repeat(MAX_MESSAGE_LENGTH)).length, MAX_MESSAGE_LENGTH);
  assert.throws(() => checkMessageBody('x'.repeat(MAX_MESSAGE_LENGTH + 1)), ChatError);
});

test('the task title is the first line, cut on a character boundary', () => {
  assert.equal(taskTitle('  Prepara il riepilogo  \nsecond line'), 'Prepara il riepilogo');
  const long = taskTitle('😀'.repeat(200));
  assert.equal(Array.from(long).length, 80);
  assert.ok(long.endsWith('…'));
  assert.equal(taskTitle('a'.repeat(80)), 'a'.repeat(80));
});

test('fragments are split by code point, never inside a surrogate pair', () => {
  assert.deepEqual(chunk('abcde', 2), ['ab', 'cd', 'e']);
  assert.deepEqual(chunk('', 2), []);
  const pieces = chunk('😀😀😀', 2);
  assert.deepEqual(pieces, ['😀😀', '😀']);
  // The default size keeps a pg_notify payload under 8000 bytes even with 4-byte characters.
  for (const piece of chunk('😀'.repeat(4000))) assert.ok(Buffer.byteLength(piece) <= 6000);
});

test('ids are checked before reaching SQL', () => {
  assert.equal(isUuid('7d444840-9dc0-11d1-b245-5ffdce74fad2'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid("' OR 1=1 --"), false);
});

test('every notice stays under the pg_notify limit, even with characters JSON escapes', () => {
  const base = { replyId: 'r', conversationId: 'c', taskId: 't' };
  const text = '\u0001'.repeat(5000) + '\ud800'.repeat(10) + 'fine';
  const out = notices(text, base, 3);
  for (const json of out) assert.ok(Buffer.byteLength(json) <= 7000);
  const parsed = out.map((json) => JSON.parse(json) as { seq: number; text: string });
  assert.deepEqual(parsed.map((notice) => notice.seq), parsed.map((_notice, index) => 3 + index));
  assert.equal(parsed.map((notice) => notice.text).join(''), text);
});
