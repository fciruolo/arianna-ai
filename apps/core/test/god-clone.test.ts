import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { gitEnv } from '../src/git-catalog.ts';
import {
  cloneState,
  createSubtaskClone,
  GOD_MARKER,
  GOD_MARKER_VERSION,
  GodCloneError,
  godCloneRefusal,
  godPartDir,
  godPartOf,
  godWorkspace,
  subtaskBranch,
  syncGodClone,
} from '../src/god/clone.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'arianna-god-'));
  roots.push(root);
  return root;
}

const GIT_ENV = { ...gitEnv(process.env, 'file', temporary()), GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function commit(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
}

/** A fake ARIANNA_HOME: a git repository on main, with data/ and repos/ ignored as in the real one. */
function home(): { home: string; data: string } {
  const root = temporary();
  git(root, 'init', '-q');
  commit(root, { '.gitignore': 'data/\nrepos/\n', 'docs/HANDOFF.md': '# Consegna\n', 'README.md': 'fake\n' });
  // The real data of the installation: never in a clone.
  mkdirSync(join(root, 'data', 'vault'), { recursive: true });
  writeFileSync(join(root, 'data', 'vault', 'secrets.yaml'), 'not real\n');
  return { home: root, data: join(root, 'data') };
}

test('a development copy passes the tripwire; the data of an installation or real passwords do not', () => {
  const dir = temporary();
  assert.match(godCloneRefusal(join(dir, 'missing')) ?? '', /non c’è/);
  assert.match(godCloneRefusal(dir) ?? '', /non è un repository git/);
  mkdirSync(join(dir, '.git'));
  assert.match(godCloneRefusal(dir) ?? '', /non è un clone fatto da GOD/, 'a folder GOD did not clone');
  writeFileSync(join(dir, '.git', GOD_MARKER), 'A clone of GOD (D-127): docker compose is refused here.\n');
  assert.match(godCloneRefusal(dir) ?? '', /metodo vecchio/, 'a clone of the old method copied the stash: made again');
  writeFileSync(join(dir, '.git', GOD_MARKER), `A clone of GOD.\n${GOD_MARKER_VERSION}\n`);
  assert.equal(godCloneRefusal(dir), undefined);
  // Development: data/tmp and a config without the passwords of the database are fine.
  mkdirSync(join(dir, 'data', 'tmp'), { recursive: true });
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'arianna.toml'), '[database]\nhost = "127.0.0.1"\n# password = "vault://db-owner-password"\n');
  assert.equal(godCloneRefusal(dir), undefined);
  writeFileSync(join(dir, 'config', 'arianna.toml'), '[database]\npassword = "vault://db-owner-password"\n');
  assert.match(godCloneRefusal(dir) ?? '', /password/);
  rmSync(join(dir, 'config'), { recursive: true });
  for (const name of ['vault', 'postgres', 'archive', 'kb', 'models', 'guard/models']) {
    mkdirSync(join(dir, 'data', name), { recursive: true });
    assert.match(godCloneRefusal(dir) ?? '', new RegExp(`data/${name}`));
    rmSync(join(dir, 'data', name), { recursive: true });
  }
  // A linked worktree: its .git is a file pointing into another repository.
  rmSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  assert.match(godCloneRefusal(dir) ?? '', /worktree/);
});

test('the parts of the container: main and the subtasks, nothing else', () => {
  assert.equal(godWorkspace('main'), 'arianna:main');
  assert.equal(godPartOf('arianna:main'), 'main');
  assert.equal(godPartOf('arianna:g001-login'), 'g001-login');
  assert.equal(godPartOf('arianna'), undefined);
  assert.equal(godPartOf('arianna:other'), undefined);
  assert.equal(godPartOf('demo:main'), undefined);
  assert.equal(godPartOf(null), undefined);
  assert.equal(subtaskBranch('g002-x'), 'god/g002-x');
  assert.throws(() => godPartDir('/home', '../escape'), GodCloneError);
  assert.equal(godPartDir('/home', 'main'), join('/home', 'repos', 'arianna', 'main'));
});

