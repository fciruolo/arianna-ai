import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Editor, type JSONContent } from '@tiptap/core';

import { citationMarkdown, citationText, cursorInCell, docToMarkdown, flattenCells, markdownToDoc, plainEntities, unknownTypes, WikiCellLines, wikiExtensions, withoutEmptyParagraphs } from '../src/lib/wiki-editor.ts';

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
  assert.doesNotMatch(back, /\]\(|!\[/);
  // HTML stays text in the editor; written back it is a tag again, which the save refuses with its line.
  assert.match(back, /<img src=x>/);
  assert.doesNotMatch(back, /esempio\.invalid\/\?q=1/);
  // A bare address is kept as text: the save refuses it with its line, as in the plain editor.
  assert.match(back, /https:\/\/nudo\.invalid/);
});

test('an address the pages proposed wrote inert stays inert', () => {
  const back = docToMarkdown(markdownToDoc('Il sito è https[://]esempio.invalid/guida.'));
  assert.doesNotMatch(back, /(?<!\[):\/\//);
});

test('the text keeps its characters: no entity in what is saved, except inside fenced code', () => {
  const back = docToMarkdown(markdownToDoc('R&D e a < b, "virgolette" e l\'apostrofo.'));
  assert.match(back, /R&D e a < b, "virgolette" e l'apostrofo\./);
  assert.doesNotMatch(back, /&amp;|&lt;|&quot;|&#39;/);
  assert.equal(plainEntities('```\n&amp;\n```\n&amp;'), '```\n&amp;\n```\n&');
  // Code keeps what the user wrote: spans, and fences inside a quote or a list.
  assert.equal(plainEntities('Scrivi `&lt;b&gt;` e `usa &amp;` ma R&amp;D'), 'Scrivi `&lt;b&gt;` e `usa &amp;` ma R&D');
  assert.equal(plainEntities('> ```\n> &amp;\n> ```\n- ```\n  &lt;\n  ```\n&lt;'), '> ```\n> &amp;\n> ```\n- ```\n  &lt;\n  ```\n<');
  const code = docToMarkdown(markdownToDoc('Scrivi `&lt;b&gt;` nel codice e `a & b`.'));
  assert.match(code, /`&lt;b&gt;`/);
  // HTML written as text becomes a tag again: the save refuses it with its line, as in the plain editor.
  assert.match(docToMarkdown(markdownToDoc('Scrivo <b>forte</b>.')), /<b>forte<\/b>/);
});

test('to-do lists and a citation with a label inside a table go and come back', () => {
  const back = docToMarkdown(markdownToDoc('- [ ] da fare\n- [x] fatto [[inbox/nota]]\n\n| a | b |\n| --- | --- |\n| [[inbox/x\\|La X]] | 2 |'));
  assert.match(back, /- \[ \] da fare/);
  assert.match(back, /- \[x\] fatto \[\[inbox\/nota\]\]/);
  assert.match(back, /\[\[inbox\/x\\?\|La X\]\]/);
});

const TABLE = '| Ingrediente | Quantità |\n| --- | --- |\n| Farina | 500 g |\n\nfine';

/** The cell «500 g» of TABLE with a line break, or a second paragraph, and a citation after it. */
function withBreak(kind: 'hardBreak' | 'paragraph'): JSONContent {
  const doc = markdownToDoc(TABLE);
  const cell = doc.content?.[0]?.content?.[1]?.content?.[1];
  assert.ok(cell !== undefined);
  const after: JSONContent[] = [{ type: 'text', text: 'Collegata a ' }, { type: 'wikiCitation', attrs: { target: 'wiki/laravel/octane', label: null } }];
  cell.content =
    kind === 'hardBreak'
      ? [{ type: 'paragraph', content: [{ type: 'text', text: '500 g' }, { type: 'hardBreak' }, ...after] }]
      : [{ type: 'paragraph', content: [{ type: 'text', text: '500 g' }] }, { type: 'paragraph', content: after }];
  return doc;
}

test('a line break or a second paragraph in a table cell goes back to Markdown as a space, never as <br> (D-282)', () => {
  for (const kind of ['hardBreak', 'paragraph'] as const) {
    const back = docToMarkdown(withBreak(kind));
    assert.ok(!back.includes('<br'), `${kind}: ${back}`);
    assert.match(back, /\| Farina +\| 500 g Collegata a \[\[wiki\/laravel\/octane\]\] +\|/, kind);
  }
});

test('flattening the cells leaves a line break outside a table as it is', () => {
  const doc: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'uno' }, { type: 'hardBreak' }, { type: 'text', text: 'due' }] }] };
  assert.deepEqual(flattenCells(doc), doc);
  assert.match(docToMarkdown(doc), /uno {2}\ndue/);
});

test('Enter, Shift+Enter and Mod+Enter add no line inside a table cell, and work as usual outside it (D-282)', () => {
  const editor = new Editor({ element: null, extensions: wikiExtensions(), content: markdownToDoc(TABLE) });
  try {
    const add = WikiCellLines.config.addKeyboardShortcuts;
    assert.ok(add !== undefined);
    const keys = (add as unknown as (this: { editor: Editor }) => Record<string, () => boolean>).call({ editor });
    assert.deepEqual(Object.keys(keys).sort(), ['Enter', 'Mod-Enter', 'Shift-Enter']);
    editor.commands.setTextSelection(5);
    assert.equal(cursorInCell(editor), true);
    for (const key of Object.values(keys)) assert.equal(key(), true);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    assert.equal(cursorInCell(editor), false);
    for (const key of Object.values(keys)) assert.equal(key(), false);
  } finally {
    editor.destroy();
  }
});

test('an empty paragraph before a table is not written as &nbsp;, text and the table stay (D-282)', () => {
  const cell = (text: string) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph' },
      { type: 'table', content: [{ type: 'tableRow', content: [cell('Farina'), cell('500 g')] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '  ' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Ricetta del pane.' }] },
    ],
  };
  const out = docToMarkdown(doc);
  assert.ok(!out.includes('&nbsp;'), out);
  assert.ok(out.includes('Farina') && out.includes('500 g') && out.includes('Ricetta del pane.'), out);
  // A paragraph with text is never dropped.
  const kept = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Testo' }] }] };
  assert.deepEqual(withoutEmptyParagraphs(kept), kept);
  // A line break or a citation alone is content: kept. An empty paragraph inside a quote goes too.
  const breakOnly = { type: 'paragraph', content: [{ type: 'hardBreak' }] };
  const citationOnly = { type: 'paragraph', content: [{ type: 'wikiCitation', attrs: { target: 'wiki/laravel/octane' } }] };
  const quote = { type: 'blockquote', content: [{ type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'Citata' }] }] };
  assert.deepEqual(withoutEmptyParagraphs({ type: 'doc', content: [breakOnly, citationOnly, quote] }), {
    type: 'doc',
    content: [breakOnly, citationOnly, { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Citata' }] }] }],
  });
});
