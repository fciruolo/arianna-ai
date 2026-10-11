import assert from 'node:assert/strict';
import { test } from 'node:test';

import { carryOriginText, cloneText, discussBlocker, discussTitle, godBlocker, plainItem, type GodStatus } from '../src/lib/god.ts';
import { GOD_PATH, isGodPath } from '../src/lib/route.ts';

const ready: GodStatus = {
  project: 'ok',
  workspace: 'arianna:main',
  container: 'repos/arianna',
  main: { path: 'repos/arianna/main', exists: true, branch: 'main', head: '0123456789abcdef', behind: 0, dirty: 0 },
  available: true,
  conversations: [],
};

test('a new conversation with GOD waits for the project, the clone and an executor, in this order', () => {
  assert.equal(godBlocker(ready), null);
  assert.match(godBlocker({ ...ready, project: 'missing' }) ?? '', /Impostazioni → Progetti, nome arianna, percorso repos\/arianna/);
  assert.match(godBlocker({ ...ready, project: 'wrong-path' }) ?? '', /deve puntare a repos\/arianna/);
  assert.match(godBlocker({ ...ready, main: { path: 'repos/arianna/main', exists: false } }) ?? '', /Crea il clone/);
  assert.match(godBlocker({ ...ready, main: { ...ready.main, refusal: 'il clone contiene data/vault' } }) ?? '', /data\/vault/);
  assert.match(godBlocker({ ...ready, available: false }) ?? '', /Claude o Codex/);
});

test('the line of the clone: branch, short commit, how far behind, files changed', () => {
  assert.equal(cloneText(ready.main), 'repos/arianna/main · ramo main · commit 0123456 · allineato al main dell’installazione');
  assert.equal(cloneText({ ...ready.main, behind: 3, dirty: 2 }), 'repos/arianna/main · ramo main · commit 0123456 · 3 commit indietro rispetto al main · 2 file cambiati');
  assert.equal(cloneText({ path: 'repos/arianna/main', exists: false }), 'repos/arianna/main: non c’è ancora.');
});

test('"Parlane con GOD" (I-6) is off, with the reason, until GOD can answer', () => {
  assert.equal(discussBlocker(ready), null);
  assert.match(discussBlocker(null) ?? '', /GOD non risponde/);
  assert.match(discussBlocker({ ...ready, project: 'missing' }) ?? '', /Impostazioni → Progetti/);
  assert.match(discussBlocker({ ...ready, main: { path: 'repos/arianna/main', exists: false } }) ?? '', /crealo dalla pagina GOD/);
  assert.match(discussBlocker({ ...ready, available: false }) ?? '', /Claude o Codex/);
});

test('the tooltip and the label of "Parlane con GOD"', () => {
  assert.equal(discussTitle('GOD non risponde.', false), 'GOD non risponde.');
  assert.match(discussTitle(null, false), /^Una conversazione nuova con GOD/);
  assert.doesNotMatch(discussTitle(null, false), /in main/);
  assert.match(discussTitle(null, true), /deve essere già in main/);
  assert.equal(plainItem('La **barra** con `quota.ts` e un [link](https://example.invalid) (D-127).'), 'La barra con quota.ts e un link (D-127).');
  assert.equal(plainItem('x'.repeat(100)).length, 80);
});

test('where a conversation with GOD starts from: an earlier one, or an entry of "Novità"', () => {
  assert.equal(carryOriginText({ body: 'x', from: 'a1b2', changelog: null }), 'Riparte da una conversazione precedente.');
  assert.equal(carryOriginText({ body: 'x', from: 'a1b2' }), 'Riparte da una conversazione precedente.', 'an older core');
  assert.equal(carryOriginText({ body: 'x', from: null, changelog: '0.65.0' }), 'Parte da una voce delle Novità, versione 0.65.0.');
  assert.equal(carryOriginText({ body: 'x', from: null, changelog: 'unreleased' }), 'Parte da una voce delle Novità non ancora rilasciata.');
});

test('the address of the page of GOD', () => {
  assert.equal(GOD_PATH, '/god');
  assert.equal(isGodPath('/god'), true);
  assert.equal(isGodPath('/god/'), true);
  assert.equal(isGodPath('/goddess'), false);
});
