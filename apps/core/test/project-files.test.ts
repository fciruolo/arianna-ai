// Moving and deleting in the tab "File" of a project (I-20, D-185): each rule with a positive and a negative case.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';

import type { Queryable } from '../src/db/client.ts';
import type { NewEvent } from '../src/events.ts';
import { deleteProjectPath, moveProjectPath, ProjectFileError, type ProjectFileDeps } from '../src/project-files.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `project-files-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function setup(running = false): { deps: ProjectFileDeps; root: string; events: NewEvent[] } {
  const root = join(HOME, 'repos', randomUUID());
  mkdirSync(join(root, 'mockups', 'eliminati'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'vendor', 'lib', '.git'), { recursive: true });
  writeFileSync(join(root, 'mockups', 'eliminati', 'home-2.html'), '<h1>2</h1>');
  writeFileSync(join(root, 'mockups', 'home-1.html'), '<h1>1</h1>');
  writeFileSync(join(root, 'README.md'), '# Sito');
  writeFileSync(join(HOME, 'fuori.txt'), 'outside');
  symlinkSync(join(HOME, 'fuori.txt'), join(root, 'link.txt'));
  symlinkSync(join(HOME), join(root, 'giro'));
  const project: Project = { name: 'sito', path: 'repos/sito', absolute: root, label: 'L1' };
  const events: NewEvent[] = [];
  const sql = { unsafe: () => Promise.resolve(running ? [{ id: '1' }] : []) } as unknown as Queryable;
  return {
    root,
    events,
    deps: {
      projects: () => [project],
      record: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      sql,
    },
  };
}

const code = (expected: string) => (error: unknown) => error instanceof ProjectFileError && error.code === expected;

test('a file is restored from eliminati/ to the mockups, with its event; a name already there is never replaced', async () => {
  const { deps, root, events } = setup();
  assert.deepEqual(await moveProjectPath(deps, 'sito', { from: 'mockups/eliminati/home-2.html', to: 'mockups/home-2.html' }), { from: 'mockups/eliminati/home-2.html', to: 'mockups/home-2.html', kind: 'file' });
  assert.equal(readFileSync(join(root, 'mockups', 'home-2.html'), 'utf8'), '<h1>2</h1>');
  assert.equal(existsSync(join(root, 'mockups', 'eliminati', 'home-2.html')), false);
  assert.equal(events.at(-1)?.kind, 'project.file.move');
  await assert.rejects(moveProjectPath(deps, 'sito', { from: 'README.md', to: 'mockups/home-1.html' }), code('exists'));
  assert.equal(readFileSync(join(root, 'mockups', 'home-1.html'), 'utf8'), '<h1>1</h1>');
});

test('a folder moves, but not inside itself nor through a link', async () => {
  const { deps, root } = setup();
  await moveProjectPath(deps, 'sito', { from: 'mockups', to: 'design' });
  assert.ok(existsSync(join(root, 'design', 'home-1.html')));
  await assert.rejects(moveProjectPath(deps, 'sito', { from: 'design', to: 'design/inner' }), code('invalid'));
  await assert.rejects(moveProjectPath(deps, 'sito', { from: 'README.md', to: 'giro/README.md' }), code('refused'));
  await assert.rejects(moveProjectPath(deps, 'sito', { from: 'link.txt', to: 'link2.txt' }), code('refused'));
  assert.ok(existsSync(join(root, 'README.md')));
});

test('a file and a folder are deleted for good, with the count in the event', async () => {
  const { deps, root, events } = setup();
  assert.deepEqual(await deleteProjectPath(deps, 'sito', { path: 'mockups/eliminati/home-2.html' }), { path: 'mockups/eliminati/home-2.html', kind: 'file', entries: 1 });
  assert.equal(existsSync(join(root, 'mockups', 'eliminati', 'home-2.html')), false);
  assert.deepEqual(await deleteProjectPath(deps, 'sito', { path: 'mockups' }), { path: 'mockups', kind: 'dir', entries: 3 });
  assert.equal(existsSync(join(root, 'mockups')), false);
  assert.equal(events.at(-1)?.kind, 'project.file.delete');
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'mockups' }), code('not-found'));
});

test('hidden parts, node_modules, links, a nested repository, paths out of the project and the top are refused', async () => {
  const { deps, root } = setup();
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: '.git' }), code('refused'));
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'node_modules/x' }), code('refused'));
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'link.txt' }), code('refused'));
  assert.equal(readFileSync(join(HOME, 'fuori.txt'), 'utf8'), 'outside');
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'vendor' }), code('refused'));
  assert.ok(existsSync(join(root, 'vendor', 'lib')));
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: '../fuori.txt' }), code('invalid'));
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: '/etc/hosts' }), code('invalid'));
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: '' }), code('invalid'));
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'giro/fuori.txt' }), code('refused'));
  await assert.rejects(deleteProjectPath(deps, 'altro', { path: 'README.md' }), code('not-found'));
});

test('nothing changes while an agent works on the project', async () => {
  const { deps, root } = setup(true);
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'README.md' }), code('busy'));
  await assert.rejects(moveProjectPath(deps, 'sito', { from: 'README.md', to: 'LEGGIMI.md' }), code('busy'));
  assert.ok(existsSync(join(root, 'README.md')));
});

test('a folder holding hidden files and a file that may hold a secret are not changed from the page', async () => {
  const { deps, root } = setup();
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', '.env'), 'A=1');
  writeFileSync(join(root, 'config', 'app.json'), '{}');
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'config' }), code('refused'));
  await assert.rejects(moveProjectPath(deps, 'sito', { from: 'config', to: 'impostazioni' }), code('refused'));
  assert.ok(existsSync(join(root, 'config', '.env')));
  writeFileSync(join(root, 'id_rsa'), 'chiave finta');
  await assert.rejects(deleteProjectPath(deps, 'sito', { path: 'id_rsa' }), code('refused'));
  await assert.rejects(moveProjectPath(deps, 'sito', { from: 'id_rsa', to: 'chiave.txt' }), code('refused'));
  // A folder without hidden files still goes.
  await deleteProjectPath(deps, 'sito', { path: 'mockups' });
});
