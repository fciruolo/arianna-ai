// The codex exec adapter against a fake binary that replays a recorded real
// stream (fixtures/fake-codex.ts). The real binary runs in `pnpm eval:live`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import {
  CODEX_DISABLED_FEATURES,
  CodexError,
  codexArgs,
  codexEnv,
  codexFilesystem,
  CodexStream,
  codexToolchain,
  createCodexExecutor,
  openRepository,
  prepareWorkspace,
  type CodexEvent,
  type CodexExecutorOptions,
  type CodexStart,
} from '@arianna/executors';
import { createContext, createLabelRules, gatewayCheck, markLogged, secretMatcher, type Label, type Target } from '@arianna/policy';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `codex-${randomUUID()}`);
const DATA = join(HOME, 'data');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-codex.ts');
const RECORDED = join(import.meta.dirname, 'fixtures', 'codex-stream.jsonl');
const CODEX: Target = { kind: 'executor', id: 'codex', locality: 'cloud' };
const THREAD = '01a114e7-94d7-77c2-bb06-60bdefff158e';
const SANDBOX = { workspace: '/w', readable: ['/opt/homebrew/bin'], denied: ['/arianna', '/tmp'] };
const RULES = createLabelRules({ folders: [{ path: 'repos', label: 'L1' }], sources: [] });
const USER_HOME = join(HOME, 'user-home');

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

before(() => {
  const repo = join(HOME, 'repos', 'site');
  mkdirSync(repo, { recursive: true });
  mkdirSync(USER_HOME, { recursive: true });
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
function brief(text: string, label: Label = 'L1', target: Target = CODEX, logged = true) {
  const decision = gatewayCheck([{ value: text, label, source: 'test' }], createContext('L1'), target, secretMatcher([]));
  assert.equal(decision.decision, 'allow');
  if (logged) markLogged(decision);
  return decision;
}

const executor = (options: Partial<CodexExecutorOptions> = {}) =>
  createCodexExecutor({
    enabled: ['codex'],
    command: { file: process.execPath, args: [FAKE] },
    home: HOME,
    readable: [],
    env: { ...process.env, HOME: USER_HOME, SOPS_AGE_KEY: 'fake-age-key', OPENAI_API_KEY: 'fake-api-key', CODEX_HOME: '/elsewhere', NODE_OPTIONS: '--inspect' },
    killGraceMs: 200,
    ...options,
  });

async function start(scenario: string, extra: Partial<CodexStart> = {}, options: Partial<CodexExecutorOptions> = {}) {
  const { prepared, path } = await workspace();
  const events: CodexEvent[] = [];
  const run = executor(options).start({
    brief: brief(`scenario: ${scenario}\nfake task`),
    workspace: prepared,
    model: 'codex',
    access: 'write',
    onEvent: (event) => {
      events.push(event);
    },
    ...extra,
  });
  return { run, events, path, prepared };
}

const received = (path: string) => JSON.parse(readFileSync(join(path, '.fake-codex.json'), 'utf8')) as { argv: string[]; env: Record<string, string>; prompt: string };

async function failure(promise: Promise<unknown>): Promise<CodexError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CodexError, String(error));
    return error;
  }
  assert.fail('the run should have failed');
}

/** The values of every `-c` override. */
const overrides = (args: string[]) => args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));

