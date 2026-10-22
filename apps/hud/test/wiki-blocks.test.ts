import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Editor } from '@tiptap/core';

import { BLOCK_KINDS, blockAt, canTransform, deleteBlock, duplicateBlock, kindOf, SLASH_ITEMS, slashItems, topBlocks, transformBlock } from '../src/lib/wiki-blocks.ts';
import { docToMarkdown, markdownToDoc, unknownTypes, wikiExtensions } from '../src/lib/wiki-editor.ts';

function editorWith(text: string): Editor {
  return new Editor({ element: null, extensions: wikiExtensions(), content: markdownToDoc(text) });
}

function posOf(editor: Editor, index: number): number {
  const block = topBlocks(editor.state.doc)[index];
  assert.ok(block !== undefined, `block ${String(index)}`);
  return block.pos;
}

test('«/» finds the blocks by their name or other words, accents or not (D-284)', () => {
  assert.equal(slashItems('').length, SLASH_ITEMS.length);
  assert.deepEqual(
    slashItems('tit').map((item) => item.id),
    ['heading1', 'heading2', 'heading3'],
  );
  assert.deepEqual(
    slashItems('h2').map((item) => item.id),
    ['heading2'],
  );
  assert.ok(slashItems('lista').some((item) => item.id === 'taskList'));
  assert.deepEqual(
    slashItems('tabella').map((item) => item.id),
    ['table'],
  );
  assert.ok(slashItems('[[').some((item) => item.id === 'citation'));
  assert.deepEqual(slashItems('immagine'), []);
  assert.deepEqual(slashItems('link'), []);
  // Only what the schema of D-282 has: nothing that loads or follows something.
  for (const item of SLASH_ITEMS) assert.doesNotMatch(item.id, /link|image|html|embed/i);
});

test('the handle turns a block into another kind, the Markdown follows (D-284)', () => {
  const editor = editorWith('Primo\n\n- uno\n- due\n\nUltimo');
  try {
    assert.ok(transformBlock(editor, posOf(editor, 0), 'heading2'));
    assert.match(docToMarkdown(editor.getJSON()), /^## Primo\n/);
    assert.ok(transformBlock(editor, posOf(editor, 1), 'orderedList'));
    assert.match(docToMarkdown(editor.getJSON()), /1\. uno\n2\. due/);
    assert.ok(transformBlock(editor, posOf(editor, 1), 'paragraph'));
    assert.doesNotMatch(docToMarkdown(editor.getJSON()), /^\s*(?:-|\d+\.) /m);
    assert.ok(transformBlock(editor, posOf(editor, 0), 'blockquote'));
    assert.match(docToMarkdown(editor.getJSON()), /^> Primo/m);
    const last = topBlocks(editor.state.doc).length - 1;
    assert.ok(transformBlock(editor, posOf(editor, last), 'taskList'));
    assert.match(docToMarkdown(editor.getJSON()), /- \[ \] Ultimo/);
    assert.ok(transformBlock(editor, posOf(editor, last), 'codeBlock'));
    assert.match(docToMarkdown(editor.getJSON()), /```\nUltimo\n```/);
    assert.deepEqual(unknownTypes(editor.getJSON()), []);
  } finally {
    editor.destroy();
  }
});

test('a table or a line stays as it is; a position inside a block is not a block (D-284)', () => {
  const editor = editorWith('Testo\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
  try {
    const [text, rule, table] = topBlocks(editor.state.doc);
    assert.ok(text !== undefined && rule !== undefined && table !== undefined);
    assert.equal(canTransform(rule.node), false);
    assert.equal(canTransform(table.node), false);
    assert.equal(kindOf(rule.node), null);
    assert.equal(kindOf(text.node), 'paragraph');
    const before = docToMarkdown(editor.getJSON());
    assert.equal(transformBlock(editor, rule.pos, 'heading1'), false);
    assert.equal(transformBlock(editor, table.pos, 'paragraph'), false);
    assert.equal(docToMarkdown(editor.getJSON()), before);
    assert.equal(blockAt(editor.state.doc, text.pos + 1), null);
    assert.equal(blockAt(editor.state.doc, -1), null);
    assert.equal(blockAt(editor.state.doc, editor.state.doc.content.size + 5), null);
  } finally {
    editor.destroy();
  }
});

test('«Duplica» puts the same block below, «Elimina» takes it away; the last block leaves a line to write on (D-284)', () => {
  const editor = editorWith('## Titolo\n\nUno [[inbox/nota-finta]]');
  try {
    assert.ok(duplicateBlock(editor, posOf(editor, 1)));
    assert.equal((docToMarkdown(editor.getJSON()).match(/Uno \[\[inbox\/nota-finta\]\]/g) ?? []).length, 2);
    assert.ok(deleteBlock(editor, posOf(editor, 0)));
    assert.doesNotMatch(docToMarkdown(editor.getJSON()), /Titolo/);
    assert.ok(deleteBlock(editor, posOf(editor, 0)));
    assert.ok(deleteBlock(editor, posOf(editor, 0)));
    assert.equal(editor.state.doc.childCount, 1);
    assert.equal(editor.state.doc.firstChild?.type.name, 'paragraph');
    assert.equal(deleteBlock(editor, 999), false);
  } finally {
    editor.destroy();
  }
});

test('«Trasforma in…» names every kind once', () => {
  assert.equal(new Set(BLOCK_KINDS.map((item) => item.kind)).size, BLOCK_KINDS.length);
});
