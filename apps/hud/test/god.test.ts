import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CARRY_PROPOSE_AGAIN, CARRY_PROPOSE_AT, carryOriginText, landBlocker, loadDeclined, proposeCarry, saveDeclined, cloneText, discussBlocker, discussTitle, godBlocker, plainItem, type GodStatus } from '../src/lib/god.ts';
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

function chat(count: number, last = 'assistant', from = 1): { id: string; role: string }[] {
  return Array.from({ length: count }, (_, index) => ({ id: String(from + index), role: index === count - 1 ? last : index % 2 === 0 ? 'user' : 'assistant' }));
}

test('proposeCarry: GOD proposes a restart only in a long chat it has answered, and again only after more messages', () => {
  assert.equal(proposeCarry(chat(CARRY_PROPOSE_AT - 1), null), false, 'a short chat');
  assert.equal(proposeCarry(chat(CARRY_PROPOSE_AT), null), true, 'a long chat');
  assert.equal(proposeCarry([...chat(CARRY_PROPOSE_AT - 1), { id: '999', role: 'system' }], null), false, 'system messages do not count');
  assert.equal(proposeCarry(chat(CARRY_PROPOSE_AT, 'user'), null), false, 'GOD is still answering');
  assert.equal(proposeCarry(chat(CARRY_PROPOSE_AT + 5), String(CARRY_PROPOSE_AT)), false, 'just said no');
  assert.equal(proposeCarry(chat(CARRY_PROPOSE_AT + CARRY_PROPOSE_AGAIN), String(CARRY_PROPOSE_AT)), true, 'enough messages after the no');
  assert.equal(proposeCarry(chat(100, 'assistant', 500), '480'), true, 'a chat loaded in part: the no is older than what is loaded');
  assert.equal(proposeCarry(chat(100, 'assistant', 500), '590'), false, 'a chat loaded in part: the no is recent');
});
test('the «No» to the proposal is remembered per conversation, and a missing or broken storage reads as none', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(loadDeclined(storage, 'c1'), null);
  saveDeclined(storage, 'c1', '42');
  assert.equal(loadDeclined(storage, 'c1'), '42');
  assert.equal(loadDeclined(storage, 'c2'), null, 'another conversation');
  values.set('arianna.god.carry.declined.c3', 'x');
  assert.equal(loadDeclined(storage, 'c3'), null, 'not a number');
  const broken = { getItem: (): string | null => { throw new Error('blocked'); }, setItem: (): void => { throw new Error('blocked'); } };
  assert.equal(loadDeclined(broken, 'c1'), null);
  assert.doesNotThrow(() => {
    saveDeclined(broken, 'c1', '42');
  });
  assert.equal(loadDeclined(undefined, 'c1'), null);
});

test('landBlocker: «Prova» and the others wait for an installation on main and clean, or a clean trial', () => {
  assert.equal(landBlocker(undefined), null, 'an older core');
  assert.equal(landBlocker({ branch: 'main', clean: true, trial: null }), null);
  assert.match(landBlocker({ branch: 'main', clean: false, trial: null }) ?? '', /modifiche non salvate/);
  assert.match(landBlocker({ branch: 'task/x', clean: true, trial: null }) ?? '', /sul ramo task\/x, non su main/);
  assert.match(landBlocker({ branch: '', clean: true, trial: null }) ?? '', /\(nessuno\)/, 'a detached head');
  const trial = 'prova/god-g003-x';
  assert.equal(landBlocker({ branch: trial, clean: true, trial }), null, 'a trial: approve or reject');
  assert.match(landBlocker({ branch: trial, clean: false, trial }) ?? '', /Nella prova/);
});
