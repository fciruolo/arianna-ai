import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeGuard } from '../scripts/compose-guard.ts';

test('docker compose runs from the main folder, whatever the command', () => {
  assert.deepEqual(composeGuard('/repo/.git', '/repo/.git', ['up', '--detach']), { run: true });
  assert.deepEqual(composeGuard('/repo/.git', '/repo/.git', ['down']), { run: true });
});

test('in a git worktree up does nothing and every other command is refused', () => {
  const worktree = '/repo/.git/worktrees/agent-x';
  assert.deepEqual(composeGuard(worktree, '/repo/.git', ['up', '--detach', '--wait']), {
    run: false,
    exitCode: 0,
    message: "docker compose: in a git worktree the database is the main folder's; not recreated (start it there with pnpm db:up)",
  });
  assert.deepEqual(composeGuard(worktree, '/repo/.git', ['down']), { run: false, exitCode: 1, message: 'docker compose down: refused in a git worktree; run it from the main folder' });
  assert.equal(composeGuard(worktree, '/repo/.git', []).run, false);
});
