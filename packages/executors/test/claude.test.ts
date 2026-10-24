// The claude -p adapter against a fake binary that replays a recorded real
// stream (fixtures/fake-claude.ts). The real binary runs in `pnpm eval:live`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import {
  ClaudeError,
  claudeArgs,
  claudeEnv,
  ClaudeStream,
  fileEditOf,
  claudeSettings,
  createClaudeExecutor,
  nodeToolchain,
  MCP_LAUNCH_ENV,
  openRepository,
  prepareMcp,
  prepareWorkspace,
  profileViolations,
  type ClaudeEvent,
  type ClaudeExecutorOptions,
  type ClaudeStart,
} from '@arianna/executors';
import { createContext, createLabelRules, fakePiiCheck, gatewayCheck as gatewayCheckWithPii, markLogged, secretMatcher, type Label, type Target } from '@arianna/policy';

import { guardians, noGuardianLeft } from './support/guardians.ts';

// The second scanner (D-113) finds nothing here: these tests are about the other rules (pii.test.ts has its own).
const gatewayCheck = (
  payload: Parameters<typeof gatewayCheckWithPii>[0],
  context: Parameters<typeof gatewayCheckWithPii>[1],
  target: Parameters<typeof gatewayCheckWithPii>[2],
  secrets: Parameters<typeof gatewayCheckWithPii>[3],
) => gatewayCheckWithPii(payload, context, target, secrets, fakePiiCheck(payload));

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
  JSON.parse(readFileSync(join(path, '.fake-claude.json'), 'utf8')) as { argv: string[]; env: Record<string, string>; prompt: string; mcpConfig?: unknown };

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
    for (const flag of ['-p', '--strict-mcp-config', '--restricted', '--safe-mode', '--disable-slash-commands', '--no-chrome', '--verbose', '--include-partial-messages']) {
      assert.ok(args.includes(flag), flag);
    }
    // D-249: the partial messages are the only output option added; once, and before the model.
    assert.equal(args.filter((arg) => arg === '--include-partial-messages').length, 1);
    assert.ok(args.indexOf('--include-partial-messages') < args.indexOf('--model'));
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

  it('keeps the session off disk only when asked, and never resumes one that was not saved (D-136)', () => {
    // Positive: the default saves the session as before; false adds the flag next to -p.
    assert.ok(!claudeArgs({ model: 'sonnet', tools: [], sandbox: SANDBOX }).includes('--no-session-persistence'));
    assert.ok(!claudeArgs({ model: 'sonnet', tools: [], persistSession: true, sandbox: SANDBOX }).includes('--no-session-persistence'));
    const args = claudeArgs({ model: 'sonnet', tools: ['Read'], persistSession: false, sandbox: SANDBOX });
    assert.ok(args.includes('--no-session-persistence') && args.includes('-p'));
    assert.equal(args.filter((arg) => arg === '--no-session-persistence').length, 1);
    // The rest of the profile is unchanged by it.
    const saved = claudeArgs({ model: 'sonnet', tools: ['Read'], sandbox: SANDBOX });
    assert.deepEqual(args.filter((arg) => arg !== '--no-session-persistence'), saved);
    // A saved session still resumes.
    assert.deepEqual(claudeArgs({ model: 'sonnet', tools: [], persistSession: true, resume: SESSION, sandbox: SANDBOX }).slice(-2), ['--resume', SESSION]);
    // Negative: no resume of an unsaved session, and nothing but a boolean reads as the choice.
    assert.throws(() => claudeArgs({ model: 'sonnet', tools: [], persistSession: false, resume: SESSION, sandbox: SANDBOX }), /not saved cannot resume/);
    for (const value of ['false', 0, null]) {
      assert.throws(() => claudeArgs({ model: 'sonnet', tools: [], persistSession: value as never, sandbox: SANDBOX }), /must be a boolean/, String(value));
    }
  });

  it('passes the exact model name of [cloud.models] to --model, never one that reads as a flag (D-071)', () => {
    const model = (args: string[]) => args[args.indexOf('--model') + 1];
    assert.equal(model(claudeArgs({ model: 'opus', tools: [], sandbox: SANDBOX })), 'opus');
    assert.equal(model(claudeArgs({ model: 'opus', modelName: 'claude-opus-5-5[1m]', tools: [], sandbox: SANDBOX })), 'claude-opus-5-5[1m]');
    for (const name of ['--dangerously-skip-permissions', '-p', '', 'claude opus', 'opus;rm', 'a'.repeat(101)]) {
      assert.throws(() => claudeArgs({ model: 'opus', modelName: name, tools: [], sandbox: SANDBOX }), /model name/, name);
    }
    assert.throws(() => claudeArgs({ model: 'opus', modelName: 42 as never, tools: [], sandbox: SANDBOX }), /model name/);
    // The router saw the alias: another family would skip Fable's budget approval.
    for (const name of ['claude-fable-5-1', 'fable', 'sonnet', 'opusx']) {
      assert.throws(() => claudeArgs({ model: 'opus', modelName: name, tools: [], sandbox: SANDBOX }), /not of the opus family/, name);
    }
    assert.equal(claudeArgs({ model: 'opus', modelName: 'opus[1m]', tools: [], sandbox: SANDBOX }).includes('opus[1m]'), true);
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
  it('reports the version of the binary only when it is a plain X.Y.Z (D-233)', () => {
    const recordedInit = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8').split('\n')[0] ?? '') as Record<string, unknown>;
    const versionOf = (value: unknown): string | undefined => {
      const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
      const [init] = stream.feed(JSON.stringify({ ...recordedInit, cwd: '/w', claude_code_version: value }));
      assert.ok(init?.type === 'init');
      return init.version;
    };
    assert.equal(versionOf('2.1.300'), '2.1.300');
    assert.equal(versionOf('2.1.300 (Claude Code) extra'), undefined);
    assert.equal(versionOf(2), undefined);
    assert.equal(versionOf(undefined), undefined);
  });

  const recorded = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8').trim().split('\n');
  // The recorded assistant message, past the partial messages built by hand (D-249).
  const recordedAssistant = recorded.find((line) => (JSON.parse(line) as { type: string }).type === 'assistant') ?? '';
  const realInit = (cwd: string) => JSON.stringify({ ...(JSON.parse(recorded[0] ?? '') as object), cwd });

  it('reads a recorded real run: session, text, usage, rate limit and result', () => {
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    const events = [realInit('/w'), ...recorded.slice(1)].flatMap((line) => stream.feed(line));
    // The stream_event lines are built by hand on the documented format (D-249), the rest is recorded.
    assert.deepEqual(
      events.map((event) => event.type),
      ['init', 'thinking', 'thinking', 'thinking', 'text-delta', 'text-delta', 'text', 'usage', 'rate-limit'],
    );
    assert.deepEqual(
      events.flatMap((event) => (event.type === 'thinking' ? [event.text] : [])),
      ['', 'Basta rispondere ', 'ok.'],
    );
    // The whole block says its text came in pieces: a caller showing the pieces does not show it twice.
    assert.deepEqual(events[6], { type: 'text', text: 'ok', streamed: true });
    assert.deepEqual(stream.result, { ok: true, text: 'ok', permissionDenials: 0 });
    assert.equal(stream.sessionRef, SESSION);
    assert.deepEqual(stream.usage, { tokensIn: 2 + 1675 + 1448, tokensOut: 4, turns: 1, context: 2 + 1675 + 1448 + 4 });
    // D-233: the version of the binary, for «Cosa è cambiato».
    const init = events[0];
    assert.ok(init?.type === 'init');
    assert.equal(init.version, '2.1.288');
    const limit = events[8];
    assert.ok(limit?.type === 'rate-limit');
    assert.equal(limit.window, 'five_hour');
    assert.equal(limit.utilization, 0.25);
    assert.equal(limit.resetsAt?.toISOString(), new Date(1_790_979_600_000).toISOString());
  });

  it('reads the partial messages of the answer and of the thinking, never those of a subagent (D-249)', () => {
    const partial = (event: unknown, parent: string | null = null) => JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: parent, session_id: SESSION });
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(realInit('/w'));
    // A thinking block whose text the API withholds (display omitted): only its start and a signature.
    assert.deepEqual(stream.feed(partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })), [{ type: 'thinking', text: '' }]);
    assert.deepEqual(stream.feed(partial({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } })), []);
    assert.deepEqual(stream.feed(partial({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } })), [{ type: 'thinking', text: '' }]);
    // Negative: a subagent's pieces, a tool's input being written, empty and odd shapes.
    assert.deepEqual(stream.feed(partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'altro' } }, 'toolu_1')), []);
    assert.deepEqual(stream.feed(partial({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } })), []);
    assert.deepEqual(stream.feed(partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '' } })), []);
    assert.deepEqual(stream.feed(partial('nope')), []);
    assert.deepEqual(stream.feed(JSON.stringify({ type: 'stream_event' })), []);
    assert.equal(stream.result, undefined);
    // A text block without pieces before it is not marked as streamed.
    const plain = stream.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ciao' }] }, parent_tool_use_id: null }));
    assert.deepEqual(plain, [{ type: 'text', text: 'ciao' }]);
  });

  it('the context is the latest response, not the sum of the run (D-111)', () => {
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(realInit('/w'));
    const assistant = (id: string, input: number, output: number) =>
      JSON.stringify({ type: 'assistant', message: { id, content: [], usage: { input_tokens: input, cache_read_input_tokens: 10, output_tokens: output } } });
    stream.feed(assistant('a', 100, 5));
    stream.feed(assistant('b', 200, 7));
    assert.deepEqual(stream.usage, { tokensIn: 110 + 210, tokensOut: 12, turns: 2, context: 210 + 7 });
    const fresh = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    fresh.feed(realInit('/w'));
    assert.equal(fresh.usage.context, undefined);
  });

  it('trusts nothing before init, and fails on a line that is not JSON', () => {
    const early = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    assert.deepEqual(early.feed(recordedAssistant), []);
    assert.equal(early.result?.failure, 'bad-output');
    const garbage = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    garbage.feed(realInit('/w'));
    garbage.feed('{"type":');
    assert.equal(garbage.result?.failure, 'bad-output');
  });

  it('reports the changes to files of Edit, MultiEdit and Write after their tool name (D-117)', () => {
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(realInit('/w'));
    const assistant = JSON.parse(recordedAssistant) as { message: Record<string, unknown> };
    const use = (name: string, input: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ ...assistant, ...extra, message: { ...assistant.message, id: `msg_${name}`, content: [{ type: 'tool_use', id: 't', name, input }] } });
    const events = [
      use('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }),
      use('MultiEdit', { file_path: 'b.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '' }] }),
      use('Write', { file_path: '/w/c.md', content: '# C\n' }),
    ].flatMap((line) => stream.feed(line).filter((event) => event.type !== 'usage'));
    assert.deepEqual(events, [
      { type: 'tool', name: 'Edit' },
      { type: 'edit', tool: 'Edit', filePath: '/w/a.ts', parts: [{ before: 'a', after: 'b' }] },
      { type: 'tool', name: 'MultiEdit' },
      { type: 'edit', tool: 'MultiEdit', filePath: 'b.ts', parts: [{ before: '1', after: '2' }, { before: '3', after: '' }] },
      { type: 'tool', name: 'Write' },
      { type: 'edit', tool: 'Write', filePath: '/w/c.md', parts: [{ before: '', after: '# C\n' }] },
    ]);
  });

  it('reports no change for other tools, unexpected inputs and subagents', () => {
    assert.equal(fileEditOf('Read', { file_path: '/w/a.ts' }), undefined);
    assert.equal(fileEditOf('Bash', { command: 'ls', file_path: '/w/a.ts', content: 'x' }), undefined);
    assert.equal(fileEditOf('Edit', { file_path: '/w/a.ts', old_string: 'a' }), undefined);
    assert.equal(fileEditOf('Edit', { file_path: '', old_string: 'a', new_string: 'b' }), undefined);
    assert.equal(fileEditOf('Write', { file_path: '/w/a.ts', content: 3 }), undefined);
    assert.equal(fileEditOf('MultiEdit', { file_path: '/w/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c' }] }), undefined);
    assert.equal(fileEditOf('MultiEdit', { file_path: '/w/a.ts', edits: [] }), undefined);
    assert.equal(fileEditOf('Edit', 'not an object'), undefined);
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(realInit('/w'));
    const assistant = JSON.parse(recordedAssistant) as { message: Record<string, unknown> };
    const sub = JSON.stringify({
      ...assistant,
      parent_tool_use_id: 'toolu_1',
      message: { ...assistant.message, content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }] },
    });
    assert.deepEqual(stream.feed(sub), []);
  });

  it('a model response split in several messages counts once', () => {
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(realInit('/w'));
    stream.feed(recordedAssistant);
    stream.feed(recordedAssistant);
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

  it('passes the partial messages on as thinking and text pieces, with the whole block marked as streamed (D-249)', async () => {
    const { run, events, path } = await start('partial');
    const result = await run.result;
    assert.equal(result.text, 'ok');
    assert.deepEqual(
      events.map((event) => event.type),
      ['init', 'thinking', 'thinking', 'thinking', 'text-delta', 'text-delta', 'text', 'usage'],
    );
    assert.deepEqual(events[6], { type: 'text', text: 'ok', streamed: true });
    assert.ok(received(path).argv.includes('--include-partial-messages'));
  });

  it('asks for the exact model name at each launch, and refuses a bad one before starting (D-071)', async () => {
    let name: string | undefined = 'claude-sonnet-5-5';
    const options = { modelName: (model: string) => (model === 'sonnet' ? name : undefined) };
    const first = await start('ok', {}, options);
    await first.run.result;
    const argv = received(first.path).argv;
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-sonnet-5-5');
    name = '--dangerously-skip-permissions';
    const refused = await start('ok', {}, options);
    assert.equal((await failure(refused.run.result)).kind, 'invalid-options');
  });

  it('launches a run without saving its session, and refuses to resume it before spending the brief (D-136)', async () => {
    const { prepared, path } = await workspace();
    const first = await executor().start({ brief: brief('scenario: ok'), workspace: prepared, model: 'sonnet', tools: ['Read'], persistSession: false }).result;
    assert.equal(first.text, 'ok');
    const argv = received(path).argv;
    assert.ok(argv.includes('--no-session-persistence') && argv.includes('-p') && !argv.includes('--resume'));
    // The check refuses before the gateway, the resume before spending the brief, with a plain message.
    const refused = await executor()
      .check({ workspace: prepared, model: 'sonnet', tools: [], persistSession: false, sessionRef: first.sessionRef })
      .then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof ClaudeError && refused.kind === 'invalid-options' && /not saved/.test(refused.message), String(refused));
    const decision = brief('scenario: ok\nagain');
    const resumed = await failure(executor().resume({ brief: decision, workspace: prepared, model: 'sonnet', tools: [], persistSession: false, sessionRef: first.sessionRef }).result);
    assert.equal(resumed.kind, 'invalid-options');
    assert.match(resumed.message, /cannot be resumed/);
    // Not a boolean, with or without a session: refused as an option too, never read as "saved".
    for (const persistSession of ['false', null] as never[]) {
      await assert.rejects(executor().check({ workspace: prepared, model: 'sonnet', tools: [], persistSession, sessionRef: SESSION }), (error: unknown) => error instanceof ClaudeError && error.kind === 'invalid-options');
      await assert.rejects(executor().check({ workspace: prepared, model: 'sonnet', tools: [], persistSession }), (error: unknown) => error instanceof ClaudeError && error.kind === 'invalid-options');
    }
    // Still unspent: a saved launch takes it, without the flag.
    assert.equal((await executor().start({ brief: decision, workspace: prepared, model: 'sonnet', tools: [] }).result).text, 'ok');
    assert.ok(!received(path).argv.includes('--no-session-persistence'));
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
    // SIGKILL is proven only if SIGTERM came after the fake installed its handler, which it does
    // before printing init (so the error carries the session). On a loaded machine the fake may
    // take longer than the cap just to start: then the cap is raised and the run repeated.
    let ignored: ClaudeError | undefined;
    for (const timeoutMs of [400, 2_000, 8_000]) {
      ignored = await failure((await start('ignore-term', { limits: { timeoutMs } })).run.result);
      assert.equal(ignored.kind, 'timeout');
      assert.equal(ignored.exitCode, undefined, 'ended by a signal, not by an exit');
      if (ignored.sessionRef !== undefined) break;
    }
    assert.equal(ignored?.sessionRef, SESSION, 'SIGTERM reached a process that ignores it: only SIGKILL stopped it');
    // Cancelled once the run is under way (the init event), not after a fixed delay.
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
    assert.equal(cancelled.kind, 'cancelled');
    assert.equal(cancelled.sessionRef, SESSION);
    const turns = await failure((await start('max-turns', { limits: { maxTurns: 3 } })).run.result);
    assert.equal(turns.kind, 'max-turns');
    assert.ok((turns.usage?.turns ?? 0) > 3);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await failure((await start('hang', { signal: aborted.signal })).run.result)).kind, 'cancelled');
  });

  it('D-302, D-304: the pid file and the guardian of a run live while the process runs and go when it ends', async () => {
    const pidDir = join(DATA, `run-pids-${randomUUID()}`);
    const files = () => (existsSync(pidDir) ? readdirSync(pidDir) : []);
    let seen: string[] = [];
    let record: unknown;
    let guarded: number[] = [];
    let cancel: () => void = () => undefined;
    const { run } = await start(
      'hang',
      {
        onEvent: (event) => {
          if (event.type !== 'init') return;
          seen = files();
          guarded = guardians().filter((one) => one.group === Number(/[0-9]+/.exec(seen[0] ?? '')?.[0])).map((one) => one.group);
          record = seen[0] === undefined ? undefined : JSON.parse(readFileSync(join(pidDir, seen[0]), 'utf8'));
          cancel();
        },
      },
      { pidDir },
    );
    cancel = () => {
      run.cancel();
    };
    assert.equal((await failure(run.result)).kind, 'cancelled');
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? '', /^claude-[0-9]+\.pid$/);
    assert.equal((record as { pid: number }).pid, Number(/[0-9]+/.exec(seen[0] ?? '')?.[0]));
    assert.equal(typeof (record as { started: unknown }).started, 'string');
    assert.deepEqual(guarded, [Number(/[0-9]+/.exec(seen[0] ?? '')?.[0])], 'D-304: one guardian, on the group of the run');
    assert.deepEqual(files(), [], 'a cancelled run removes its file');
    assert.ok(await noGuardianLeft(), 'D-304: a cancelled run leaves no guardian');
    await (await start('ok', {}, { pidDir })).run.result;
    assert.deepEqual(files(), [], 'a run that ends normally removes its file');
    assert.ok(await noGuardianLeft(), 'D-304: nor does a run that ends normally');
    assert.throws(() => executor({ pidDir: 'data/run-pids' }), TypeError);
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
    // Read at each launch (D-071): turned off in the file, the next launch is refused.
    let live = ['claude'];
    const following = executor({ enabled: () => live });
    const other = { ...base, workspace: (await workspace()).prepared };
    await following.start({ ...other, brief: brief('scenario: ok') }).result;
    live = [];
    assert.equal(await kind(following.start({ ...other, brief: brief('scenario: ok') }).result), 'not-enabled');
    live = ['claude'];
    assert.equal((await following.start({ ...other, brief: brief('scenario: ok') }).result).text, 'ok', 'turned on again');
    // The project folder itself, opened by openRepository (D-056), is accepted like a prepared copy.
    const opened = await openRepository({ home: HOME, project: { name: 'site', absolute: join(HOME, 'repos', 'site'), label: 'L1' } });
    assert.ok(opened.path !== undefined);
    await executor().check({ workspace: opened, model: 'sonnet', tools: ['Read'] });
    await assert.rejects(executor().check({ workspace: { ...opened }, model: 'sonnet', tools: ['Read'] }), (error: unknown) => (error as { kind?: string }).kind === 'workspace');
  });

  it('a binary that cannot start is a spawn error', async () => {
    const { run } = await start('ok', {}, { command: { file: join(HOME, 'no-such-binary'), args: [] } });
    assert.equal((await failure(run.result)).kind, 'spawn');
  });
});

