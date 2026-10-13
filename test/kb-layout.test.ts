// The folders of kb/ that hold the user's own notes stay out of git (D-198):
// the inbox, the knowledge of the projects and the archive of the notes the
// Archivist filed. The fake development documents of kb/ stay in git.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ROOT } from './support/files.ts';

test('notes in kb/archivio, kb/inbox and kb/progetti are ignored by git, the development documents of kb/ are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arianna-kb-layout-'));
  try {
    copyFileSync(join(ROOT, '.gitignore'), join(dir, '.gitignore'));
    // Inside the pre-commit hook git hands down GIT_DIR and friends: dropped, so the check runs on this folder only.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe', env });
    const ignored = (path: string): boolean => {
      const result = spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: dir, env });
      assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed for ${path}`);
      return result.status === 0;
    };
    for (const path of ['kb/archivio/private/finanze/2026-10-13-080000-nota.md', 'kb/archivio/nota.md', 'kb/inbox/2026-10-13-080000-nota.md', 'kb/progetti/demo/IM/nota.md']) {
      assert.equal(ignored(path), true, path);
    }
    for (const path of ['kb/private/finanze/2026-10-13-080000-nota.md', 'kb/public/arianna.md', 'kb/work/clienti/nota.md', 'kb/README.md']) {
      assert.equal(ignored(path), false, path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
