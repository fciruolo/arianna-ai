import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloneText, godBlocker, type GodStatus } from '../src/lib/god.ts';
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

test('the address of the page of GOD', () => {
  assert.equal(GOD_PATH, '/god');
  assert.equal(isGodPath('/god'), true);
  assert.equal(isGodPath('/god/'), true);
  assert.equal(isGodPath('/goddess'), false);
});
