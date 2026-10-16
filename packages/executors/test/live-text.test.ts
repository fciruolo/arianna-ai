import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JsonFieldStream, ThinkSplitter } from '../src/local/live-text.ts';

/** Feeds `text` in pieces of `size` characters, joining the pieces per key. */
function fields(text: string, size: number): { joined: Record<string, string>; stream: JsonFieldStream } {
  const stream = new JsonFieldStream();
  const joined: Record<string, string> = {};
  for (let at = 0; at < text.length; at += size) {
    for (const piece of stream.feed(text.slice(at, at + size))) joined[piece.key] = (joined[piece.key] ?? '') + piece.text;
  }
  return { joined, stream };
}

describe('JsonFieldStream (D-249)', () => {
  const answer = JSON.stringify({ thought: 'Cerco la nota "caparra"\npoi rispondo è ok 😀', action: 'reply', text: 'La caparra è di 500 €.' });

  it('gives the top-level string fields as they come, escapes split over pieces included', () => {
    for (const size of [1, 2, 3, 7, 1000]) {
      const { joined, stream } = fields(answer, size);
      assert.equal(joined.thought, 'Cerco la nota "caparra"\npoi rispondo è ok 😀', String(size));
      assert.equal(joined.text, 'La caparra è di 500 €.');
      assert.equal(stream.values.get('action'), 'reply');
    }
  });

  it('decodes \\u escapes and surrogate pairs split anywhere', () => {
    const raw = '{"thought":"a\\u00e8b\\ud83d\\ude00c\\/d\\\\e"}';
    for (const size of [1, 2, 5]) assert.equal(fields(raw, size).joined.thought, 'aèb😀c/d\\e', String(size));
  });

  it('never reports strings of nested objects or arrays, nor keys', () => {
    const raw = JSON.stringify({ thought: 'ok', action: 'call', tool: 'kb.search', arguments: { query: 'segreto', list: ['x', { text: 'no' }] }, after: 'yes' });
    const { joined, stream } = fields(raw, 3);
    assert.deepEqual(Object.keys(joined).sort(), ['action', 'after', 'thought', 'tool']);
    assert.equal(joined.after, 'yes');
    assert.equal(stream.values.has('query'), false);
    assert.equal(stream.values.has('text'), false);
  });

  it('is not thrown off by malformed text: the caller parses the whole answer at the end', () => {
    const stream = new JsonFieldStream();
    assert.doesNotThrow(() => stream.feed('not json "at all" } ] \\u12'));
    assert.deepEqual(stream.feed('{"thought":"x"'), [{ key: 'thought', text: 'x' }]);
  });
});

describe('ThinkSplitter (D-249)', () => {
  it('splits a <think> block from the answer, tags split over pieces included', () => {
    const whole = '<think>Ragiono un po\'.</think>Ecco la risposta.';
    for (const size of [1, 2, 4, 100]) {
      const split = new ThinkSplitter();
      const parts: string[] = [];
      for (let at = 0; at < whole.length; at += size) for (const piece of split.feed(whole.slice(at, at + size))) parts.push(`${piece.part}:${piece.text}`);
      for (const piece of split.end()) parts.push(`${piece.part}:${piece.text}`);
      assert.equal(split.thought, "Ragiono un po'.", String(size));
      assert.equal(split.text, 'Ecco la risposta.');
      assert.ok(parts.every((part) => !part.includes('think>')), String(size));
    }
  });

  it('leaves an answer without <think> as it is, a lone "<" included', () => {
    const split = new ThinkSplitter();
    split.feed('3 < 4 e <b>');
    split.end();
    assert.equal(split.text, '3 < 4 e <b>');
    assert.equal(split.thought, '');
  });
});
