// The claude -p adapter against a fake binary that replays a recorded real
// stream (fixtures/fake-claude.ts). The real binary runs in `pnpm eval:live`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import {
  ClaudeError,
  claudeArgs,
  claudeEnv,
  ClaudeStream,
  claudeSettings,
  createClaudeExecutor,
  nodeToolchain,
  openRepository,
  prepareWorkspace,
  profileViolations,
  type ClaudeEvent,
  type ClaudeExecutorOptions,
  type ClaudeStart,
} from '@arianna/executors';
import { createContext, createLabelRules, gatewayCheck, markLogged, secretMatcher, type Label, type Target } from '@arianna/policy';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `claude-${randomUUID()}`);
const DATA = join(HOME, 'data');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.ts');
const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const SESSION = '00000000-0000-4000-8000-000000000001';
const SANDBOX = { workspace: '/w', readable: nodeToolchain(), denied: ['/arianna'] };
const RULES = createLabelRules({ folders: [{ path: 'repos', label: 'L1' }], sources: [] });

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

before(() => {
  const repo = join(HOME, 'repos', 'site');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.ts'), 'export {};\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

async function workspace() {
  const prepared = await prepareWorkspace({ home: HOME, data: DATA, repo: 'repos/site', runId: randomUUID(), allowlist: ['repos/site'], rules: RULES });
  assert.ok(prepared.path !== undefined);
  return { prepared, path: realpathSync(prepared.path) };
}

/** An allow as passGateway leaves it: checked and logged. */
function brief(text: string, label: Label = 'L1', target: Target = CLAUDE, logged = true) {
  const decision = gatewayCheck([{ value: text, label, source: 'test' }], createContext('L1'), target, secretMatcher([]));
  assert.equal(decision.decision, 'allow');
  if (logged) markLogged(decision);
  return decision;
}

const executor = (options: Partial<ClaudeExecutorOptions> = {}) =>
  createClaudeExecutor({
    enabled: ['claude'],
    command: { file: process.execPath, args: [FAKE] },
    home: HOME,
    env: { ...process.env, SOPS_AGE_KEY: 'fake-age-key', ANTHROPIC_API_KEY: 'fake-api-key', NODE_OPTIONS: '--inspect' },
    killGraceMs: 200,
    ...options,
  });

async function start(scenario: string, extra: Partial<ClaudeStart> = {}, options: Partial<ClaudeExecutorOptions> = {}) {
  const { prepared, path } = await workspace();
  const events: ClaudeEvent[] = [];
  const run = executor(options).start({
    brief: brief(`scenario: ${scenario}\nfake task`),
    workspace: prepared,
    model: 'sonnet',
    tools: ['Read', 'Grep'],
    onEvent: (event) => {
      events.push(event);
    },
    ...extra,
  });
  return { run, events, path, prepared };
}

const received = (path: string) =>
  JSON.parse(readFileSync(join(path, '.fake-claude.json'), 'utf8')) as { argv: string[]; env: Record<string, string>; prompt: string };

async function failure(promise: Promise<unknown>): Promise<ClaudeError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ClaudeError, String(error));
    return error;
  }
  assert.fail('the run should have failed');
}