describe('claude executor with Arianna\'s MCP server (D-261)', () => {
  const mcpDir = join(DATA, 'mcp');
  const mcpToken = () => randomBytes(32).toString('base64url');
  const prepared = (tools: readonly ('kb_search' | 'kb_read' | 'list_skills' | 'get_skill')[] = ['kb_search']) =>
    prepareMcp(mcpDir, randomUUID(), { url: 'http://127.0.0.1:7421/mcp', token: mcpToken(), tools });

  it('launches with the file of the run, allows its tools by name, and removes the file at the end', async () => {
    const mcp = await prepared(['kb_search', 'list_skills']);
    const config = readFileSync(mcp.path, 'utf8');
    const { run, events, path } = await start('arianna-mcp-call', { mcp });
    const result = await run.result;
    assert.equal(result.text, 'found it');
    const got = received(path);
    // The binary read the file while the run lasted; the token only there, never in argv or the environment.
    // The fake records the token as its sha256, never as it is.
    const hashed = config.replace(/Bearer ([A-Za-z0-9_-]+)/, (_, token: string) => `Bearer sha256:${createHash('sha256').update(token).digest('hex')}`);
    assert.notEqual(hashed, config);
    assert.deepEqual(got.mcpConfig, JSON.parse(hashed));
    assert.equal(got.argv[got.argv.indexOf('--mcp-config') + 1], mcp.path);
    assert.equal(got.argv[got.argv.indexOf('--tools') + 1], 'Read,Grep');
    assert.equal(got.argv[got.argv.indexOf('--allowedTools') + 1], 'Read,Grep,mcp__arianna__kb_search,mcp__arianna__list_skills');
    const bearer = /Bearer ([A-Za-z0-9_-]+)/.exec(config)?.[1] ?? '';
    assert.ok(bearer.length >= 43);
    assert.ok(!got.argv.some((arg) => arg.includes(bearer)) && !Object.values(got.env).some((value) => value.includes(bearer)));
    assert.equal(got.env.ENABLE_TOOL_SEARCH, 'false');
    // What --safe-mode turned off, closed one by one (it would drop the server).
    for (const [key, value] of Object.entries(MCP_LAUNCH_ENV)) assert.equal(got.env[key], value, key);
    assert.ok(!got.argv.includes('--safe-mode'));
    assert.equal(got.argv[got.argv.indexOf('--setting-sources') + 1], '');
    // The call is reported by name: nothing of its arguments nor of its result.
    assert.deepEqual(
      events.filter((event) => event.type === 'tool'),
      [{ type: 'tool', name: 'mcp__arianna__kb_search' }],
    );
    assert.ok(!JSON.stringify(events).includes('SECRET-'));
    assert.equal(existsSync(mcp.path), false);
  });

  it('stops a run whose server failed or whose tools are deferred, and removes the file all the same', async () => {
    for (const [scenario, field] of [
      ['arianna-mcp-failed', 'mcp_servers'],
      ['arianna-mcp-tool-search', 'tools'],
      ['arianna-mcp-user-agent', 'agents'],
    ] as const) {
      const mcp = await prepared();
      const error = await failure((await start(scenario, { mcp })).run.result);
      assert.equal(error.kind, 'profile', scenario);
      assert.deepEqual(error.violations, [field], scenario);
      assert.equal(existsSync(mcp.path), false, scenario);
    }
  });

  it('without the server nothing changes: empty configuration, no tool search variable', async () => {
    const { run, path } = await start('ok');
    await run.result;
    const got = received(path);
    assert.equal(got.argv[got.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.equal(got.env.ENABLE_TOOL_SEARCH, undefined);
    for (const key of Object.keys(MCP_LAUNCH_ENV)) assert.equal(got.env[key], undefined, key);
    assert.ok(got.argv.includes('--safe-mode') && !got.argv.includes('--setting-sources'));
    assert.equal(got.mcpConfig, undefined);
  });

  it('refuses a configuration not made by prepareMcp, gone, or readable by the run, before spending the brief', async () => {
    const { prepared: workspaceOf, path } = await workspace();
    const check = (mcp: unknown) => executor().check({ workspace: workspaceOf, model: 'sonnet', tools: ['Read'], mcp: mcp as never });
    const invalid = (error: unknown) => error instanceof ClaudeError && error.kind === 'invalid-options';
    const made = await prepared();
    // Positive: check leaves the file for the run.
    await check(made);
    assert.equal(existsSync(made.path), true);
    await assert.rejects(check({ path: made.path, tools: ['kb_search'] }), invalid);
    // Inside the workspace a file tool would read the token.
    const inside = await prepareMcp(path, 'inside', { url: 'http://127.0.0.1:7421/mcp', token: mcpToken(), tools: ['kb_read'] });
    await assert.rejects(check(inside), invalid);
    // Gone, or a link put in its place.
    const gone = await prepared();
    rmSync(gone.path);
    await assert.rejects(check(gone), invalid);
    const linked = await prepared();
    rmSync(linked.path);
    symlinkSync(made.path, linked.path);
    await assert.rejects(check(linked), invalid);
    // A refused launch spends nothing, and still removes the file it was given.
    const decision = brief('scenario: ok');
    const refused = await failure(executor().start({ brief: decision, workspace: workspaceOf, model: 'sonnet', tools: ['Read'], mcp: inside }).result);
    assert.equal(refused.kind, 'invalid-options');
    assert.equal(existsSync(inside.path), false);
    assert.equal((await executor().start({ brief: decision, workspace: workspaceOf, model: 'sonnet', tools: ['Read'], mcp: made }).result).text, 'ok');
    assert.equal(existsSync(made.path), false);
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
    // It counts only if the handler was reached before the cap fired (the time is measured from
    // before the launch, so it can only overstate): on a loaded machine the cap is raised.
    const handler = { reached: false };
    for (const timeoutMs of [300, 2_000, 8_000]) {
      const { prepared } = await workspace();
      const decision = brief('scenario: ok\nfake task');
      const launched = performance.now();
      let reachedAfter = Infinity;
      const run = executor().start({
        brief: decision,
        workspace: prepared,
        model: 'sonnet',
        tools: ['Read', 'Grep'],
        limits: { timeoutMs },
        onEvent: () => {
          reachedAfter = Math.min(reachedAfter, performance.now() - launched);
          return new Promise<void>(() => undefined);
        },
      });
      assert.equal((await failure(run.result)).kind, 'timeout');
      handler.reached = reachedAfter < timeoutMs;
      if (handler.reached) break;
    }
    assert.ok(handler.reached, 'the handler was called before the cap and never settled');
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
    assert.deepEqual(settings.sandbox.filesystem, { denyRead: ['/arianna'], allowRead: ['/w', ...SANDBOX.readable], denyWrite: ['/w/.git'] });
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash');
  });

  it('the workspace .git is read only for Bash and for the file tools: the agents never commit (D-174)', () => {
    const settings = settingsOf(claudeArgs({ model: 'sonnet', tools: ['Edit', 'Write', 'Bash'], sandbox: SANDBOX }));
    assert.deepEqual(settings.sandbox.filesystem.denyWrite, ['/w/.git']);
    assert.deepEqual(settings.permissions.deny, ['Edit(//w/.git/**)', 'Edit(//w/.git)']);
  });

  it('a workspace path with glob characters is a literal in the deny rule, the sandbox path stays as it is', () => {
    const settings = settingsOf(claudeArgs({ model: 'sonnet', tools: ['Edit'], sandbox: { ...SANDBOX, workspace: '/w/[a]*?{b}!#' } }));
    assert.deepEqual(settings.sandbox.filesystem.denyWrite, ['/w/[a]*?{b}!#/.git']);
    assert.deepEqual(settings.permissions.deny, ['Edit(//w/\\[a\\]\\*\\?\\{b\\}\\!\\#/.git/**)', 'Edit(//w/\\[a\\]\\*\\?\\{b\\}\\!\\#/.git)']);
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
