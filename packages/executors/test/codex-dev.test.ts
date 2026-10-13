// The launch of interactive Codex on the development of Arianna (`pnpm dev:codex`, D-143).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODEX_DISABLED_FEATURES,
  DEV_ALWAYS_DENIED,
  DEV_READ_ONLY,
  devArgs,
  devEnv,
  devExtraArgs,
  devFilesystem,
  devIgnoredPaths,
  devStrayInstructionFiles,
  devVersionOk,
} from '@arianna/executors';

const HOME = '/srv/arianna';

/** The rules of the inline TOML table, parsed back from its JSON keys. */
function rules(table: string): Map<string, string> {
  const inner = table.slice(1, -1);
  const map = new Map<string, string>();
  for (const match of inner.matchAll(/("(?:[^"\\]|\\.)*")=("(?:[^"\\]|\\.)*")/g)) {
    map.set(JSON.parse(match[1] as string) as string, JSON.parse(match[2] as string) as string);
  }
  return map;
}

test('the profile opens the repository and the toolchain, denies what git ignores, keeps the rules read only', () => {
  const table = devFilesystem(HOME, ['/srv/node'], ['kb/inbox', 'repos', '.claude/read-allow.local', '.env.local']);
  const map = rules(table);
  assert.equal(map.get(':minimal'), 'read');
  assert.equal(map.get('/srv/node'), 'read');
  assert.equal(map.get(HOME), 'write');
  for (const path of DEV_READ_ONLY) assert.equal(map.get(`${HOME}/${path}`), 'read', path);
  for (const path of ['data', 'config/arianna.toml', 'kb/inbox', 'repos', '.claude/read-allow.local', '.env.local']) assert.equal(map.get(`${HOME}/${path}`), 'deny', path);
  assert.equal(map.get(`${HOME}/data/test-tmp`), 'write');
});

test('the rules that confine the agents and what pnpm check runs are read only, even before they exist', () => {
  for (const path of ['AGENTS.override.md', '.codex', '.agents', 'CLAUDE.local.md', '.mcp.json', 'package.json', 'eslint.config.js', '.git', '.githooks', '.claude', 'CLAUDE.md', 'AGENTS.md']) {
    assert.ok((DEV_READ_ONLY as readonly string[]).includes(path), path);
  }
  // Source files are not among them: Codex writes the code.
  assert.ok(!(DEV_READ_ONLY as readonly string[]).includes('tsconfig.json'));
  assert.equal(rules(devFilesystem(HOME, [], [])).get(`${HOME}/packages`), undefined);
});

test('the folders that can appear while Codex runs are denied even when git does not list them', () => {
  const map = rules(devFilesystem(HOME, [], []));
  for (const path of DEV_ALWAYS_DENIED) assert.equal(map.get(`${HOME}/${path}`), 'deny', path);
  for (const path of ['kb/progetti', '.claude/worktrees', 'config/models.user-catalog.yaml']) assert.equal(map.get(`${HOME}/${path}`), 'deny', path);
  assert.equal(map.get(`${HOME}/kb`), undefined);
});

test('keys with a space, an accent or a quote stay one TOML key', () => {
  const home = '/srv/Sviluppo Arianna/caffè "nuovo"';
  const table = devFilesystem(home, [], ['note già "viste"']);
  const map = rules(table);
  assert.equal(map.get(home), 'write');
  assert.equal(map.get(`${home}/note già "viste"`), 'deny');
  assert.ok(table.includes('\\"nuovo\\"'));
  assert.throws(() => devFilesystem('relative/home', [], []), /absolute/);
  assert.throws(() => devFilesystem('/srv/x/../y', [], []), /normalized/);
});

test('every path git ignores is denied, the build output is not (porcelain -z, names with spaces)', () => {
  const porcelain = ['!! data/', '!! kb/inbox/', '!! config/models.user-catalog.yaml', '!! node_modules/', '!! apps/hud/node_modules/', '!! apps/hud/dist/', '!! note con spazio è.md', '?? new.ts', ' M package.json', ''].join('\0');
  assert.deepEqual(devIgnoredPaths(porcelain), ['data', 'kb/inbox', 'config/models.user-catalog.yaml', 'note con spazio è.md']);
  // A newline in a name stays inside the entry with -z.
  assert.deepEqual(devIgnoredPaths('!! a\nb.txt\0'), ['a\nb.txt']);
});