describe('claude profile', () => {
  it('builds the confined arguments, with the prompt kept out of them', () => {
    const args = claudeArgs({ model: 'sonnet', tools: ['Read', 'Edit'], sandbox: SANDBOX });
    for (const flag of ['-p', '--strict-mcp-config', '--restricted', '--safe-mode', '--disable-slash-commands', '--no-chrome', '--verbose']) {
      assert.ok(args.includes(flag), flag);
    }
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(value('--output-format'), 'stream-json');
    assert.equal(value('--tools'), 'Read,Edit');
    assert.equal(value('--allowedTools'), 'Read,Edit');
    assert.equal(value('--permission-mode'), 'dontAsk');
    assert.equal(value('--permission-prompts'), 'none');
    assert.equal(value('--mcp-config'), '{"mcpServers":{}}');
    assert.ok(!args.includes('--bare') && !args.includes('--resume'));
    assert.deepEqual(claudeArgs({ model: 'opus', tools: [], resume: SESSION, sandbox: SANDBOX }).slice(-2), ['--resume', SESSION]);
  });

  it('refuses web tools, unknown tools and models, duplicates and a resume that is not a session id', () => {
    assert.throws(() => claudeArgs({ model: 'sonnet', tools: ['WebFetch' as never], sandbox: SANDBOX }), /not allowed/);
    assert.throws(() => claudeArgs({ model: 'sonnet', tools: ['Read', 'Read'], sandbox: SANDBOX }), /twice/);
    assert.throws(() => claudeArgs({ model: 'haiku' as never, tools: [], sandbox: SANDBOX }), /unknown model/);
    assert.throws(() => claudeArgs({ model: 'sonnet', tools: [], resume: '--dangerously-skip-permissions', sandbox: SANDBOX }), /session id/);
  });

  it('passes on only PATH, HOME and the user, never secrets, proxies or Node options', () => {
    const env = claudeEnv({ PATH: 'fake-path', HOME: 'fake-home', USER: 'x', SOPS_AGE_KEY: 'k', HTTPS_PROXY: 'http://p', NODE_OPTIONS: '-r x', ANTHROPIC_API_KEY: 'k' });
    assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'HOME', 'LANG', 'PATH', 'USER']);
  });

  it('accepts the init of a real run and names each field that breaks the profile', () => {
    const init = { cwd: '/w', tools: ['Read'], mcp_servers: [], permissionMode: 'dontAsk', apiKeySource: 'none', skills: [], slash_commands: [], plugins: [{ path: 'builtin' }] };
    assert.deepEqual(profileViolations(init, { cwd: '/w', tools: ['Read'] }), []);
    assert.deepEqual(
      profileViolations(
        { ...init, cwd: '/x', tools: ['Read', 'Bash'], mcp_servers: [{ name: 'gmail' }], permissionMode: 'default', apiKeySource: 'ANTHROPIC_API_KEY', skills: ['s'], slash_commands: ['/c'], plugins: [{ path: '/p' }] },
        { cwd: '/w', tools: ['Read'] },
      ),
      ['cwd', 'tools', 'mcp_servers', 'permissionMode', 'apiKeySource', 'skills', 'slash_commands', 'plugins'],
    );
  });
});

describe('claude stream', () => {
  const recorded = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8').trim().split('\n');
  const realInit = (cwd: string) => JSON.stringify({ ...(JSON.parse(recorded[0] ?? '') as object), cwd });

  it('reads a recorded real run: session, text, usage, rate limit and result', () => {
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    const events = [realInit('/w'), ...recorded.slice(1)].flatMap((line) => stream.feed(line));
    assert.deepEqual(
      events.map((event) => event.type),
      ['init', 'text', 'usage', 'rate-limit'],
    );
    assert.deepEqual(stream.result, { ok: true, text: 'ok', permissionDenials: 0 });
    assert.equal(stream.sessionRef, SESSION);
    assert.deepEqual(stream.usage, { tokensIn: 2 + 1675 + 1448, tokensOut: 4, turns: 1 });
    const limit = events[3];
    assert.ok(limit?.type === 'rate-limit');
    assert.equal(limit.window, 'five_hour');
    assert.equal(limit.utilization, 0.25);
    assert.equal(limit.resetsAt?.toISOString(), new Date(1_790_979_600_000).toISOString());
  });

  it('trusts nothing before init, and fails on a line that is not JSON', () => {
    const early = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    assert.deepEqual(early.feed(recorded[1] ?? ''), []);
    assert.equal(early.result?.failure, 'bad-output');
    const garbage = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    garbage.feed(realInit('/w'));
    garbage.feed('{"type":');
    assert.equal(garbage.result?.failure, 'bad-output');
  });

  it('a model response split in several messages counts once', () => {
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(realInit('/w'));
    stream.feed(recorded[1] ?? '');
    stream.feed(recorded[1] ?? '');
    assert.equal(stream.usage.turns, 1);
  });
});

