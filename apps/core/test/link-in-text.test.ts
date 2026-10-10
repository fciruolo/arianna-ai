// A link pasted as a thought (D-154): its header has no `url`, the address is in its text.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { linkInText } from '../src/capture.ts';
import { captureOf } from '../src/organize.ts';

test('the first http(s) address of a text, without the punctuation of the sentence', () => {
  assert.equal(linkInText('https://x.com/taylorotwell/status/2108305338566861245?s=46&t=abc'), 'https://x.com/taylorotwell/status/2108305338566861245?s=46&t=abc');
  assert.equal(linkInText('guarda questo: https://example.com/a. Poi ne parliamo'), 'https://example.com/a');
  assert.equal(linkInText('(vedi https://example.com/b)'), 'https://example.com/b');
  assert.equal(linkInText('nessun link qui'), undefined);
  assert.equal(linkInText('ftp://example.com/x e javascript:alert(1)'), undefined);
});

const ORGANIZED_THOUGHT = [
  '---',
  'label: L2',
  'source: capture:hud:aec6c353-9ad0-45d4-991a-86aa9f88657b',
  'captured_at: 2026-10-10T02:02:29+02:00',
  'captured_kind: thought',
  'kind: link',
  'status: organized',
  'title: "Link a post"',
  '---',
  '',
  '## Riassunto',
  '',
  'Link a un post.',
  '',
  '## Testo originale',
  '',
  'https://x.com/taylorotwell/status/2108305338566861245?s=46&t=xLACQ6',
  '',
].join('\n');

test('a thought organized as a link takes the address of its original text', () => {
  assert.equal(captureOf(ORGANIZED_THOUGHT)?.kept.url, 'https://x.com/taylorotwell/status/2108305338566861245?s=46&t=xLACQ6');
});

test('a note that is not a link takes no address from its text', () => {
  const idea = ORGANIZED_THOUGHT.replace('kind: link', 'kind: idea');
  assert.equal(captureOf(idea)?.kept.url, undefined);
});
