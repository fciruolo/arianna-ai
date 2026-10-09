// Projects as containers (I-11, D-145): the parts found on the disk, the
// management folders with their labels, `parts` and `[[project.folder]]`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { defaultFolderLabel, managementFolders, parseConfig, projectNamed, projectParts, resolveHome, workParts, type Project } from '../src/index.ts';

const ROOT = join(resolveHome({}), 'data', 'test-tmp', `projects-${randomUUID()}`);
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** A folder with the given subfolders; `git` ones get a `.git` folder, as the top of a repository. */
function container(name: string, folders: string[], git: string[] = [], self = false): Project {
  const absolute = join(ROOT, name);
  mkdirSync(absolute, { recursive: true });
  for (const folder of folders) mkdirSync(join(absolute, folder), { recursive: true });
  for (const folder of git) mkdirSync(join(absolute, folder, '.git'), { recursive: true });
  if (self) mkdirSync(join(absolute, '.git'));
  return { name, path: `repos/${name}`, absolute, label: 'L1' };
}

describe('parts of a container', () => {
  it('a container that is a git repository is its only part, named as the project (every project before D-145)', () => {
    const project = container('uno', ['src', 'Workplan', 'admin'], ['admin'], true);
    assert.deepEqual(projectParts(project), [{ ...project, project: 'uno', container: project.absolute, part: null }]);
  });

  it('a missing folder stays one part: opening it says why, as before', () => {
    const project: Project = { name: 'manca', path: 'repos/manca', absolute: join(ROOT, 'manca'), label: 'L1' };
    assert.deepEqual(projectParts(project).map(({ name, part }) => [name, part]), [['manca', null]]);
  });

  it('otherwise the parts are the git subfolders, never the container itself', () => {
    const project = container('progetto-test', ['Workplan', 'IM', 'documenti', 'progetto-test-admin', 'progetto-test-client', 'senza-git'], ['progetto-test-admin', 'progetto-test-client', '.nascosto']);
    symlinkSync(join(project.absolute, 'progetto-test-admin'), join(project.absolute, 'alias-admin'));
    const parts = projectParts(project);
    assert.deepEqual(
      parts.map(({ name, path, absolute, part, project: owner }) => [name, path, absolute, part, owner]),
      [
        ['progetto-test:progetto-test-admin', 'repos/progetto-test/progetto-test-admin', join(project.absolute, 'progetto-test-admin'), 'progetto-test-admin', 'progetto-test'],
        ['progetto-test:progetto-test-client', 'repos/progetto-test/progetto-test-client', join(project.absolute, 'progetto-test-client'), 'progetto-test-client', 'progetto-test'],
      ],
    );
    assert.ok(parts.every((part) => part.absolute !== project.absolute && part.label === 'L1'));
    // A conversation names a part; the container alone is no part of it.
    assert.equal(projectNamed(workParts([project]), 'progetto-test'), undefined);
    assert.equal(projectNamed(workParts([project]), 'progetto-test:progetto-test-client')?.part, 'progetto-test-client');
  });

  it('`parts` keeps only the listed folders, ignoring case; a container without git folders has no part', () => {
    const project = { ...container('lista', ['a', 'b'], ['a', 'b']), parts: ['B'] };
    assert.deepEqual(projectParts(project).map(({ part }) => part), ['b']);
    assert.deepEqual(projectParts(container('vuoto', ['Workplan'])), []);
  });
});

describe('management folders (D-145)', () => {
  it('Workplan and IM are Interne (L1), any other Privata (L2), ignoring case', () => {
    assert.equal(defaultFolderLabel('Workplan'), 'L1');
    assert.equal(defaultFolderLabel('WORKPLAN'), 'L1');
    assert.equal(defaultFolderLabel('im'), 'L1');
    assert.equal(defaultFolderLabel('documenti'), 'L2');
    assert.equal(defaultFolderLabel('Workplan-vecchio'), 'L2');
    assert.equal(defaultFolderLabel('immagini'), 'L2');
  });

  it('every non-git, non-hidden subfolder of a container, with the label the user chose', () => {
    const project = { ...container('gestione', ['workplan', 'IM', 'documenti', 'admin', 'node_modules', '.privata'], ['admin']), folders: [{ path: 'Documenti', label: 'L3' as const }, { path: 'IM', label: 'L2' as const }] };
    symlinkSync(join(project.absolute, 'documenti'), join(project.absolute, 'collegamento'));
    assert.deepEqual(managementFolders(project), [
      { path: 'documenti', label: 'L3', defaultLabel: 'L2', chosen: true },
      { path: 'IM', label: 'L2', defaultLabel: 'L1', chosen: true },
      { path: 'workplan', label: 'L1', defaultLabel: 'L1', chosen: false },
    ]);
  });

  it('in a container that is one git, only the folders known by name or labeled by the user', () => {
    const project = { ...container('un-git', ['src', 'Workplan', 'Documenti', 'note'], [], true), folders: [{ path: 'note', label: 'L2' as const }] };
    assert.deepEqual(managementFolders(project).map(({ path, label }) => [path, label]), [['Documenti', 'L2'], ['note', 'L2'], ['Workplan', 'L1']]);
  });
});

describe('parts and folders in arianna.toml', () => {
  const HOME = resolve('some-home');
  const parse = (extra: string) => parseConfig(`[paths]\ndata = "data"\n\n[database]\nhost = "127.0.0.1"\nport = 5432\nname = "arianna"\nuser = "arianna"\n\n[[project]]\nname = "box"\npath = "repos/box"\n${extra}\n`, HOME, undefined, resolve('some-user')).projects;

  it('reads `parts` and [[project.folder]]; a project without them as before', () => {
    assert.deepEqual(parse(''), [{ name: 'box', path: 'repos/box', absolute: join(HOME, 'repos', 'box'), label: 'L1' }]);
    const [project] = parse('parts = ["box-admin"]\n\n[[project.folder]]\npath = "Workplan"\nlabel = "L2"\n');
    assert.deepEqual(project?.parts, ['box-admin']);
    assert.deepEqual(project.folders, [{ path: 'Workplan', label: 'L2' }]);
  });

  it('refuses a part or a folder that is a path, hidden, twice, or a label that is not one', () => {
    for (const extra of [
      'parts = ["../fuori"]',
      'parts = [".git"]',
      'parts = ["a/b"]',
      'parts = ["a", "A"]',
      '[[project.folder]]\npath = "../fuori"\nlabel = "L1"',
      '[[project.folder]]\npath = ".segreti"\nlabel = "L1"',
      '[[project.folder]]\npath = "a/b"\nlabel = "L1"',
      '[[project.folder]]\npath = "IM"\nlabel = "L5"',
      '[[project.folder]]\npath = "IM"\nlabel = "L1"\n\n[[project.folder]]\npath = "im"\nlabel = "L2"',
      '[[project.folder]]\npath = "IM"\nlabel = "L1"\nnote = "x"',
    ]) {
      assert.throws(() => parse(extra), /project\[0\]/, extra);
    }
  });
});

// A file in a folder that is not plain: the folder is not listed at all.
it('a management folder that is a file or a link is not a folder', () => {
  const project = container('file', []);
  writeFileSync(join(project.absolute, 'Workplan'), 'non una cartella\n');
  assert.deepEqual(managementFolders(project), []);
});
