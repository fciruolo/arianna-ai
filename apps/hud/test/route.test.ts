import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conversationFromPath,
  documentTitle,
  isNewAgentPath,
  isOfficePath,
  isSettingsPath,
  isThoughtsPath,
  NEW_AGENT_PATH,
  OFFICE_PATH,
  knowledgeFocus,
  knowledgePathFor,
  knowledgeSource,
  pathFor,
  THOUGHTS_PATH,
} from '../src/lib/route.ts';

const ID = '384fde7f-ba40-44cb-a3d1-64d4b09045aa';

test('a conversation path gives back its id, and the id gives back the path', () => {
  assert.equal(conversationFromPath(`/c/${ID}`), ID);
  assert.equal(conversationFromPath(`/c/${ID}/`), ID);
  assert.equal(conversationFromPath(`/c/${ID.toUpperCase()}`), ID);
  assert.equal(pathFor(ID), `/c/${ID}`);
  assert.equal(conversationFromPath(pathFor(ID)), ID);
  assert.equal(pathFor(null), '/');
});

test('any other path opens no conversation', () => {
  for (const path of ['/', '/c/', '/c/abc', `/c/${ID}/x`, `/x/${ID}`, `/c/${ID}x`, '/api/status', `/c/..%2F${ID}`]) {
    assert.equal(conversationFromPath(path), undefined, path);
  }
});

test('the tab shows the conversation title, or the name of the app', () => {
  assert.equal(documentTitle('Saluti di prova'), 'Saluti di prova · Arianna');
  assert.equal(documentTitle('  '), 'Arianna');
  assert.equal(documentTitle(null), 'Arianna');
  assert.equal(documentTitle(undefined), 'Arianna');
});

test('the thoughts page and the knowledge page with a node selected (D-090)', () => {
  assert.equal(isThoughtsPath(THOUGHTS_PATH), true);
  assert.equal(isThoughtsPath('/pensieri/'), true);
  assert.equal(isThoughtsPath('/pensieri/x'), false);
  const path = knowledgePathFor('inbox/2026 pane.md');
  assert.equal(path, '/conoscenza?nota=inbox%2F2026+pane.md');
  assert.equal(knowledgeFocus(path.slice(path.indexOf('?'))), 'inbox/2026 pane.md');
  assert.equal(knowledgeFocus(''), undefined);
  assert.equal(knowledgeFocus('?nota='), undefined);
});

test('the knowledge page of Arianna\'s own documents has its address, anything else is the notes (D-155)', () => {
  assert.equal(knowledgePathFor(), '/conoscenza');
  assert.equal(knowledgePathFor(undefined, 'arianna'), '/conoscenza?fonte=arianna');
  const path = knowledgePathFor('arianna/decisioni/D-145.md', 'arianna');
  assert.equal(path, '/conoscenza?fonte=arianna&nota=arianna%2Fdecisioni%2FD-145.md');
  const search = path.slice(path.indexOf('?'));
  assert.equal(knowledgeSource(search), 'arianna');
  assert.equal(knowledgeFocus(search), 'arianna/decisioni/D-145.md');
  assert.equal(knowledgeSource('?fonte=ARIANNA'), 'arianna');
  for (const other of ['', '?fonte=', '?fonte=kb', '?fonte=docs', '?nota=arianna%2Fx.md']) assert.equal(knowledgeSource(other), 'kb', other);
});

test('the office has its own address, and nothing else is the office', () => {
  assert.equal(OFFICE_PATH, '/ufficio');
  assert.equal(isOfficePath('/ufficio'), true);
  assert.equal(isOfficePath('/ufficio/'), true);
  for (const path of ['/', '/ufficio/x', '/uffici', `/c/${ID}`]) assert.equal(isOfficePath(path), false, path);
  assert.equal(conversationFromPath(OFFICE_PATH), undefined);
});

test('the page "Nuovo agente" has its own address, apart from the sections of the settings (D-119, tappa T3)', () => {
  assert.ok(isNewAgentPath(NEW_AGENT_PATH));
  assert.ok(isNewAgentPath(`${NEW_AGENT_PATH}/`));
  assert.equal(isSettingsPath(NEW_AGENT_PATH), false);
  for (const path of ['/impostazioni/agenti', '/impostazioni/agenti/nuovo/x', '/agenti/nuovo']) assert.equal(isNewAgentPath(path), false, path);
});
