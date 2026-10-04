import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conversationFromPath, documentTitle, pathFor } from '../src/lib/route.ts';

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
