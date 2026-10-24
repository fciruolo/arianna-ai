import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ROOT } from './support/files.ts';

// A merge runs pre-merge-commit, not pre-commit (D-127: the branches of GOD come in with git merge).
test('the hook of a merge commit is executable and runs the checks of a commit', () => {
  const hook = join(ROOT, '.githooks', 'pre-merge-commit');
  assert.ok((statSync(hook).mode & 0o111) !== 0, 'executable');
  const dir = mkdtempSync(join(tmpdir(), 'arianna-hooks-'));
  try {
    mkdirSync(join(dir, '.githooks'));
    copyFileSync(hook, join(dir, '.githooks', 'pre-merge-commit'));
    // A pre-commit that leaves a trace and fails: the merge hook must run it and fail with it.
    writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\ntouch "$(dirname "$0")/ran"\nexit 3\n', { mode: 0o755 });
    assert.throws(() => execFileSync('sh', [join(dir, '.githooks', 'pre-merge-commit')], { stdio: 'ignore' }), (error: unknown) => (error as { status?: number }).status === 3);
    assert.equal(existsSync(join(dir, '.githooks', 'ran')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D-200: a commit of documents only (docs/, CHANGELOG.md) skips `pnpm check`; anything else runs it.
test('the pre-commit hook runs pnpm check unless only documents are staged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arianna-precommit-'));
  try {
    // Inside a real commit git exports GIT_INDEX_FILE, GIT_DIR and friends: the temporary repository must not see them.
    const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: clean, stdio: 'ignore' });
    git('init', '-q');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'conflict-markers.ts'), '');
    mkdirSync(join(dir, 'bin'));
    // A fake pnpm that leaves a trace.
    writeFileSync(join(dir, 'bin', 'pnpm'), '#!/bin/sh\ntouch "$PWD/checked"\n', { mode: 0o755 });
    const hook = join(ROOT, '.githooks', 'pre-commit');
    assert.ok((statSync(hook).mode & 0o111) !== 0, 'executable');
    const env: NodeJS.ProcessEnv = { ...clean, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` };
    delete env.NODE_TEST_CONTEXT;
    const run = () => execFileSync('sh', [hook], { cwd: dir, env, stdio: 'ignore' });
    mkdirSync(join(dir, 'docs', 'mockups'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'HANDOFF.md'), 'a\n');
    writeFileSync(join(dir, 'docs', 'mockups', 'p.html'), 'b\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), 'c\n');
    git('add', 'docs', 'CHANGELOG.md');
    run();
    assert.equal(existsSync(join(dir, 'checked')), false, 'documents only: no check');
    writeFileSync(join(dir, 'main.ts'), 'd\n');
    git('add', 'main.ts');
    run();
    assert.equal(existsSync(join(dir, 'checked')), true, 'code staged: check runs');
    const fresh = () => {
      rmSync(join(dir, 'checked'), { force: true });
    };
    // Commit what is staged, then each case starts from a clean index.
    git('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '--no-verify', '-m', 'base');
    fresh();
    git('mv', 'main.ts', 'docs/main.md');
    run();
    assert.equal(existsSync(join(dir, 'checked')), true, 'code moved into docs/: check runs');
    git('reset', '-q', '--hard');
    fresh();
    git('rm', '-q', 'main.ts');
    run();
    assert.equal(existsSync(join(dir, 'checked')), true, 'code deleted: check runs');
    git('reset', '-q', '--hard');
    fresh();
    writeFileSync(join(dir, 'docs', 'tool.ts'), 'e\n');
    git('add', 'docs/tool.ts');
    run();
    assert.equal(existsSync(join(dir, 'checked')), true, 'a .ts in docs/: check runs');
    git('reset', '-q', '--hard');
    rmSync(join(dir, 'docs', 'tool.ts'), { force: true });
    fresh();
    run();
    assert.equal(existsSync(join(dir, 'checked')), true, 'nothing staged: check runs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D-305: a staged docs/HANDOFF.md over 20 KB gets a warning on stderr; the commit still goes through.
test('the pre-commit hook warns when the staged docs/HANDOFF.md is over 20 KB, without refusing the commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arianna-handoff-'));
  try {
    const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    mkdirSync(join(dir, 'bin'));
    // A fake pnpm that leaves a trace, so the commits that are not documents only still pass.
    writeFileSync(join(dir, 'bin', 'pnpm'), '#!/bin/sh\ntouch "$PWD/checked"\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...clean, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` };
    delete env.NODE_TEST_CONTEXT;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });
    git('init', '-q');
    mkdirSync(join(dir, '.githooks'));
    copyFileSync(join(ROOT, '.githooks', 'pre-commit'), join(dir, '.githooks', 'pre-commit'));
    git('config', 'core.hooksPath', '.githooks');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'conflict-markers.ts'), '');
    mkdirSync(join(dir, 'docs'));
    // A real commit, so the hook runs as git runs it; returns what the hook wrote on stderr.
    const commit = (message: string) => {
      const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '-m', message], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stderr;
    };
    const count = () => Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim());
    const warning = (kb: number) => new RegExp(`^pre-commit: docs/HANDOFF\\.md è a ${String(kb)} KB, oltre 20: sposta gli stati vecchi in fondo a docs/HANDOFF-STORIA\\.md \\(D-200, D-305\\)$`, 'm');
    const handoff = join(dir, 'docs', 'HANDOFF.md');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '--no-verify', '-m', 'base');
    writeFileSync(handoff, 'a'.repeat(20 * 1024));
    git('add', 'docs/HANDOFF.md');
    assert.doesNotMatch(commit('at the limit'), /HANDOFF/, 'exactly 20 KB: no warning');
    writeFileSync(handoff, 'a'.repeat(20 * 1024 + 1));
    git('add', 'docs/HANDOFF.md');
    assert.match(commit('one byte over'), warning(21), 'one byte over: warning, rounded up');
    writeFileSync(handoff, 'a'.repeat(23 * 1024 - 10));
    git('add', 'docs/HANDOFF.md');
    assert.match(commit('over the limit'), warning(23));
    assert.equal(count(), 4, 'over the limit: the commits went through');
    // HANDOFF is large on disk and in HEAD, but the commit does not touch it.
    rmSync(join(dir, 'checked'), { force: true });
    writeFileSync(join(dir, 'main.ts'), 'b\n');
    git('add', 'main.ts');
    assert.doesNotMatch(commit('other file'), /HANDOFF/, 'HANDOFF not staged: no warning');
    assert.equal(existsSync(join(dir, 'checked')), true, 'code staged: the check still runs');
    // Small staged version, large version on disk.
    writeFileSync(handoff, 'small\n');
    git('add', 'docs/HANDOFF.md');
    writeFileSync(handoff, 'a'.repeat(30 * 1024));
    assert.doesNotMatch(commit('small staged'), /HANDOFF/, 'the staged version counts, not the disk');
    // A partial commit (`git commit <path>`) checks the temporary index git builds from the disk.
    writeFileSync(handoff, 'a'.repeat(25 * 1024));
    const partial = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '-m', 'partial', 'docs/HANDOFF.md'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(partial.stderr, warning(25), 'partial commit: the version being committed counts');
    // Moving HANDOFF away is a deletion: no warning; moving a large file onto HANDOFF is an addition: warning.
    git('mv', 'docs/HANDOFF.md', 'docs/OLD.md');
    assert.doesNotMatch(commit('moved away'), /HANDOFF/, 'moved away: no warning');
    git('mv', 'docs/OLD.md', 'docs/HANDOFF.md');
    assert.match(commit('moved back'), warning(25), 'moved onto HANDOFF: warning');
    // Deleting HANDOFF is no reason to warn.
    git('rm', '-q', '--cached', 'docs/HANDOFF.md');
    assert.doesNotMatch(commit('deleted'), /HANDOFF/, 'deleted: no warning');
    assert.equal(count(), 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
