// The links of "Apri" (D-117, tappa 3): a random token per project, for a while, the oldest dropped first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { createOpenLinks, DelegationFileError, extensionOf, OPEN_LINK_MS, OPEN_TYPES, OPENABLE, readOpenFile } from '../src/delegation-view.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `open-links-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

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

test('a link of "Apri" never serves a secret, even through a link named like an image (D-135)', async () => {
  const root = join(HOME, 'repos', 'sito');
  mkdirSync(join(root, 'certs'), { recursive: true });
  writeFileSync(join(root, 'certs', 'server.key'), 'chiave finta\n');
  writeFileSync(join(root, 'logo-vero.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  symlinkSync('certs/server.key', join(root, 'logo.svg'));
  const projects = [{ name: 'sito', path: 'repos/sito', absolute: root, label: 'L1' as const }];
  const links = createOpenLinks();
  const token = links.issue('sito');
  assert.equal((await readOpenFile(projects, links, token, 'logo-vero.svg')).type, 'image/svg+xml');
  await assert.rejects(readOpenFile(projects, links, token, 'logo.svg'), (error) => error instanceof DelegationFileError && error.code === 'refused');
});
