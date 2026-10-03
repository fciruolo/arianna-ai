// Project folders and their links in repos/ (D-058), in a scratch home under data/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';

import { folderProblem, linkState, projectChecks, syncProjectLinks } from '../src/projects.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `projects-${randomUUID()}`);
// A sibling of the scratch ARIANNA_HOME stands for the user's home.
const USER = `${HOME}-user`;

after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(USER, { recursive: true, force: true });
});

function repo(name: string): string {
  const dir = join(USER, 'Projects', name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--quiet', dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return dir;
}

const project = (name: string, absolute: string): Project => ({ name, path: `~/Projects/${name}`, absolute, label: 'L1' });

test('folderProblem: a real folder at the top of a git repository is fine; missing, linked, plain or a file is not', () => {
  mkdirSync(HOME, { recursive: true });
  const check = (path: string, name = 'x') => folderProblem(path, HOME, name);
  const dir = repo('fine');
  assert.equal(check(dir), undefined);
  assert.match(check(join(USER, 'Projects', 'none')) ?? '', /non esiste/);
  symlinkSync(dir, join(USER, 'Projects', 'alias'));
  assert.match(check(join(USER, 'Projects', 'alias')) ?? '', /link simbolico/);
  // A link higher up on the way counts as well.
  symlinkSync(join(USER, 'Projects'), join(USER, 'Linked'));
  assert.match(check(join(USER, 'Linked', 'fine')) ?? '', /link simbolico/);
  mkdirSync(join(USER, 'Projects', 'plain'));
  assert.match(check(join(USER, 'Projects', 'plain')) ?? '', /repository git/);
  writeFileSync(join(USER, 'Projects', 'file.txt'), 'x');
  assert.match(check(join(USER, 'Projects', 'file.txt')) ?? '', /non è una cartella/);
});

test('folderProblem: the folder of Arianna, folders around it, and inside it anything but repos/<name>', () => {
  mkdirSync(join(HOME, 'repos', 'demo'), { recursive: true });
  mkdirSync(join(HOME, 'data'), { recursive: true });
  execFileSync('git', ['init', '--quiet', join(HOME, 'repos', 'demo')], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(folderProblem(join(HOME, 'repos', 'demo'), HOME, 'demo'), undefined);
  assert.match(folderProblem(join(HOME, 'repos', 'demo'), HOME, 'other') ?? '', /dentro Arianna/);
  assert.match(folderProblem(join(HOME, 'data'), HOME, 'data') ?? '', /dentro Arianna/);
  assert.match(folderProblem(HOME, HOME, 'x') ?? '', /contiene la cartella di Arianna/);
  assert.match(folderProblem(join(HOME, 'repos'), join(HOME, 'repos', 'demo'), 'repos') ?? '', /contiene la cartella di Arianna/);
});

test('syncProjectLinks does nothing when repos/ is itself a link', () => {
  const home = `${HOME}-linked`;
  mkdirSync(join(home, 'elsewhere'), { recursive: true });
  symlinkSync(join(home, 'elsewhere'), join(home, 'repos'));
  try {
    const done = syncProjectLinks(home, [], [project('e', repo('e'))]);
    assert.match(done[0] ?? '', /non è una cartella vera/);
    // Nothing was made in the folder the link points to.
    assert.deepEqual(readdirSync(join(home, 'elsewhere')), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('syncProjectLinks creates, replaces and removes only links, and leaves real folders alone', () => {
  const a = project('a', repo('a'));
  const b = project('b', repo('b'));
  const inside: Project = { name: 'demo', path: 'repos/demo', absolute: join(HOME, 'repos', 'demo'), label: 'L1' };
  assert.deepEqual(syncProjectLinks(HOME, [], [a, b, inside]).length, 2);
  assert.equal(readlinkSync(join(HOME, 'repos', 'a')), a.absolute);
  assert.equal(linkState(HOME, a), 'ok');
  assert.equal(linkState(HOME, inside), 'none');

  // A link pointing elsewhere is ours: replaced.
  rmSync(join(HOME, 'repos', 'b'));
  symlinkSync(a.absolute, join(HOME, 'repos', 'b'));
  assert.equal(linkState(HOME, b), 'elsewhere');
  syncProjectLinks(HOME, [a, b], [a, b]);
  assert.equal(linkState(HOME, b), 'ok');

  // Taken off the list: its link goes, the folder it pointed to stays.
  assert.deepEqual(syncProjectLinks(HOME, [a, b], [b]), ['Tolto il link repos/a.']);
  assert.equal(linkState(HOME, a), 'missing');
  assert.ok(lstatSync(a.absolute).isDirectory());

  // A real folder named like a project is never touched.
  const c = project('c', repo('c'));
  mkdirSync(join(HOME, 'repos', 'c'));
  assert.match(syncProjectLinks(HOME, [b], [b, c])[0] ?? '', /non è un link/);
  assert.equal(linkState(HOME, c), 'not-link');
  syncProjectLinks(HOME, [b, c], [b]);
  assert.ok(lstatSync(join(HOME, 'repos', 'c')).isDirectory());
});

test('projectChecks: folder and link of each project, nothing fixed', () => {
  assert.deepEqual(projectChecks(HOME, []).map((check) => check.ok), [true]);
  const ok = project('d', repo('d'));
  syncProjectLinks(HOME, [], [ok]);
  const gone = project('gone', join(USER, 'Projects', 'gone'));
  const checks = projectChecks(HOME, [ok, gone]);
  assert.deepEqual(
    checks.map((check) => [check.id, check.ok]),
    [
      ['projects.d', true],
      ['projects.d.link', true],
      ['projects.gone', false],
      ['projects.gone.link', false],
    ],
  );
  assert.equal(linkState(HOME, gone), 'missing');
});
