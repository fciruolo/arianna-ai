// The launch of interactive Codex on the development of Arianna (`pnpm dev:codex`, D-143).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CODEX_DEV_VERSION,
  CODEX_DISABLED_FEATURES,
  DEV_ALWAYS_DENIED,
  DEV_READ_ONLY,
  codexDevLaunch,
  devArgs,
  devChangedGitignores,
  devEnabledMcpServers,
  devEnv,
  devExtraArgs,
  devFilesystem,
  devIgnoredPaths,
  devStrayInstructionFiles,
  devVersionOk,
  userConfigRefusals,
} from '@arianna/executors';

const HOME = '/srv/arianna';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = join(ROOT, 'data', 'test-tmp', `codex-dev-${randomUUID()}`);
after(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

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

test('the user config: refused keys by name only, the subscription provider passes, unreadable TOML refuses', () => {
  assert.deepEqual(userConfigRefusals('model = "gpt-6.1-sol"\nmodel_provider = "openai"\ndeveloper_instructions = "segreto"\n'), []);
  assert.deepEqual(
    userConfigRefusals('notify = ["/bin/echo"]\nmodel_provider = "altro"\n[mcp_servers.posta]\ncommand = "x"\n[permissions.arianna-dev.network]\nenabled = true\n[profiles.p]\nmodel = "m"\n'),
    ['mcp_servers', 'notify', 'model_provider', 'profiles', 'permissions'],
  );
  assert.deepEqual(userConfigRefusals('model_instructions_file = "/x"\notel = {}\nchatgpt_base_url = "https://x"\n'), ['model_instructions_file', 'otel', 'chatgpt_base_url']);
  const refused = userConfigRefusals('[[[non toml');
  assert.equal(refused.length, 1);
  assert.match(refused[0] as string, /non leggibile/);
  // Never the values.
  assert.ok(!userConfigRefusals('notify = ["segreto-valore"]').join(' ').includes('segreto-valore'));
});

test('the MCP servers the binary would start: enabled ones by name, disabled ones pass, garbage refuses', () => {
  assert.deepEqual(devEnabledMcpServers('[]'), []);
  assert.deepEqual(devEnabledMcpServers('[{"name":"posta","enabled":true},{"name":"spento","enabled":false}]'), ['posta']);
  assert.equal(devEnabledMcpServers('non json').length, 1);
  assert.equal(devEnabledMcpServers('{}').length, 1);
});

test('changed or untracked .gitignore files are found, other changes and ignored ones are not', () => {
  const porcelain = [' M .gitignore', '?? apps/x/.gitignore', ' M package.json', '!! data/.gitignore', 'M  docs/a.md', ''].join('\0');
  assert.deepEqual(devChangedGitignores(porcelain), ['.gitignore', 'apps/x/.gitignore']);
  assert.deepEqual(devChangedGitignores(''), []);
});

test('the .codex and .agents folders are refused at any depth', () => {
  const files = ['.agents/skills/a/SKILL.md', 'apps/core/.codex/config.toml', 'packages/x/.agents/y.md', 'docs/codex/a.md', 'src/.codexrc'].join('\0');
  assert.deepEqual(devStrayInstructionFiles(files), ['.agents/skills/a/SKILL.md', 'apps/core/.codex/config.toml', 'packages/x/.agents/y.md']);
});

test('the nested .gitignore files found at launch are read only too', () => {
  const map = rules(devFilesystem(HOME, [], [], ['apps/hud/.gitignore']));
  assert.equal(map.get(`${HOME}/apps/hud/.gitignore`), 'read');
  assert.equal(map.get(`${HOME}/.gitignore`), 'read');
  assert.equal(map.get(`${HOME}/pnpm-workspace.yaml`), 'read');
});

interface Machine {
  version?: string;
  mcp?: string;
  userConfig?: string;
  globalInstructions?: boolean;
  files?: Record<string, string>;
  afterCommit?: Record<string, string>;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** A fake codex in PATH, a fake HOME and a git repository, all under data/test-tmp. */
function machine(options: Machine = {}): { repo: string; env: NodeJS.ProcessEnv } {
  const base = join(SCRATCH, randomUUID());
  const bin = join(base, 'bin');
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  for (const dir of [bin, join(home, '.codex'), repo]) mkdirSync(dir, { recursive: true });
  const codex = join(bin, 'codex');
  writeFileSync(
    codex,
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "codex-cli ${options.version ?? CODEX_DEV_VERSION}"; exit 0; fi`,
      `case " $* " in *" mcp list --json "*) echo '${options.mcp ?? '[]'}'; exit 0;; esac`,
      'exit 3',
      '',
    ].join('\n'),
  );
  chmodSync(codex, 0o755);
  if (options.userConfig !== undefined) writeFileSync(join(home, '.codex', 'config.toml'), options.userConfig);
  if (options.globalInstructions === true) writeFileSync(join(home, '.codex', 'AGENTS.md'), 'finte istruzioni globali\n');
  writeFiles(repo, { 'AGENTS.md': '# regole\n', '.gitignore': 'data/\n', 'src/a.ts': 'export {};\n', ...options.files });
  // Never the variables of the repository running the tests: under the pre-commit hook GIT_DIR and GIT_INDEX_FILE
  // point at Arianna's own repository, and `git init` there would rewrite its configuration.
  const gitEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base });
  execFileSync('git', ['init', '-q', repo], { env: gitEnv });
  execFileSync('git', ['-C', repo, 'add', '-A'], { env: gitEnv });
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'], { env: gitEnv });
  writeFiles(repo, options.afterCommit ?? {});
  return { repo, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, OPENAI_API_KEY: 'sk-finta' } };
}

test('codexDevLaunch: a clean machine passes, with the clean environment and without writing data/test-tmp', () => {
  const { repo, env } = machine({ userConfig: 'model = "gpt-6.1-sol"\ndeveloper_instructions = "x"\n', files: { 'apps/hud/.gitignore': 'dist/\n' } });
  const launch = codexDevLaunch(repo, ['--model', 'gpt-6.1-sol'], env);
  assert.equal(launch.args[0], '--strict-config');
  assert.ok(launch.args.includes('developer_instructions=""'));
  assert.ok(launch.args.some((arg) => arg.includes('network={enabled=false}')));
  assert.ok(launch.args.some((arg) => arg.includes(JSON.stringify(join(launch.cwd, 'apps', 'hud', '.gitignore')))));
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.ok(!existsSync(join(repo, 'data')));
});

test('codexDevLaunch refuses another version of the binary', () => {
  const { repo, env } = machine({ version: '0.161.0' });
  assert.throws(() => codexDevLaunch(repo, [], env), /0\.161\.0 non è la versione verificata/);
});

test('codexDevLaunch refuses the global instructions of the user', () => {
  const { repo, env } = machine({ globalInstructions: true });
  assert.throws(() => codexDevLaunch(repo, [], env), /istruzioni globali/);
});

test('codexDevLaunch refuses an AGENTS.override.md or a .codex folder in the root, even ignored, and a nested AGENTS.md', () => {
  const override = machine({ afterCommit: { 'AGENTS.override.md': 'altre regole\n' } });
  assert.throws(() => codexDevLaunch(override.repo, [], override.env), /AGENTS\.override\.md/);
  const folder = machine({ files: { '.gitignore': 'data/\n.codex/\n' }, afterCommit: { '.codex/config.toml': 'x = 1\n' } });
  assert.throws(() => codexDevLaunch(folder.repo, [], folder.env), /\.codex/);
  const nested = machine({ files: { 'apps/x/AGENTS.md': 'regole annidate\n' } });
  assert.throws(() => codexDevLaunch(nested.repo, [], nested.env), /apps\/x\/AGENTS\.md/);
});

test('codexDevLaunch refuses a .gitignore changed or untracked against HEAD', () => {
  const changed = machine({ afterCommit: { '.gitignore': '' } });
  assert.throws(() => codexDevLaunch(changed.repo, [], changed.env), /\.gitignore cambiato o non tracciato/);
  const untracked = machine({ afterCommit: { 'apps/y/.gitignore': '!data/\n' } });
  assert.throws(() => codexDevLaunch(untracked.repo, [], untracked.env), /apps\/y\/\.gitignore/);
});

test('codexDevLaunch refuses refused keys of the user config and enabled MCP servers', () => {
  const config = machine({ userConfig: 'notify = ["/bin/echo"]\n[mcp_servers.posta]\ncommand = "x"\n' });
  assert.throws(() => codexDevLaunch(config.repo, [], config.env), /mcp_servers, notify/);
  const listed = machine({ mcp: '[{"name":"gestito","enabled":true}]' });
  assert.throws(() => codexDevLaunch(listed.repo, [], listed.env), /server MCP \(gestito\)/);
});

test('codexDevLaunch refuses the dangerous extra arguments', () => {
  const { repo, env } = machine();
  assert.throws(() => codexDevLaunch(repo, ['--dangerously-bypass-approvals-and-sandbox'], env), /non ammesso/);
});
