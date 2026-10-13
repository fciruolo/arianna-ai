// The permission profile of `pnpm dev:codex` (D-143).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { devArgs, devFilesystem, ignoredPaths } from '../scripts/codex-dev.ts';

const HOME = '/srv/arianna';

test('the profile opens the repository and the toolchain, denies what git ignores, keeps the rules read only', () => {
  const table = devFilesystem(HOME, ['/srv/node'], ['kb/inbox', 'repos', '.claude/read-allow.local', '.env.local']);
  assert.equal(
    table,
    '{":minimal"="read", "/srv/node"="read", "/srv/arianna"="write", "/srv/arianna/.git"="read", "/srv/arianna/.githooks"="read", "/srv/arianna/.claude"="read", "/srv/arianna/CLAUDE.md"="read", "/srv/arianna/AGENTS.md"="read", ' +
      '"/srv/arianna/data"="deny", "/srv/arianna/config/arianna.toml"="deny", "/srv/arianna/config/models.user-catalog.yaml"="deny", "/srv/arianna/kb/inbox"="deny", "/srv/arianna/kb/progetti"="deny", "/srv/arianna/repos"="deny", "/srv/arianna/.claude/worktrees"="deny", ' +
      '"/srv/arianna/.claude/read-allow.local"="deny", "/srv/arianna/.env.local"="deny", "/srv/arianna/data/test-tmp"="write"}',
  );
});

test('the folders that can appear while Codex runs are denied even when git does not list them', () => {
  const table = devFilesystem(HOME, [], []);
  for (const path of ['data', 'kb/inbox', 'kb/progetti', 'repos', 'config/arianna.toml', '.claude/worktrees']) {
    assert.ok(table.includes(`"/srv/arianna/${path}"="deny"`), path);
  }
  assert.ok(!table.includes('"/srv/arianna/kb"="deny"'));
});

test('every path git ignores is denied, the build output is not', () => {
  const porcelain = ['!! data/', '!! kb/inbox/', '!! config/models.user-catalog.yaml', '!! node_modules/', '!! apps/hud/node_modules/', '!! apps/hud/dist/', '?? new.ts', ' M package.json', ''].join('\n');
  assert.deepEqual(ignoredPaths(porcelain), ['data', 'kb/inbox', 'config/models.user-catalog.yaml']);
});

test('a folder listed twice is refused, and the arguments ask before leaving the sandbox', () => {
  assert.throws(() => devFilesystem(HOME, [HOME], []), /listed twice/);
  const args = devArgs(HOME, [], [], ['--model', 'x']);
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('default_permissions="arianna-dev"'));
  assert.deepEqual(args.slice(-4), ['--cd', HOME, '--model', 'x']);
});
