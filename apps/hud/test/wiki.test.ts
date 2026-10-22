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
  isEmptyFolder,
  dropFolder,
  movedPath,
  wikilinkTarget,
  breadcrumb,
  citationOf,
  clampTreeWidth,
  copyPath,
  copyTitle,
  folderOf,
  moveChoices,
  newItemPath,
  renamedFolder,
  sessionToken,
  TREE_WIDTH,
  treeMenu,
  sameLinesText,
  wikiDiffRows,
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
  assert.equal(dropDestination({ kind: 'folder', path: 'laravel' }, 'laravel'), null);
  assert.ok('problem' in (dropDestination({ kind: 'folder', path: 'octane' }, 'laravel/server') ?? { to: '' }));
  assert.equal(dropFolder({ kind: 'page', path: 'laravel/octane/swoole' }), 'laravel/octane');
  assert.equal(dropFolder({ kind: 'folder', path: 'laravel' }), 'laravel');
  assert.equal(movedPath('laravel/octane/swoole', 'laravel/octane', 'php'), 'php/swoole');
  assert.equal(movedPath('laravel/swoole', 'laravel/swoole', 'php/swoole'), 'php/swoole');
  assert.equal(movedPath('laravelx/a', 'laravel', 'php'), 'laravelx/a');
});

test('an empty folder: no page and no sub-folder below it', () => {
  const folders = ['cucina', 'laravel', 'laravel/octane'];
  const pages = [{ path: 'laravel/octane/swoole' }];
  assert.equal(isEmptyFolder('cucina', folders, pages), true);
  assert.equal(isEmptyFolder('laravel', folders, pages), false);
  assert.equal(isEmptyFolder('laravel/octane', folders, pages), false);
  assert.equal(isEmptyFolder('', folders, pages), false);
  assert.equal(isEmptyFolder('nessuna', folders, pages), false);
});

test('the tree on the side keeps a width it may have (D-284)', () => {
  assert.equal(clampTreeWidth(300), 300);
  assert.equal(clampTreeWidth('320'), 320);
  assert.equal(clampTreeWidth(50), TREE_WIDTH.min);
  assert.equal(clampTreeWidth(9000), TREE_WIDTH.max);
  for (const bad of [null, undefined, '', 'largo', Number.NaN, {}]) assert.equal(clampTreeWidth(bad), TREE_WIDTH.start);
});

test('the path on top: Wiki › Laravel › Octane, each a folder to open (D-284)', () => {
  assert.deepEqual(breadcrumb('laravel/octane/swoole'), [
    { text: 'Wiki', folder: '' },
    { text: 'Laravel', folder: 'laravel' },
    { text: 'Octane', folder: 'laravel/octane' },
  ]);
  assert.deepEqual(breadcrumb('laravel/_indice'), [
    { text: 'Wiki', folder: '' },
    { text: 'Laravel', folder: 'laravel' },
  ]);
  assert.deepEqual(breadcrumb('_indice'), [{ text: 'Wiki', folder: '' }]);
  assert.equal(folderOf('laravel/octane/swoole'), 'laravel/octane');
  assert.equal(folderOf('laravel/_indice'), 'laravel');
  assert.equal(folderOf('_indice'), '');
});

test('the menu of the tree: what it offers, and what it shows off with the reason (D-284)', () => {
  const ids = (items: { id: string }[]): string[] => items.map((item) => item.id);
  assert.deepEqual(ids(treeMenu(null)), ['new-page', 'new-folder']);
  const page = treeMenu({ kind: 'page', path: 'laravel/swoole' });
  assert.deepEqual(ids(page), ['new-page', 'new-folder', 'rename', 'move', 'duplicate', 'cite', 'delete']);
  assert.equal(page.find((item) => item.id === 'new-folder')?.off, undefined);
  // A page three levels down, a folder two: no folder below them.
  assert.match(treeMenu({ kind: 'page', path: 'laravel/octane/swoole' }).find((item) => item.id === 'new-folder')?.off ?? '', /tre livelli|sotto-argomento/);
  assert.notEqual(treeMenu({ kind: 'folder', path: 'laravel/octane' }).find((item) => item.id === 'new-folder')?.off, undefined);
  assert.equal(treeMenu({ kind: 'folder', path: 'laravel' }).find((item) => item.id === 'new-folder')?.off, undefined);
  // A folder: no «Duplica»; «Elimina» only when it is empty.
  const full = treeMenu({ kind: 'folder', path: 'laravel' }, false);
  assert.equal(full.some((item) => item.id === 'duplicate'), false);
  assert.match(full.find((item) => item.id === 'delete')?.off ?? '', /non è vuota/);
  assert.equal(treeMenu({ kind: 'folder', path: 'laravel' }, true).find((item) => item.id === 'delete')?.off, undefined);
  assert.equal(page.find((item) => item.id === 'delete')?.danger, true);
});

test('«Copia citazione» writes what the core accepts in a page (D-284)', () => {
  assert.equal(citationOf({ kind: 'page', path: 'laravel/octane/swoole' }), '[[wiki/laravel/octane/swoole]]');
  assert.equal(citationOf({ kind: 'folder', path: 'laravel' }), '[[wiki/laravel/_indice]]');
});

