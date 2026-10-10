// A link pasted as a thought (D-154): its header has no `url`, the address is in its text.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseLabelRules } from '@arianna/config';

import { linkInText } from '../src/capture.ts';
import { readNote } from '../src/notes.ts';
import { captureOf } from '../src/organize.ts';

test('the first http(s) address of a text, without the punctuation of the sentence', () => {
  assert.equal(linkInText('https://x.com/taylorotwell/status/2108305338566861245?s=46&t=abc'), 'https://x.com/taylorotwell/status/2108305338566861245?s=46&t=abc');
  assert.equal(linkInText('guarda questo: https://example.com/a. Poi ne parliamo'), 'https://example.com/a');
  assert.equal(linkInText('(vedi https://example.com/b)'), 'https://example.com/b');
  assert.equal(linkInText('**https://a.com/b**'), 'https://a.com/b');
  assert.equal(linkInText('«https://a.com/x»'), 'https://a.com/x');
  assert.equal(linkInText('https://a.com/x…'), 'https://a.com/x');
  assert.equal(linkInText('https://it.wikipedia.org/wiki/Roma_(città)'), 'https://it.wikipedia.org/wiki/Roma_(citt%C3%A0)');
  assert.equal(linkInText('(https://it.wikipedia.org/wiki/Roma_(città))'), 'https://it.wikipedia.org/wiki/Roma_(citt%C3%A0)');
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

test('the page of the note takes the address from the original text only, never from the summary', () => {
  const home = mkdtempSync(join(tmpdir(), 'arianna-link-'));
  try {
    mkdirSync(join(home, 'kb', 'inbox'), { recursive: true });
    const tricked = ORGANIZED_THOUGHT.replace('Link a un post.', 'Vedi anche https://evil.example/x per il resto.');
    writeFileSync(join(home, 'kb', 'inbox', 'a.md'), tricked);
    assert.equal(readNote(home, parseLabelRules(''), 'a.md').url, 'https://x.com/taylorotwell/status/2108305338566861245?s=46&t=xLACQ6');
    writeFileSync(join(home, 'kb', 'inbox', 'b.md'), tricked.replace(/## Testo originale[\s\S]*$/, ''));
    assert.equal(readNote(home, parseLabelRules(''), 'b.md').url, null);
    // Captured as a link, classified otherwise by the model: still the button, like the organizing.
    writeFileSync(join(home, 'kb', 'inbox', 'c.md'), ORGANIZED_THOUGHT.replace('captured_kind: thought', 'captured_kind: link').replace('kind: link', 'kind: idea'));
    assert.match(readNote(home, parseLabelRules(''), 'c.md').url ?? '', /^https:\/\/x\.com\//);
    // An idea that is neither: no button.
    writeFileSync(join(home, 'kb', 'inbox', 'd.md'), ORGANIZED_THOUGHT.replace('kind: link', 'kind: idea'));
    assert.equal(readNote(home, parseLabelRules(''), 'd.md').url, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a note that is not a link takes no address from its text', () => {
  const idea = ORGANIZED_THOUGHT.replace('kind: link', 'kind: idea');
  assert.equal(captureOf(idea)?.kept.url, undefined);
});
