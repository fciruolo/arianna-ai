// The follow-up of the Studio (I-20, D-185): font stacks of the samples, the
// style of a variant said in words, where "Ripristina" puts a deleted file.
// Every name here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DESIGNER_CARRY_AGAIN, DESIGNER_CARRY_AT, examplesCost, exampleState, fontStack, loadCarryDeclined, proposeDesignerCarry, restoredPath, saveCarryDeclined, variantDesignText } from '../src/lib/studio.ts';

test('a font stack quotes the names and keeps the generic family bare', () => {
  assert.equal(fontStack(['Lumen Display', 'Helvetica Neue', 'sans-serif']), '"Lumen Display", "Helvetica Neue", sans-serif');
  assert.equal(fontStack(['serif']), 'serif');
});

test('a font stack drops a name that could break out of the property', () => {
  assert.equal(fontStack(['x"; background: url(a)', 'Good Sans', 'monospace']), '"Good Sans", monospace');
  assert.equal(fontStack([]), 'sans-serif');
});

test('the style of a variant, by name, or not known', () => {
  const names = (slug: string): string | undefined => ({ lumen: 'Lumen' })[slug];
  const skills = (id: string): string | undefined => ({ 'a/b/web': 'Web design' })[id];
  assert.equal(variantDesignText({ style: 'lumen', skills: ['a/b/web', 'x/y/z'], at: '2026-10-12T10:00:00Z' }, names, skills), 'Fatta con stile Lumen · skill: Web design, x/y/z');
  assert.equal(variantDesignText({ style: null, skills: [], at: '2026-10-12T10:00:00Z' }, names, skills), 'Fatta con nessuno stile · nessuna skill');
  assert.match(variantDesignText(undefined, names, skills), /non noti/);
});

test('a deleted file goes back to the folder above, without the suffix of a second deletion', () => {
  assert.equal(restoredPath('mockups/eliminati/home-2.html'), 'mockups/home-2.html');
  assert.equal(restoredPath('docs/mockups/eliminati/home-2~1a2b3c4d.html'), 'docs/mockups/home-2.html');
});

test('only a file directly inside eliminati/ is restored', () => {
  assert.equal(restoredPath('mockups/home-2.html'), undefined);
  assert.equal(restoredPath('eliminati'), undefined);
  assert.equal(restoredPath('mockups/eliminati/vecchi/a.html'), undefined);
});

test('«Riparti» is proposed after an answer of the Designer with a heavy context', () => {
  assert.equal(proposeDesignerCarry(DESIGNER_CARRY_AT, 'assistant', null), true);
  assert.equal(proposeDesignerCarry(80, 'assistant', null), true);
});

test('«Riparti» is not proposed with a light context, while the user has the last word, or right after «No»', () => {
  assert.equal(proposeDesignerCarry(DESIGNER_CARRY_AT - 1, 'assistant', null), false);
  assert.equal(proposeDesignerCarry(80, 'user', null), false);
  assert.equal(proposeDesignerCarry(Number.NaN, 'assistant', null), false);
  assert.equal(proposeDesignerCarry(60, 'assistant', 55), false);
  assert.equal(proposeDesignerCarry(55 + DESIGNER_CARRY_AGAIN, 'assistant', 55), true);
});

test('the «No» is remembered per conversation, read back defensively', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.equal(loadCarryDeclined(storage, 'a'), null);
  saveCarryDeclined(storage, 'a', 57.4);
  assert.equal(loadCarryDeclined(storage, 'a'), 57);
  assert.equal(loadCarryDeclined(storage, 'b'), null);
  store.set('arianna.designer.carry.declined.c', 'molto');
  assert.equal(loadCarryDeclined(storage, 'c'), null);
  const broken = { getItem: () => { throw new Error('off'); }, setItem: () => { throw new Error('off'); } };
  assert.equal(loadCarryDeclined(broken, 'a'), null);
  saveCarryDeclined(broken, 'a', 60);
});

test('what a style card says of its example', () => {
  const status = { examples: { alfa: { sha256: 'a', at: 't', current: true }, beta: { sha256: 'b', at: 't', current: false } }, queue: ['gamma'], running: 'delta', failed: {}, stopped: null };
  assert.equal(exampleState(status, 'alfa'), 'ready');
  assert.equal(exampleState(status, 'beta'), 'old');
  assert.equal(exampleState(status, 'gamma'), 'queued');
  assert.equal(exampleState(status, 'delta'), 'running');
  assert.equal(exampleState(status, 'epsilon'), 'none');
  assert.equal(exampleState(null, 'alfa'), 'none');
});

test('the cost of the examples in words: within a session, or more sessions', () => {
  assert.equal(examplesCost(1), 'circa il 1% della sessione di 5 ore');
  assert.equal(examplesCost(40), 'circa il 40% della sessione di 5 ore');
  assert.equal(examplesCost(152), 'circa 152 punti di sessione (1,5 sessioni di 5 ore), che pesano anche sulla settimana');
  assert.equal(examplesCost(0), 'circa il 0% della sessione di 5 ore');
});
