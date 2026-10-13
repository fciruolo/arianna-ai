import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