describe('codex profile', () => {
  it('builds the confined arguments, with the prompt on stdin', () => {
    const args = codexArgs({ model: 'codex', access: 'write', sandbox: SANDBOX });
    assert.deepEqual(args.slice(0, 5), ['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules']);
    assert.equal(args.at(-1), '-');
    assert.equal(args[args.indexOf('--cd') + 1], '/w');
    assert.ok(!args.includes('--model'), 'the binary picks its default model');
    assert.ok(!args.includes('--ephemeral'));
    for (const forbidden of ['--dangerously-bypass-approvals-and-sandbox', '--oss', '--dangerously-bypass-hook-trust', '--add-dir', '--skip-git-repo-check']) {
      assert.ok(!args.includes(forbidden), forbidden);
    }
    const values = overrides(args);
    for (const expected of [
      'default_permissions="arianna"',
      'approval_policy="never"',
      'web_search="disabled"',
      'allow_login_shell=false',
      'shell_environment_policy.inherit="core"',
      'history.persistence="none"',
      'analytics.enabled=false',
      'project_doc_max_bytes=0',
      'skills.include_instructions=false',
      'skills.bundled.enabled=false',
    ]) {
      assert.ok(values.includes(expected), expected);
    }
    assert.ok(values.includes('permissions.arianna.filesystem={":minimal"="read", "/opt/homebrew/bin"="read", "/arianna"="deny", "/tmp"="deny", "/w"="write", "/w/.git"="read"}'));
    const disabled = args.flatMap((arg, index) => (args[index - 1] === '--disable' ? [arg] : []));
    // Checked first: deepEqual narrows the type of the list.
    for (const feature of ['apps', 'browser_use', 'computer_use', 'plugins', 'hooks', 'multi_agent', 'shell_snapshot']) assert.ok(disabled.includes(feature), feature);
    assert.deepEqual(disabled, [...CODEX_DISABLED_FEATURES]);
  });

  it('read access opens the workspace for reading only; write keeps its .git read only', () => {
    assert.ok(codexFilesystem(SANDBOX, 'read').endsWith('"/w"="read"}'));
    assert.ok(codexFilesystem(SANDBOX, 'write').endsWith('"/w"="write", "/w/.git"="read"}'));
    assert.throws(() => codexFilesystem(SANDBOX, 'all' as never), /access/);
  });

  it('refuses unknown models, a bad model name, a resume that is not a session id, and a resume of an unsaved session', () => {
    assert.throws(() => codexArgs({ model: 'gpt' as never, access: 'read', sandbox: SANDBOX }), /unknown model/);
    for (const name of ['-c', '--model', 'a b', '']) assert.throws(() => codexArgs({ model: 'codex', modelName: name, access: 'read', sandbox: SANDBOX }), /model name/, name);
    const named = codexArgs({ model: 'codex', modelName: 'gpt-5.5-codex', access: 'read', sandbox: SANDBOX });
    assert.equal(named[named.indexOf('--model') + 1], 'gpt-5.5-codex');
    assert.throws(() => codexArgs({ model: 'codex', access: 'read', resume: 'last', sandbox: SANDBOX }), /session id/);
    assert.throws(() => codexArgs({ model: 'codex', access: 'read', resume: THREAD, persistSession: false, sandbox: SANDBOX }), /cannot resume/);
    assert.throws(() => codexArgs({ model: 'codex', access: 'read', persistSession: 'no' as never, sandbox: SANDBOX }), /boolean/);
  });

  it('resumes with `resume <id>` after the options, without --cd; ephemeral only when asked (D-136)', () => {
    const args = codexArgs({ model: 'codex', access: 'write', resume: THREAD, sandbox: SANDBOX });
    assert.deepEqual(args.slice(-3), ['resume', THREAD, '-']);
    assert.ok(!args.includes('--cd'));
    assert.ok(codexArgs({ model: 'codex', access: 'write', persistSession: false, sandbox: SANDBOX }).includes('--ephemeral'));
  });

  it('sandbox folders must be absolute, normalized, not the root, TOML-safe and listed once; something must be denied', () => {
    for (const bad of ['relative/node', '/opt/../etc', '/', '', '/a"b', '/a\\b', '/a\nb']) {
      assert.throws(() => codexFilesystem({ ...SANDBOX, readable: [bad] }, 'read'), /readable folder/, bad);
      assert.throws(() => codexFilesystem({ ...SANDBOX, workspace: bad }, 'read'), /workspace folder/, bad);
    }
    assert.throws(() => codexFilesystem({ ...SANDBOX, denied: [] }, 'read'), /deny/);
    assert.throws(() => codexFilesystem({ ...SANDBOX, readable: ['/tmp'] }, 'read'), /twice/);
  });

  it('passes on only PATH, HOME and the user, never secrets, an API key, CODEX_HOME, proxies or Node options', () => {
    const env = codexEnv({ PATH: '/bin', HOME: '/h', USER: 'u', OPENAI_API_KEY: 'k', CODEX_HOME: '/x', HTTPS_PROXY: 'p', NODE_OPTIONS: 'n', PGPASSWORD: 's' });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'en_US.UTF-8' });
  });
});