describe('claude executor', () => {
  it('runs a trivial task in the workspace and returns the answer with the brief label', async () => {
    const { run, events, path } = await start('ok');
    const result = await run.result;
    assert.equal(result.text, 'ok');
    assert.equal(result.sessionRef, SESSION);
    assert.equal(result.label, 'L1');
    assert.equal(result.model, 'claude-sonnet-5-5');
    assert.equal(result.usage.turns, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      ['init', 'text', 'usage', 'rate-limit'],
    );
    assert.equal(result.permissionDenials, 0);
    const got = received(path);
    assert.equal(got.prompt, 'scenario: ok\nfake task');
    assert.ok(!got.argv.some((arg) => arg.includes('fake task')), 'the prompt is not in argv');
    for (const key of ['SOPS_AGE_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(got.env[key], undefined, key);
  });

  it('resumes a session in the same workspace', async () => {
    const { run, prepared, path } = await start('ok');
    const first = await run.result;
    const resumed = await executor().resume({ brief: brief('scenario: ok\nagain'), workspace: prepared, model: 'sonnet', tools: ['Read', 'Grep'], sessionRef: first.sessionRef })
      .result;
    assert.equal(resumed.text, 'resumed');
    assert.equal(resumed.sessionRef, first.sessionRef);
    assert.deepEqual(received(path).argv.slice(-2), ['--resume', SESSION]);
  });

  it('reports tool names and counts each model response as a turn', async () => {
    const { run, events } = await start('tool');
    const result = await run.result;
    assert.equal(result.usage.turns, 2);
    assert.deepEqual(
      events.filter((event) => event.type === 'tool'),
      [{ type: 'tool', name: 'Read' }],
    );
  });

  it('a quota refusal is a quota error with the time the subscription comes back', async () => {
    const { run } = await start('quota');
    const error = await failure(run.result);
    assert.equal(error.kind, 'quota');
    assert.equal(error.sessionRef, SESSION);
    assert.equal(error.resetsAt?.getTime(), 1_790_979_600_000);
  });

  it('an error of the binary, a crash and garbage are failures with their kind', async () => {
    assert.equal((await failure((await start('error')).run.result)).kind, 'execution');
    const crash = await failure((await start('crash')).run.result);
    assert.equal(crash.kind, 'exit');
    assert.equal(crash.exitCode, 3);
    assert.equal((await failure((await start('garbage')).run.result)).kind, 'bad-output');
    assert.equal((await failure((await start('before-init')).run.result)).kind, 'bad-output');
  });

  it('stops a run that breaks the profile: an extra tool, an MCP server, an API key, a user plugin', async () => {
    for (const [scenario, field] of [
      ['extra-tool', 'tools'],
      ['mcp', 'mcp_servers'],
      ['api-key', 'apiKeySource'],
      ['user-plugin', 'plugins'],
    ] as const) {
      const error = await failure((await start(scenario)).run.result);
      assert.equal(error.kind, 'profile', scenario);
      assert.deepEqual(error.violations, [field]);
      assert.equal(error.sessionRef, undefined, 'a session that broke the profile is not offered for resume');
    }
  });

  it('timeout, cancel and the turn limit stop the process, with SIGKILL if it ignores SIGTERM', async () => {
    assert.equal((await failure((await start('hang', { limits: { timeoutMs: 300 } })).run.result)).kind, 'timeout');
    assert.equal((await failure((await start('ignore-term', { limits: { timeoutMs: 300 } })).run.result)).kind, 'timeout');
    const { run } = await start('hang');
    setTimeout(() => { run.cancel(); }, 200);
    const cancelled = await failure(run.result);
    assert.equal(cancelled.kind, 'cancelled');
    assert.equal(cancelled.sessionRef, SESSION);
    const turns = await failure((await start('max-turns', { limits: { maxTurns: 3 } })).run.result);
    assert.equal(turns.kind, 'max-turns');
    assert.ok((turns.usage?.turns ?? 0) > 3);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await failure((await start('hang', { signal: aborted.signal })).run.result)).kind, 'cancelled');
  });

  it('a failing onEvent stops the run', async () => {
    const { run } = await start('hang', {
      onEvent: () => {
        throw new Error('database down');
      },
    });
    assert.equal((await failure(run.result)).kind, 'handler');
  });

  it('launches nothing when not enabled, without a gateway allow towards claude, or without a prepared workspace', async () => {
    const { prepared, path } = await workspace();
    const base = { workspace: prepared, model: 'sonnet' as const, tools: [] };
    const kind = async (promise: Promise<unknown>) => (await failure(promise)).kind;
    assert.equal(await kind(executor({ enabled: [] }).start({ ...base, brief: brief('scenario: ok') }).result), 'not-enabled');
    assert.equal(await kind(executor({ enabled: ['codex'] }).start({ ...base, brief: brief('scenario: ok') }).result), 'not-enabled');
    const forged = { decision: 'allow', rule: 'cloud', label: 'L0', reason: '', texts: ['scenario: ok'] };
    assert.equal(await kind(executor().start({ ...base, brief: forged }).result), 'not-cleared');
    const codex: Target = { kind: 'executor', id: 'codex', locality: 'cloud' };
    assert.equal(await kind(executor().start({ ...base, brief: brief('scenario: ok', 'L1', codex) }).result), 'not-cleared');
    const local = gatewayCheck([{ value: 'scenario: ok', label: 'L2', source: 'test' }], createContext('L2'), { kind: 'executor', id: 'omlx', locality: 'local' }, secretMatcher([]));
    markLogged(local);
    assert.equal(await kind(executor().start({ ...base, brief: brief('scenario: ok', 'L1', CLAUDE, false) }).result), 'not-cleared', 'not logged');
    assert.equal(await kind(executor().start({ ...base, brief: local }).result), 'not-cleared');
    assert.equal(await kind(executor().start({ ...base, brief: brief('scenario: ok'), workspace: { decision: prepared.decision, path } }).result), 'workspace');
    // Nothing was launched in the workspace.
    assert.throws(() => readFileSync(join(path, '.fake-claude.json')));
    // The project folder itself, opened by openRepository (D-056), is accepted like a prepared copy.
    const opened = await openRepository({ home: HOME, repo: 'repos/site', allowlist: ['repos/site'], rules: RULES });
    assert.ok(opened.path !== undefined);
    await executor().check({ workspace: opened, model: 'sonnet', tools: ['Read'] });
    await assert.rejects(executor().check({ workspace: { ...opened }, model: 'sonnet', tools: ['Read'] }), (error: unknown) => (error as { kind?: string }).kind === 'workspace');
  });

  it('a binary that cannot start is a spawn error', async () => {
    const { run } = await start('ok', {}, { command: { file: join(HOME, 'no-such-binary'), args: [] } });
    assert.equal((await failure(run.result)).kind, 'spawn');
  });
});