test('instruction files besides the root AGENTS.md are found, the root one is not', () => {
  const files = ['AGENTS.md', 'CLAUDE.md', 'apps/core/AGENTS.md', 'packages/x/AGENTS.override.md', '.codex/config.toml', 'docs/AGENTS.md.bak', 'agents/reviewer.md', ''].join('\0');
  assert.deepEqual(devStrayInstructionFiles(files), ['apps/core/AGENTS.md', 'packages/x/AGENTS.override.md', '.codex/config.toml']);
  assert.deepEqual(devStrayInstructionFiles(['AGENTS.md', 'src/a.ts'].join('\0')), []);
});

test('a folder listed twice is refused', () => {
  assert.throws(() => devFilesystem(HOME, [HOME], []), /listed twice/);
});

test('the arguments: strict configuration, no approvals outside the sandbox, the features of the adapter off, the prompt after --', () => {
  const args = devArgs(HOME, [], [], ['--model', 'gpt-6.1-sol', 'scrivi i test']);
  assert.equal(args[0], '--strict-config');
  for (const option of ['approval_policy="never"', 'web_search="disabled"', 'allow_login_shell=false', 'shell_environment_policy.inherit="core"', 'default_permissions="arianna-dev"']) {
    assert.ok(args.includes(option), option);
  }
  assert.ok(!args.some((arg) => arg.includes('on-request')));
  for (const feature of CODEX_DISABLED_FEATURES) assert.ok(args.join(' ').includes(`--disable ${feature}`), feature);
  assert.deepEqual(args.slice(-6), ['--cd', HOME, '--model', 'gpt-6.1-sol', '--', 'scrivi i test']);
});

test('the extra arguments that would loosen the profile are refused, the model and a prompt pass', () => {
  for (const extra of [
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--dangerously-bypass-hook-trust'],
    ['-s', 'danger-full-access'],
    ['--sandbox', 'workspace-write'],
    ['--search'],
    ['-p', 'other'],
    ['--profile', 'other'],
    ['-c', 'default_permissions="other"'],
    ['-c', 'permissions.arianna-dev.filesystem={}'],
    ['-c', 'sandbox_mode="danger-full-access"'],
    ['-c', 'approval_policy="on-request"'],
    ['--config=approval_policy="on-request"'],
    ['--add-dir', '/'],
    ['-a', 'on-request'],
    ['--model', '--search'],
    ['--model'],
    ['prima', 'seconda'],
  ]) {
    assert.throws(() => devExtraArgs(extra), /non ammesso|nome di un modello/, extra.join(' '));
  }
  assert.deepEqual(devExtraArgs(['-m', 'gpt-6-luna', '--no-alt-screen']), { options: ['--model', 'gpt-6-luna', '--no-alt-screen'], prompt: [] });
  assert.deepEqual(devExtraArgs(['--model=gpt-6-astra', 'exec']), { options: ['--model', 'gpt-6-astra'], prompt: ['--', 'exec'] });
  assert.deepEqual(devExtraArgs([]), { options: [], prompt: [] });
});

test('the environment is the clean one of the adapter, with the terminal and git without the user configuration', () => {
  const env = devEnv({ PATH: '/usr/bin', HOME: '/srv/utente', TERM: 'xterm-256color', OPENAI_API_KEY: 'sk-finta', NODE_OPTIONS: '--require x', CODEX_HOME: '/elsewhere', HTTPS_PROXY: 'http://p', DATABASE_URL: 'postgres://x' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  for (const key of ['OPENAI_API_KEY', 'NODE_OPTIONS', 'CODEX_HOME', 'HTTPS_PROXY', 'DATABASE_URL']) assert.equal(env[key], undefined, key);
});

test('only the verified version of the binary passes', () => {
  assert.ok(devVersionOk('codex-cli 0.160.0\n'));
  assert.ok(!devVersionOk('codex-cli 0.161.0'));
  assert.ok(!devVersionOk('codex-cli 0.160.0-beta'));
  assert.ok(!devVersionOk(''));
});