test('a name typed in the tree makes a path the core takes, or says why not (D-284)', () => {
  assert.deepEqual(newItemPath('laravel', 'Code e Horizon', 'page'), { path: 'laravel/code-e-horizon', title: 'Code e Horizon' });
  assert.deepEqual(newItemPath('', 'Docker/Volumi e reti', 'page'), { path: 'docker/volumi-e-reti', title: 'Volumi e reti' });
  assert.deepEqual(newItemPath('laravel', 'Octane', 'folder'), { path: 'laravel/octane', title: 'Octane' });
  assert.deepEqual(newItemPath('', 'Più città', 'folder'), { path: 'piu-citta', title: 'Più città' });
  // Negative: a page at the root, too deep, nothing typed.
  assert.ok('problem' in newItemPath('', 'Solo un titolo', 'page'));
  assert.match((newItemPath('laravel/octane', 'Altra', 'folder') as { problem: string }).problem, /tre livelli/);
  assert.match((newItemPath('laravel/octane', 'x/y', 'page') as { problem: string }).problem, /tre livelli/);
  assert.ok('problem' in newItemPath('laravel', '   ', 'page'));
  assert.ok('problem' in newItemPath('laravel', 'Cartella/', 'page'));
  assert.ok('problem' in newItemPath('laravel', 'x'.repeat(81), 'page'));
});

test('«Rinomina» of a folder keeps its parent; «Duplica» goes next to the page, never over one taken (D-284)', () => {
  assert.equal(renamedFolder('laravel/octane', 'Swoole e RoadRunner'), 'laravel/swoole-e-roadrunner');
  assert.equal(renamedFolder('laravel', 'PHP'), 'php');
  assert.equal(copyPath('laravel/swoole', new Set()), 'laravel/swoole-copia');
  assert.equal(copyPath('laravel/swoole', new Set(['laravel/swoole-copia'])), 'laravel/swoole-copia-2');
  const long = `laravel/${'a'.repeat(40)}`;
  const copy = copyPath(long, new Set());
  assert.ok((copy.split('/').at(-1) ?? '').length <= 40);
  assert.match(copy, /-copia$/);
  assert.equal(copyTitle('Swoole'), 'Swoole (copia)');
  assert.ok(copyTitle('t'.repeat(80)).length <= 80);
});

test('«Sposta in…» offers only the folders where it may go (D-284)', () => {
  const folders = ['laravel', 'laravel/octane', 'php'];
  assert.deepEqual(
    moveChoices({ kind: 'page', path: 'laravel/swoole' }, folders).map((choice) => choice.to),
    ['laravel/octane/swoole', 'php/swoole'],
  );
  // A folder: the root and the folders not inside it, never too deep.
  assert.deepEqual(
    moveChoices({ kind: 'folder', path: 'laravel/octane' }, folders).map((choice) => choice.to),
    ['octane', 'php/octane'],
  );
  assert.deepEqual(moveChoices({ kind: 'folder', path: 'laravel' }, folders).map((choice) => choice.to), ['php/laravel']);
});

test('a writing session token the core takes (D-284)', () => {
  assert.match(sessionToken(), /^[A-Za-z0-9_-]{16,64}$/);
  assert.match(sessionToken(() => 'a b'), /^[A-Za-z0-9_-]{16,64}$/);
  assert.notEqual(sessionToken(), sessionToken());
  assert.match(wikiErrorText(400, 'invalid: session'), /ricarica la pagina/);
});

test('«Confronta» and «Proposte»: the lines that do not change are closed in one row that says how many (D-285)', () => {
  const context = (text: string) => ({ kind: 'context' as const, text });
  // Old side of 20 lines: a change at line 6 (context 2), another at line 15.
  const hunks = [
    { oldStart: 4, oldLines: 5, newStart: 4, newLines: 5, lines: [context('4'), context('5'), { kind: 'removed' as const, text: 'sei' }, { kind: 'added' as const, text: 'SEI' }, context('7'), context('8')] },
    { oldStart: 13, oldLines: 4, newStart: 13, newLines: 5, lines: [context('13'), context('14'), { kind: 'added' as const, text: 'nuova' }, context('15'), context('16')] },
  ];
  const rows = wikiDiffRows(hunks, 20);
  assert.deepEqual(rows.filter((row) => row.kind === 'gap').map((row) => row.text), ['3 righe uguali', '4 righe uguali', '4 righe uguali']);
  assert.equal(rows[0]?.kind, 'gap');
  assert.equal(rows.at(-1)?.text, '4 righe uguali');
  assert.deepEqual(rows.filter((row) => row.kind === 'added').map((row) => row.text), ['SEI', 'nuova']);
  // Without the total, nothing after the last change (as in «Proposte»); a change at line 1 has no row before it.
  assert.equal(wikiDiffRows(hunks).at(-1)?.text, '16');
  const first = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [{ kind: 'removed' as const, text: '# Pane' }, { kind: 'added' as const, text: '# Pane di casa' }, context('')] }];
  assert.equal(wikiDiffRows(first, 2)[0]?.kind, 'removed');
  assert.equal(wikiDiffRows(first, 2).some((row) => row.kind === 'gap'), false);
  // A hunk with only lines added starts after its oldStart (unified diff): line 10 of 10 kept before it.
  const tail = [{ oldStart: 10, oldLines: 0, newStart: 11, newLines: 1, lines: [{ kind: 'added' as const, text: 'in fondo' }] }];
  assert.deepEqual(wikiDiffRows(tail, 10).map((row) => row.text), ['10 righe uguali', 'in fondo']);
  // No change: no rows.
  assert.deepEqual(wikiDiffRows([], 12), []);
  assert.equal(sameLinesText(1), '1 riga uguale');
});
