import assert from 'node:assert/strict';
import { test } from 'node:test';

import { citationMarkdown, citationText, docToMarkdown, markdownToDoc, unknownTypes } from '../src/lib/wiki-editor.ts';

const PAGE = [
  '## In breve',
  '',
  'Testo con **grassetto**, *corsivo*, ~~barrato~~, `codice` e [[inbox/2026-10-21-x|la nota]] e [[wiki/laravel/swoole]].',
  '',
  '- uno',
  '- due [[inbox/y]]',
  '',
  '1. primo',
  '2. secondo',
  '',
  '> citazione',
  '',
  '```',
  'codice',
  '```',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

test('a page goes into the editor and back to the same Markdown, citations included', () => {
  const doc = markdownToDoc(PAGE);
  assert.deepEqual(unknownTypes(doc), []);
  const back = docToMarkdown(doc);
  for (const piece of ['## In breve', '**grassetto**', '*corsivo*', '~~barrato~~', '`codice`', '[[inbox/2026-10-21-x|la nota]]', '[[wiki/laravel/swoole]]', '- due [[inbox/y]]', '1. primo', '2. secondo', '> citazione', '```\ncodice\n```', '| --- | --- |']) {
    assert.ok(back.includes(piece), piece);
  }
  // Stable: once through the editor, the text does not change again.
  assert.equal(docToMarkdown(markdownToDoc(back)), back);
});

test('a citation is one piece with its target and label', () => {
  const doc = markdownToDoc('Vedi [[inbox/nota|la nota finta]] e [[wiki/laravel/octane/swoole]].');
  const nodes = doc.content?.[0]?.content ?? [];
  const citations = nodes.filter((node) => node.type === 'wikiCitation').map((node) => node.attrs);
  assert.deepEqual(citations, [
    { target: 'inbox/nota', label: 'la nota finta' },
    { target: 'wiki/laravel/octane/swoole', label: null },
  ]);
  assert.equal(citationText({ target: 'inbox/nota', label: 'la nota finta' }), 'la nota finta');
  assert.equal(citationText({ target: 'wiki/laravel/octane/swoole', label: null }), 'swoole');
  assert.equal(citationMarkdown({ target: 'inbox/nota', label: null }), '[[inbox/nota]]');
});

test('the editor has no link, image or HTML: they stay text, and an address stays for the core to refuse', () => {
  const doc = markdownToDoc('Un [link](https://esempio.invalid/?q=1) e ![img](x.png) e <img src=x> e https://nudo.invalid.');
  assert.deepEqual(unknownTypes(doc), []);
  const back = docToMarkdown(doc);
  assert.doesNotMatch(back, /\]\(|!\[|<img/);
  assert.doesNotMatch(back, /esempio\.invalid\/\?q=1/);
  // A bare address is kept as text: the save refuses it with its line, as in the plain editor.
  assert.match(back, /https:\/\/nudo\.invalid/);
});

test('an address the pages proposed wrote inert stays inert', () => {
  const back = docToMarkdown(markdownToDoc('Il sito è https[://]esempio.invalid/guida.'));
  assert.doesNotMatch(back, /(?<!\[):\/\//);
});
