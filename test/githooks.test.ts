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