describe('codex stream', () => {
  const feed = (lines: unknown[], expected: { sessionRef?: string } = {}) => {
    const stream = new CodexStream(expected);
    const events = lines.flatMap((line) => stream.feed(typeof line === 'string' ? line : JSON.stringify(line)));
    return { stream, events };
  };

  it('reads a recorded real run: thread, progress, command, file change, answer and usage', () => {
    const { stream, events } = feed(readFileSync(RECORDED, 'utf8').trim().split('\n'));
    assert.equal(stream.sessionRef, THREAD);
    assert.deepEqual(stream.result, { ok: true, text: 'done', permissionDenials: 0 });
    assert.deepEqual(
      events.map((event) => event.type),
      ['init', 'text', 'tool', 'tool', 'file', 'text', 'usage'],
    );
    assert.deepEqual(events[4], { type: 'file', path: '/w/README.md', kind: 'update' });
    assert.deepEqual(stream.usage, { tokensIn: 28_879, tokensOut: 156, turns: 2, context: 29_035 });
    assert.ok(!JSON.stringify(events).includes('README.md\\n'), 'no command output in the events');
  });

  it('trusts nothing before the thread, and fails on a line that is not JSON', () => {
    assert.equal(feed([{ type: 'turn.started' }]).stream.result?.failure, 'bad-output');
    assert.equal(feed([{ type: 'thread.started', thread_id: THREAD }, 'not json']).stream.result?.failure, 'bad-output');
    assert.equal(feed([{ type: 'thread.started' }]).stream.result?.failure, 'bad-output');
    assert.equal(feed([{ type: 'thread.started', thread_id: THREAD }, { type: 'item.started' }]).stream.result?.failure, 'bad-output');
  });

  it('an item outside the closed list is a profile violation named by its type, never by free text', () => {
    const thread = { type: 'thread.started', thread_id: THREAD };
    for (const type of ['mcp_tool_call', 'web_search', 'collab_tool_call']) {
      const { stream } = feed([thread, { type: 'item.started', item: { type } }]);
      assert.deepEqual(stream.result, { ok: false, failure: 'profile', violations: [`item:${type}`] }, type);
    }
    assert.deepEqual(feed([thread, { type: 'item.started', item: { type: 'Leak: secret text' } }]).stream.result?.violations, ['item:unknown']);
  });

  it('a resume must continue the session asked for', () => {
    const { stream } = feed([{ type: 'thread.started', thread_id: '01a114e7-0000-7000-8000-000000000002' }], { sessionRef: THREAD });
    assert.deepEqual(stream.result, { ok: false, failure: 'profile', violations: ['session'] });
    assert.equal(feed([{ type: 'thread.started', thread_id: THREAD }], { sessionRef: THREAD }).stream.result, undefined);
  });

  it('a used-up plan or an HTTP 429 is quota; another API error is execution with its status, never its text', () => {
    const thread = { type: 'thread.started', thread_id: THREAD };
    const json = (status: number) => JSON.stringify({ type: 'error', status, error: { message: 'secret words' } });
    assert.deepEqual(feed([thread, { type: 'turn.failed', error: { message: "You've hit your usage limit." } }]).stream.result, { ok: false, failure: 'quota' });
    assert.deepEqual(feed([thread, { type: 'turn.failed', error: { message: json(429) } }]).stream.result, { ok: false, failure: 'quota', apiStatus: 429 });
    assert.deepEqual(feed([thread, { type: 'error', message: json(401) }, { type: 'turn.failed', error: {} }]).stream.result, { ok: false, failure: 'execution', apiStatus: 401 });
    assert.deepEqual(feed([thread, { type: 'turn.failed' }]).stream.result, { ok: false, failure: 'execution' });
  });

  it('warnings, reasoning, plans and unknown events pass; odd file changes keep only valid entries', () => {
    const { stream, events } = feed([
      { type: 'thread.started', thread_id: THREAD },
      { type: 'item.completed', item: { type: 'error', message: 'fallback metadata' } },
      { type: 'item.completed', item: { type: 'reasoning', text: 'x' } },
      { type: 'something.new' },
      { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/w/a', kind: 'rename' }, { path: '/w/b', kind: 'add' }, null] } },
      { type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 'many' } },
    ]);
    assert.equal(stream.result?.ok, true);
    assert.equal(stream.result.text, '');
    assert.deepEqual(
      events.filter((event) => event.type === 'file'),
      [{ type: 'file', path: '/w/b', kind: 'add' }],
    );
    assert.deepEqual(stream.usage, { tokensIn: 0, tokensOut: 0, turns: 1, context: 0 });
  });
});