test('the clone is made from the local repository, without data/, marked, and moves forward when clean', async () => {
  const { home: root, data } = home();
  const first = await syncGodClone(root, data);
  assert.equal(first.created, true);
  const dir = godPartDir(root, 'main');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'fake\n');
  assert.equal(existsSync(join(dir, 'data')), false, 'the data of the installation never reach the clone');
  assert.equal(existsSync(join(dir, '.git', GOD_MARKER)), true);
  assert.equal(first.state.branch, 'main');
  assert.equal(first.state.behind, 0);
  assert.equal(first.state.dirty, 0);

  // A new commit in the installation: the clone sees it behind, then moves forward.
  commit(root, { 'README.md': 'fake 2\n' });
  const before = await cloneState(root, data, 'main');
  assert.equal(before.behind, undefined, 'not fetched yet: unknown');
  const second = await syncGodClone(root, data);
  assert.equal(second.created, false);
  assert.equal(second.forwarded, true);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'fake 2\n');

  // Work in the clone is never touched: fetched, not merged.
  writeFileSync(join(dir, 'README.md'), 'changed by GOD\n');
  commit(root, { 'other.md': 'x\n' });
  const third = await syncGodClone(root, data);
  assert.equal(third.forwarded, false);
  assert.equal(third.state.behind, 1);
  assert.equal(third.state.dirty, 1);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'changed by GOD\n');
});

test('a clone with the data of an installation is refused, not updated', async () => {
  const { home: root, data } = home();
  await syncGodClone(root, data);
  mkdirSync(join(godPartDir(root, 'main'), 'data', 'vault'), { recursive: true });
  await assert.rejects(syncGodClone(root, data), /data\/vault/);
  assert.match((await cloneState(root, data, 'main')).refusal ?? '', /data\/vault/);
});

test('a subtask works in a clone of its own, on its branch; never in an existing folder', async () => {
  const { home: root, data } = home();
  const dir = await createSubtaskClone(root, data, 'g001-login');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'god/g001-login');
  assert.equal(existsSync(join(dir, '.git', GOD_MARKER)), true);
  await assert.rejects(createSubtaskClone(root, data, 'g001-login'), /already there/);
  await assert.rejects(createSubtaskClone(root, data, 'main'), GodCloneError);
});

test('the clone holds only what main reaches: never the stash, another branch or an unreachable object of the installation', async () => {
  const { home: root, data } = home();
  // A stash, a branch and a blob no ref reaches, in the installation.
  writeFileSync(join(root, 'README.md'), 'secret work in progress\n');
  git(root, 'stash', 'push', '-q', '-m', 'private');
  const stash = git(root, 'rev-parse', 'refs/stash').trim();
  git(root, 'branch', 'other');
  const lone = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, env: GIT_ENV, input: 'unreachable blob\n', encoding: 'utf8' }).trim();
  await syncGodClone(root, data);
  const dir = godPartDir(root, 'main');
  const has = (object: string, where: string = dir): boolean => {
    try {
      execFileSync('git', ['cat-file', '-e', object], { cwd: where, env: GIT_ENV, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(has(stash), false, 'the stash of the installation is not in the clone');
  assert.equal(has(lone), false, 'an object no branch reaches is not in the clone');
  assert.equal(git(dir, 'branch', '-a', '--format=%(refname)').split('\n').some((ref) => ref.endsWith('/other')), false, 'only main');
  assert.match(git(dir, 'remote', 'get-url', 'origin'), /^file:\/\//);
  // The update fetches main only.
  git(root, 'branch', 'later');
  await syncGodClone(root, data);
  assert.equal(git(dir, 'branch', '-a', '--format=%(refname)').split('\n').some((ref) => ref.endsWith('/later')), false);
  // The subtasks' clones too.
  const sub = await createSubtaskClone(root, data, 'g001-x');
  assert.equal(has(stash, sub), false);
  assert.equal(has(lone, sub), false);
});

test('a clone made by the old method is refused, never updated', async () => {
  const { home: root, data } = home();
  await syncGodClone(root, data);
  writeFileSync(join(godPartDir(root, 'main'), '.git', GOD_MARKER), 'A clone of GOD (D-127): docker compose is refused here.\n');
  await assert.rejects(syncGodClone(root, data), /metodo vecchio/);
});
