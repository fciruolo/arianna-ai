import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findCommand } from '../src/lib/commands.ts';
import { isWikiNode, matchesView } from '../src/lib/graph.ts';
import { isWikiPath, WIKI_PATH } from '../src/lib/route.ts';
import {
  ancestorsOf,
  buildWikiTree,
  folderName,
  indexPath,
  isFolderPath,
  isPagePath,
  KIND_TEXT,
  pathProblem,
  tidyPath,
  versionText,
  wikiErrorText,
  dropDestination,
  dropFolder,
  movedPath,
  wikilinkTarget,
} from '../src/lib/wiki.ts';

test('page and folder paths as the core takes them (D-280)', () => {
  assert.equal(isPagePath('laravel/swoole'), true);
  assert.equal(isPagePath('laravel/octane/swoole'), true);
  assert.equal(isPagePath('laravel'), false);
  assert.equal(isPagePath('a/b/c/d'), false);
  assert.equal(isPagePath('Laravel/octane'), false);
  assert.equal(isPagePath('laravel/oc--tane'), false);
  assert.equal(isPagePath('laravel/_indice'), false);
  assert.equal(isFolderPath('laravel'), true);
  assert.equal(isFolderPath('laravel/octane'), true);
  assert.equal(isFolderPath('laravel/octane/swoole'), false);
  assert.equal(isFolderPath(''), false);
});

test('a typed path is tidied before it is checked', () => {
  assert.equal(tidyPath(' Laravel / Octane Più / Swoole '), 'laravel/octane-piu/swoole');
  assert.equal(tidyPath('//a//b/'), 'a/b');
  assert.equal(pathProblem('laravel/swoole', 'page'), undefined);
  assert.match(pathProblem('laravel', 'page') ?? '', /argomento\/articolo/);
  assert.equal(pathProblem('laravel', 'folder'), undefined);
  assert.match(pathProblem('a/b/c', 'folder') ?? '', /argomento/);
  assert.equal(pathProblem('', 'folder'), 'Scrivi un percorso.');
});

test('the tree: folders first, then pages, nested', () => {
  const tree = buildWikiTree(['laravel', 'laravel/octane', 'cucina'], [
    { path: 'laravel/octane/swoole', title: 'Swoole', updatedAt: '' },
    { path: 'laravel/code', title: 'Code', updatedAt: '' },
    { path: 'cucina/pane', title: 'Pane', updatedAt: '' },
  ]);
  assert.deepEqual(
    tree.map((node) => node.path),
    ['cucina', 'laravel'],
  );
  const laravel = tree[1];
  assert.deepEqual(
    laravel?.children.map((node) => [node.kind, node.path]),
    [
      ['folder', 'laravel/octane'],
      ['page', 'laravel/code'],
    ],
  );
  assert.equal(tree.at(1)?.children.at(0)?.children.at(0)?.name, 'Swoole');
  // A page whose folder was not listed still finds a place.
  assert.equal(buildWikiTree([], [{ path: 'a/b', title: 'B', updatedAt: '' }])[0]?.path, 'a');
});

test('names, indexes, ancestors and versions', () => {
  assert.equal(folderName('laravel/octane-swoole'), 'Octane swoole');
  assert.equal(folderName(''), 'Wiki');
  assert.equal(indexPath(''), '_indice');
  assert.equal(indexPath('laravel'), 'laravel/_indice');
  assert.deepEqual(ancestorsOf('a/b/c'), ['a', 'a/b']);
  assert.deepEqual(ancestorsOf('a'), []);
  assert.equal(versionText('2026-10-21T09:30:12'), '21/10/2026 09:30');
  assert.equal(KIND_TEXT.move, 'Spostamento');
});

test('a wikilink leads to a page of the Wiki or to a note in Conoscenza', () => {
  assert.deepEqual(wikilinkTarget('wiki/laravel/octane/_indice|Octane'), { wiki: 'laravel/octane/_indice' });
  assert.deepEqual(wikilinkTarget('wiki/laravel/swoole'), { wiki: 'laravel/swoole' });
  assert.deepEqual(wikilinkTarget('inbox/2026-10-21-nota'), { note: 'inbox/2026-10-21-nota.md' });
  assert.deepEqual(wikilinkTarget('archivio/private/casa/x.md'), { note: 'archivio/private/casa/x.md' });
});