describe('codex executor', () => {
  it('runs a trivial task in the workspace and returns the answer with the brief label', async () => {
    const { run, events, path } = await start('ok');
    const result = await run.result;
    assert.equal(result.text, 'ok');
    assert.equal(result.sessionRef, THREAD);
    assert.equal(result.label, 'L1');
    assert.equal(result.model, '');
    assert.deepEqual(
      events.map((event) => event.type),
      ['init', 'text', 'usage'],
    );
    const got = received(path);
    assert.equal(got.prompt, 'scenario: ok\nfake task');
    assert.ok(!got.argv.some((arg) => arg.includes('fake task')), 'the prompt is not in argv');
    assert.equal(got.argv[got.argv.indexOf('--cd') + 1], path);
    for (const key of ['SOPS_AGE_KEY', 'OPENAI_API_KEY', 'CODEX_HOME', 'NODE_OPTIONS']) assert.equal(got.env[key], undefined, key);
  });

  it('asks for the exact model name at each launch, and refuses a bad one before starting (D-071)', async () => {
    let name: string | undefined = 'gpt-5.5-codex';
    const options = { modelName: () => name };
    const { run, path } = await start('ok', {}, options);
    assert.equal((await run.result).model, 'gpt-5.5-codex');
    assert.equal(received(path).argv[received(path).argv.indexOf('--model') + 1], 'gpt-5.5-codex');
    name = '--dangerously-bypass-approvals-and-sandbox';
    const bad = await start('ok', {}, options);
    assert.equal((await failure(bad.run.result)).kind, 'invalid-options');
    assert.throws(() => readFileSync(join(bad.path, '.fake-codex.json')), 'nothing launched');
  });

  it('resumes a session in the same workspace, and refuses to resume one that was not saved (D-136)', async () => {
    const { prepared, path } = await workspace();
    const resumed = await executor().resume({ brief: brief('scenario: ok'), workspace: prepared, model: 'codex', access: 'write', sessionRef: THREAD }).result;
    assert.equal(resumed.text, 'resumed');
    assert.deepEqual(received(path).argv.slice(-3), ['resume', THREAD, '-']);
    const decision = brief('scenario: ok');
    const refused = executor().resume({ brief: decision, workspace: prepared, model: 'codex', access: 'write', sessionRef: THREAD, persistSession: false });
    assert.equal((await failure(refused.result)).kind, 'invalid-options');
    // Still unspent: the refusal came first.
    const ephemeral = await executor().start({ brief: decision, workspace: prepared, model: 'codex', access: 'write', persistSession: false }).result;
    assert.equal(ephemeral.text, 'ok');
    assert.ok(received(path).argv.includes('--ephemeral'));
  });

  it('reports commands and file changes, and counts them as turns', async () => {
    const { run, events } = await start('tool');
    const result = await run.result;
    assert.equal(result.text, 'done');
    assert.equal(result.usage.turns, 2);
    assert.deepEqual(
      events.filter((event) => event.type === 'tool'),
      [
        { type: 'tool', name: 'command' },
        { type: 'tool', name: 'file_change' },
      ],
    );
  });

  it('quota, API errors, a crash, garbage and an unfinished turn are failures with their kind', async () => {
    assert.equal((await failure((await start('quota')).run.result)).kind, 'quota');
    const limited = await failure((await start('http-429')).run.result);
    assert.deepEqual([limited.kind, limited.apiStatus], ['quota', 429]);
    const refused = await failure((await start('error')).run.result);
    assert.deepEqual([refused.kind, refused.apiStatus, refused.sessionRef], ['execution', 400, THREAD]);
    assert.ok(!refused.message.includes('ChatGPT'), 'no text of the binary in the error');
    const crashed = await failure((await start('crash')).run.result);
    assert.deepEqual([crashed.kind, crashed.exitCode], ['exit', 3]);
    assert.equal((await failure((await start('garbage')).run.result)).kind, 'bad-output');
    assert.equal((await failure((await start('before-thread')).run.result)).kind, 'bad-output');
    assert.equal((await failure((await start('no-turn')).run.result)).kind, 'exit');
    const late = await failure((await start('exit-after-turn')).run.result);
    assert.deepEqual([late.kind, late.exitCode], ['exit', 2]);
  });

  it('stops a run that shows an MCP call, a web search or another session', async () => {
    for (const [scenario, violation] of [
      ['mcp', 'item:mcp_tool_call'],
      ['web-search', 'item:web_search'],
    ] as const) {
      const error = await failure((await start(scenario)).run.result);
      assert.deepEqual([error.kind, error.violations], ['profile', [violation]], scenario);
    }
    const { prepared } = await workspace();
    const other = executor().resume({ brief: brief('scenario: new-session'), workspace: prepared, model: 'codex', access: 'read', sessionRef: THREAD });
    assert.deepEqual((await failure(other.result)).violations, ['session']);
  });

  it('timeout, cancel and the turn limit stop the process, with SIGKILL if it ignores SIGTERM', async () => {
    assert.equal((await failure((await start('hang', { limits: { timeoutMs: 300 } })).run.result)).kind, 'timeout');
    let ignored: CodexError | undefined;
    for (const timeoutMs of [400, 2_000, 8_000]) {
      ignored = await failure((await start('ignore-term', { limits: { timeoutMs } })).run.result);
      assert.equal(ignored.kind, 'timeout');
      assert.equal(ignored.exitCode, undefined, 'ended by a signal, not by an exit');
      if (ignored.sessionRef !== undefined) break;
    }
    assert.equal(ignored?.sessionRef, THREAD, 'SIGTERM reached a process that ignores it: only SIGKILL stopped it');
    let cancel: () => void = () => undefined;
    const { run } = await start('hang', {
      onEvent: (event) => {
        if (event.type === 'init') cancel();
      },
    });
    cancel = () => {
      run.cancel();
    };
    const cancelled = await failure(run.result);
    assert.deepEqual([cancelled.kind, cancelled.sessionRef], ['cancelled', THREAD]);
    const turns = await failure((await start('many-tools', { limits: { maxTurns: 3 } })).run.result);
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

  it('launches nothing when not enabled, without a gateway allow towards codex, or without a prepared workspace', async () => {
    const { prepared, path } = await workspace();
    const base = { workspace: prepared, model: 'codex' as const, access: 'read' as const };
    const kind = async (promise: Promise<unknown>) => (await failure(promise)).kind;
    assert.equal(await kind(executor({ enabled: [] }).start({ ...base, brief: brief('scenario: ok') }).result), 'not-enabled');
    assert.equal(await kind(executor({ enabled: ['claude'] }).start({ ...base, brief: brief('scenario: ok') }).result), 'not-enabled');
    const forged = { decision: 'allow', rule: 'cloud', label: 'L0', reason: '', texts: ['scenario: ok'] };
    assert.equal(await kind(executor().start({ ...base, brief: forged }).result), 'not-cleared');
    const claude: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
    assert.equal(await kind(executor().start({ ...base, brief: brief('scenario: ok', 'L1', claude) }).result), 'not-cleared');
    assert.equal(await kind(executor().start({ ...base, brief: brief('scenario: ok', 'L1', CODEX, false) }).result), 'not-cleared', 'not logged');
    assert.equal(await kind(executor().start({ ...base, brief: brief('scenario: ok'), workspace: { decision: prepared.decision, path } }).result), 'workspace');
    assert.throws(() => readFileSync(join(path, '.fake-codex.json')), 'nothing launched');
    // Read at each launch (D-071): turned off in the file, the next launch is refused.
    let live = ['codex'];
    const following = executor({ enabled: () => live });
    const other = { ...base, workspace: (await workspace()).prepared };
    await following.start({ ...other, brief: brief('scenario: ok') }).result;
    live = [];
    assert.equal(await kind(following.start({ ...other, brief: brief('scenario: ok') }).result), 'not-enabled');
    // The project folder itself, opened by openRepository (D-056), is accepted like a prepared copy.
    const opened = await openRepository({ home: HOME, project: { name: 'site', absolute: join(HOME, 'repos', 'site'), label: 'L1' } });
    assert.ok(opened.path !== undefined);
    await executor().check({ workspace: opened, model: 'codex', access: 'read' });
    await assert.rejects(executor().check({ workspace: { ...opened }, model: 'codex', access: 'read' }), (error: unknown) => (error as { kind?: string }).kind === 'workspace');
  });

  it('a brief is spent by its launch, and an L0 brief gives an L1 answer', async () => {
    const { prepared } = await workspace();
    const decision = brief('scenario: ok', 'L0');
    const base = { brief: decision, workspace: prepared, model: 'codex' as const, access: 'read' as const };
    assert.equal((await executor().start(base).result).label, 'L1');
    assert.equal((await failure(executor().start(base).result)).kind, 'not-cleared');
  });

  it('refuses bad options before spending the brief, and a replaced or removed workspace', async () => {
    const { prepared, path } = await workspace();
    const decision = brief('scenario: ok');
    const base = { brief: decision, workspace: prepared, model: 'codex' as const };
    assert.equal((await failure(executor().start({ ...base, access: 'all' as never }).result)).kind, 'invalid-options');
    assert.equal((await failure(executor().start({ ...base, access: 'read', limits: { maxTurns: 0 } }).result)).kind, 'invalid-options');
    assert.equal((await failure(executor().resume({ ...base, access: 'read', sessionRef: 'last' }).result)).kind, 'invalid-options');
    assert.equal((await executor().start({ ...base, access: 'read' }).result).text, 'ok', 'still unspent');
    rmSync(path, { recursive: true });
    assert.equal((await failure(executor().start({ ...base, brief: brief('scenario: ok'), access: 'read' }).result)).kind, 'workspace');
    symlinkSync((await workspace()).path, path);
    assert.equal((await failure(executor().start({ ...base, brief: brief('scenario: ok'), access: 'read' }).result)).kind, 'workspace');
  });

  it("refuses to launch while the user's global Codex instructions exist, without spending the brief", async () => {
    for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
      const home = join(HOME, `instructed-${name}`);
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', name), 'fake user instructions\n');
      const { prepared, path } = await workspace();
      const decision = brief('scenario: ok');
      const instructed = executor({ env: { ...process.env, HOME: home } });
      const refused = await failure(instructed.start({ brief: decision, workspace: prepared, model: 'codex', access: 'read' }).result);
      assert.deepEqual([refused.kind, refused.violations], ['profile', ['user-instructions']], name);
      assert.throws(() => readFileSync(join(path, '.fake-codex.json')), 'nothing launched');
      rmSync(join(home, '.codex', name));
      assert.equal((await instructed.start({ brief: decision, workspace: prepared, model: 'codex', access: 'read' }).result).text, 'ok', 'removed: the same brief runs');
    }
  });

  it('a binary that cannot start is a spawn error', async () => {
    const { run } = await start('ok', {}, { command: { file: join(HOME, 'no-such-binary'), args: [] } });
    assert.equal((await failure(run.result)).kind, 'spawn');
  });

  it('observe sees every line of the stream', async () => {
    const lines: string[] = [];
    const { run } = await start('ok', {}, { observe: (line) => lines.push(line) });
    await run.result;
    assert.equal(lines.length, 4);
  });
});

describe('codex sandbox', () => {
  const filesystemOf = (argv: string[]) => overrides(argv).find((value) => value.startsWith('permissions.arianna.filesystem=')) ?? '';

  it('denies ARIANNA_HOME and the temp folders, and opens the workspace for writing', async () => {
    const { run, path } = await start('ok');
    await run.result;
    const filesystem = filesystemOf(received(path).argv);
    assert.ok(filesystem.includes(`"${realpathSync(HOME)}"="deny"`), 'ARIANNA_HOME');
    assert.ok(filesystem.includes(`"${realpathSync(tmpdir())}"="deny"`), 'the temp folder');
    assert.ok(filesystem.includes('"/tmp"="deny"') && filesystem.includes(`"${realpathSync('/tmp')}"="deny"`), '/tmp, both spellings');
    assert.ok(filesystem.endsWith(`"${path}"="write", "${path}/.git"="read"}`), 'the workspace last, its .git read only');
  });

  it('the default toolchain holds the folder of codex on PATH and the real one, never a package var folder', () => {
    const bin = join(HOME, 'tool', 'bin');
    const cellar = join(HOME, 'tool', 'Cellar', 'codex', '1.0', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(cellar, { recursive: true });
    writeFileSync(join(cellar, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync(join(cellar, 'codex'), join(bin, 'codex'));
    const folders = codexToolchain({ PATH: `/nonexistent:${bin}` });
    assert.ok(folders.includes(realpathSync(bin)) && folders.includes(realpathSync(cellar)));
    assert.ok(!folders.some((folder) => folder.endsWith('/var')));
    assert.ok(!codexToolchain({ PATH: '/nonexistent' }).some((folder) => folder.startsWith(realpathSync(HOME))), 'no codex on PATH: no folder of it');
  });

  it('the default readable folders hold the toolchain, never a user folder', () => {
    const created = createCodexExecutor({ enabled: ['codex'], home: HOME });
    assert.ok(created);
    const fakeHome = join(HOME, 'fake-home');
    mkdirSync(join(fakeHome, '.tool', 'bin'), { recursive: true });
    const env = { ...process.env, HOME: fakeHome };
    for (const folder of [fakeHome, HOME, '/Users', '/home', '/Volumes']) {
      assert.throws(() => createCodexExecutor({ enabled: ['codex'], home: HOME, env, readable: [folder] }), /user's files/, folder);
    }
    const noHome = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'HOME'));
    assert.throws(() => createCodexExecutor({ enabled: ['codex'], home: HOME, env: noHome, readable: [homedir()] }), /user's files/);
    // ARIANNA_HOME and the shared temp folders stay denied: a readable folder inside or around them is refused, never dropped.
    for (const folder of [join(HOME, 'data'), '/tmp', realpathSync(tmpdir()), '/private']) {
      assert.throws(() => createCodexExecutor({ enabled: ['codex'], home: HOME, readable: [folder] }), /ARIANNA_HOME or a shared temp folder/, folder);
    }
    assert.throws(() => createCodexExecutor({ enabled: ['codex'], home: 'relative' }), /ARIANNA_HOME/);
  });
});
