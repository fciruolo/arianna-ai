// The links of "Apri" (D-117, tappa 3): a random token per project, for a while, the oldest dropped first.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOpenLinks, extensionOf, OPEN_LINK_MS, OPEN_TYPES, OPENABLE } from '../src/delegation-view.ts';

test('a link serves its project until it expires, then never again', () => {
  let time = 1_000;
  const links = createOpenLinks(() => time);
  const token = links.issue('sito');
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(links.issue('sito'), token);
  time += OPEN_LINK_MS - 1;
  assert.equal(links.repoOf(token), 'sito');
  time += 1;
  assert.equal(links.repoOf(token), undefined);
  assert.equal(links.repoOf('x'.repeat(32)), undefined);
});

test('beyond 100 links the oldest goes first', () => {
  const links = createOpenLinks(() => 0);
  const first = links.issue('primo');
  const second = links.issue('secondo');
  for (let index = 0; index < 99; index += 1) links.issue(`p${String(index)}`);
  assert.equal(links.repoOf(first), undefined);
  assert.equal(links.repoOf(second), 'secondo');
});

test('what "Apri" offers is a page or an image it also serves; no fonts nor module scripts', () => {
  for (const extension of OPENABLE) assert.ok(OPEN_TYPES[extension] !== undefined, extension);
  for (const extension of ['woff', 'woff2', 'mjs', 'md', 'env', '']) assert.equal(OPEN_TYPES[extension], undefined, extension);
  assert.equal(extensionOf('web/Index.HTML'), 'html');
  assert.equal(extensionOf('.env'), '');
  assert.equal(extensionOf('Makefile'), '');
});