test('errors of the core in Italian', () => {
  assert.match(wikiErrorText(409, 'expired: the page changed'), /cambiata dopo la proposta/);
  assert.match(wikiErrorText(409, 'exists: a page'), /C’è già/);
  assert.equal(wikiErrorText(404, 'not-found: proposal not found'), 'Non c’è più.');
  assert.match(wikiErrorText(500, 'boom'), /riprova/);
});

test('the graph: pages of the Wiki and «Solo Wiki»', () => {
  assert.equal(isWikiNode({ id: 'wiki/laravel/swoole.md', kind: 'wiki' }), true);
  assert.equal(isWikiNode({ id: 'inbox/x.md', kind: null }), false);
  assert.equal(isWikiNode({ id: 'wiki/x', kind: 'tag' }), false);
  const wiki = { id: 'wiki/laravel/swoole.md', title: 'Swoole', tags: [], kind: 'wiki' };
  const note = { id: 'inbox/x.md', title: 'Swoole', tags: [], kind: null };
  assert.equal(matchesView(wiki, '', true), true);
  assert.equal(matchesView(note, '', true), false);
  assert.equal(matchesView(note, 'swoole', false), true);
  assert.equal(matchesView(wiki, 'pane', true), false);
});

test('the page has its address and its command', () => {
  assert.equal(WIKI_PATH, '/wiki');
  assert.equal(isWikiPath('/wiki'), true);
  assert.equal(isWikiPath('/wiki/'), true);
  assert.equal(isWikiPath('/wikipedia'), false);
  assert.deepEqual(findCommand('wiki')?.action, { kind: 'open', page: 'wiki' });
});

test('a page the user wrote: what the core refuses, said in Italian with the line', () => {
  assert.match(wikiErrorText(400, 'invalid: line 3: citation'), /^Riga 3: la citazione/);
  assert.match(wikiErrorText(400, 'invalid: line 1: link'), /^Riga 1: niente link/);
  assert.match(wikiErrorText(400, 'invalid: line 1: header'), /intestazione/);
  assert.match(wikiErrorText(400, 'invalid: title'), /titolo/);
  assert.match(wikiErrorText(400, 'invalid: too-long'), /troppo lunga/);
  assert.match(wikiErrorText(400, 'invalid: the pages would go deeper than 3 levels'), /tre livelli/);
  assert.equal(wikiErrorText(400, 'invalid: something else'), 'Il percorso non va bene.');
});

test('dragging in the tree: where a page or folder lands, and when it cannot', () => {
  assert.deepEqual(dropDestination({ kind: 'page', path: 'laravel/octane/swoole' }, 'php'), { to: 'php/swoole' });
  assert.equal(dropDestination({ kind: 'page', path: 'laravel/swoole' }, 'laravel'), null);
  assert.ok('problem' in (dropDestination({ kind: 'page', path: 'laravel/swoole' }, '') ?? { to: '' }));
  assert.deepEqual(dropDestination({ kind: 'folder', path: 'laravel/octane' }, ''), { to: 'octane' });
  assert.deepEqual(dropDestination({ kind: 'folder', path: 'octane' }, 'laravel'), { to: 'laravel/octane' });
  assert.ok('problem' in (dropDestination({ kind: 'folder', path: 'laravel' }, 'laravel/octane') ?? { to: '' }));
  assert.ok('problem' in (dropDestination({ kind: 'folder', path: 'octane' }, 'laravel/server') ?? { to: '' }));
  assert.equal(dropFolder({ kind: 'page', path: 'laravel/octane/swoole' }), 'laravel/octane');
  assert.equal(dropFolder({ kind: 'folder', path: 'laravel' }), 'laravel');
  assert.equal(movedPath('laravel/octane/swoole', 'laravel/octane', 'php'), 'php/swoole');
  assert.equal(movedPath('laravel/swoole', 'laravel/swoole', 'php/swoole'), 'php/swoole');
  assert.equal(movedPath('laravelx/a', 'laravel', 'php'), 'laravelx/a');
});