describe('claude executor, after review', () => {
  it('a brief is spent by its launch: the same decision cannot start a second run', async () => {
    const { prepared } = await workspace();
    const decision = brief('scenario: ok');
    const base = { brief: decision, workspace: prepared, model: 'sonnet' as const, tools: [] };
    await executor().start(base).result;
    assert.equal((await failure(executor().start(base).result)).kind, 'not-cleared');
  });

  it('an L0 brief gives an L1 answer: the run may have read the workspace', async () => {
    const { prepared } = await workspace();
    const result = await executor().start({ brief: brief('scenario: ok', 'L0'), workspace: prepared, model: 'sonnet', tools: ['Read'] }).result;
    assert.equal(result.label, 'L1');
  });

  it('refuses options the profile does not take before spending the brief', async () => {
    const { prepared } = await workspace();
    const decision = brief('scenario: ok');
    const base = { brief: decision, workspace: prepared, model: 'sonnet' as const };
    assert.equal((await failure(executor().start({ ...base, tools: ['WebSearch' as never] }).result)).kind, 'invalid-options');
    assert.equal((await failure(executor().start({ ...base, tools: [], limits: { maxTurns: 0 } }).result)).kind, 'invalid-options');
    assert.equal((await failure(executor().resume({ ...base, tools: [], sessionRef: 'not-a-session' }).result)).kind, 'invalid-options');
    await assert.rejects(executor().check({ workspace: prepared, model: 'sonnet', tools: ['WebSearch' as never] }), ClaudeError);
    await executor().check({ workspace: prepared, model: 'sonnet', tools: ['Read'] });
    // Still unspent: the refusals came first.
    assert.equal((await executor().start({ ...base, tools: [] }).result).text, 'ok');
  });

  it('a workspace folder replaced by a link, or removed, is refused', async () => {
    const { prepared, path } = await workspace();
    rmSync(path, { recursive: true });
    assert.equal((await failure(executor().start({ brief: brief('scenario: ok'), workspace: prepared, model: 'sonnet', tools: [] }).result)).kind, 'workspace');
    const other = await workspace();
    symlinkSync(other.path, path);
    assert.equal((await failure(executor().start({ brief: brief('scenario: ok'), workspace: prepared, model: 'sonnet', tools: [] }).result)).kind, 'workspace');
  });

  it('no tools: --tools is empty and nothing is pre-allowed', () => {
    const args = claudeArgs({ model: 'sonnet', tools: [], sandbox: SANDBOX });
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(!args.includes('--allowedTools'));
  });

  it('paid extra usage stops the run as overage, after reporting it', async () => {
    const { run, events } = await start('overage');
    assert.equal((await failure(run.result)).kind, 'overage');
    assert.ok(events.some((event) => event.type === 'rate-limit' && event.overage));
  });

  it('an HTTP 429 alone is a quota error; a 401 is an execution error with its status', async () => {
    assert.equal((await failure((await start('http-429')).run.result)).kind, 'quota');
    const login = await failure((await start('http-401')).run.result);
    assert.equal(login.kind, 'execution');
    assert.equal(login.apiStatus, 401);
  });

  it('the binary stopping at its own turn limit is max-turns; a success above the limit stays a success', async () => {
    assert.equal((await failure((await start('binary-max-turns')).run.result)).kind, 'max-turns');
    const { run } = await start('many-turns-ok', { limits: { maxTurns: 1 } });
    assert.equal((await run.result).text, 'ok');
  });

  it('subagent messages are not the answer', async () => {
    const { run, events } = await start('subagent');
    await run.result;
    assert.deepEqual(
      events.flatMap((event) => (event.type === 'text' ? [event.text] : [])),
      ['ok'],
    );
  });

  it('only plain codes from the binary reach the rate-limit event', async () => {
    const { run, events } = await start('odd-status');
    await run.result;
    const limit = events.find((event) => event.type === 'rate-limit');
    assert.ok(limit?.type === 'rate-limit');
    assert.equal(limit.status, 'unknown');
    assert.equal(limit.window, undefined);
  });

  it('a resume that starts another session, or a later init that breaks the profile, stops the run', async () => {
    const { prepared } = await workspace();
    const resumed = executor().resume({ brief: brief('scenario: new-session'), workspace: prepared, model: 'sonnet', tools: [], sessionRef: SESSION });
    const error = await failure(resumed.result);
    assert.equal(error.kind, 'profile');
    assert.deepEqual(error.violations, ['session']);
    const second = await failure((await start('second-init')).run.result);
    assert.equal(second.kind, 'profile');
    assert.deepEqual(second.violations, ['tools']);
  });

  it('counts the tool uses the permissions refused', async () => {
    const { run } = await start('denied');
    assert.equal((await run.result).permissionDenials, 1);
  });

  it('an onEvent that never settles cannot hang the run past its timeout', async () => {
    const { run } = await start('ok', { limits: { timeoutMs: 300 }, onEvent: () => new Promise<void>(() => undefined) });
    assert.equal((await failure(run.result)).kind, 'timeout');
  });
});

describe('claude sandbox (task 1.6)', () => {
  const settingsOf = (args: string[]) =>
    JSON.parse(args[args.indexOf('--settings') + 1] ?? '') as {
      permissions: Record<string, unknown>;
      sandbox: { network: Record<string, unknown>; filesystem: Record<string, unknown> } & Record<string, unknown>;
    };

  it('every launch carries the sandbox settings: no unsandboxed retry, no network, no loopback, reads closed outside', () => {
    const args = claudeArgs({ model: 'sonnet', tools: ['Bash'], sandbox: SANDBOX });
    const settings = settingsOf(args);
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(settings.sandbox.excludedCommands, []);
    assert.deepEqual(settings.sandbox.network, { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [], allowAllUnixSockets: false });
    assert.deepEqual(settings.sandbox.filesystem, { denyRead: ['/arianna'], allowRead: ['/w', ...SANDBOX.readable] });
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash');
  });

  it('sandbox folders must be absolute and normalized, never the root, and something must be denied', () => {
    for (const bad of ['relative/node', '/opt/../etc', '/', '']) {
      assert.throws(() => claudeSettings({ ...SANDBOX, readable: [bad] }), /readable folder/, bad);
      assert.throws(() => claudeSettings({ ...SANDBOX, workspace: bad }), /workspace folder/, bad);
    }
    assert.throws(() => claudeSettings({ ...SANDBOX, denied: [] }), /deny/);
    assert.doesNotThrow(() => claudeSettings({ ...SANDBOX, readable: ['/opt/homebrew'] }));
  });

  it('denies ARIANNA_HOME and the temp folders, and opens the workspace and the binary temp folder again', async () => {
    const { prepared, path } = await workspace();
    const run = executor().start({ brief: brief('scenario: ok'), workspace: prepared, model: 'sonnet', tools: ['Bash'] });
    await run.result;
    const settings = settingsOf(received(path).argv);
    const fs = settings.sandbox.filesystem as { denyRead: string[]; allowRead: string[] };
    assert.ok(fs.denyRead.includes(realpathSync(HOME)), 'ARIANNA_HOME');
    assert.ok(fs.denyRead.includes(realpathSync(tmpdir())), 'the temp folder');
    assert.ok(fs.denyRead.includes(realpathSync('/tmp')), '/tmp');
    assert.equal(fs.allowRead[0], path, 'the workspace first');
    assert.ok(fs.allowRead.some((folder) => folder.endsWith(`/claude-${String(process.getuid?.() ?? 0)}`)));
  });

  it('refuses at creation a readable folder that opens the home, a user root or a folder above them, with or without HOME', () => {
    const fakeHome = join(HOME, 'fake-home');
    mkdirSync(join(fakeHome, '.tool', 'bin'), { recursive: true });
    const env = { ...process.env, HOME: fakeHome };
    for (const folder of [fakeHome, HOME, '/Users', '/home', '/Volumes']) {
      assert.throws(() => createClaudeExecutor({ enabled: ['claude'], home: HOME, env, readable: [folder] }), /user's files/, folder);
    }
    assert.doesNotThrow(() => createClaudeExecutor({ enabled: ['claude'], home: HOME, env, readable: [join(fakeHome, '.tool', 'bin')] }));
    // No HOME: the account's home directory is protected all the same.
    const noHome = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'HOME'));
    assert.throws(() => createClaudeExecutor({ enabled: ['claude'], home: HOME, env: noHome, readable: [homedir()] }), /user's files/);
    assert.throws(() => createClaudeExecutor({ enabled: ['claude'], home: 'relative' }), /ARIANNA_HOME/);
  });

  it('observe sees every line of the stream', async () => {
    const lines: string[] = [];
    const { run } = await start('ok', {}, { observe: (line) => lines.push(line) });
    await run.result;
    assert.equal(lines.length, 4);
  });
});
