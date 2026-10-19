// Arianna's MCP server on the launch side (D-261, task 1.10): the configuration
// file of one run, the arguments and the `init` check with and without it.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import {
  claudeArgs,
  CLAUDE_BUILTIN_AGENTS,
  claudeEnv,
  ClaudeStream,
  MCP_LAUNCH_ENV,
  MCP_TOOL_NAMES,
  mcpToolId,
  nodeToolchain,
  prepareMcp,
  preparedMcp,
  profileViolations,
  claudeManagedPaths,
  claudeManagedSettingsPresent,
  releaseMcp,
  removeStaleMcp,
  type McpEndpoint,
} from '@arianna/executors';

const DIR = join(resolveHome({}), 'data', 'test-tmp', `mcp-${randomUUID()}`);
const SANDBOX = { workspace: '/w', readable: nodeToolchain(), denied: ['/arianna'] };
const token = (): string => randomBytes(32).toString('base64url');
const endpoint = (extra: Partial<McpEndpoint> = {}): McpEndpoint => ({ url: 'http://127.0.0.1:7421/mcp', token: token(), tools: ['kb_search', 'kb_read'], ...extra });

after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe('mcp configuration (D-261)', () => {
  it('names the tools of the server exactly, never with a wildcard', () => {
    assert.deepEqual(MCP_TOOL_NAMES.map(mcpToolId), ['mcp__arianna__list_skills', 'mcp__arianna__get_skill', 'mcp__arianna__kb_search', 'mcp__arianna__kb_read']);
    assert.throws(() => mcpToolId('*' as never), /unknown tool/);
  });

  it('writes the file of one run, 0600, with the token only inside it', async () => {
    const given = endpoint();
    const prepared = await prepareMcp(DIR, 'run-1', given);
    assert.equal(prepared.path.endsWith('/run-1.mcp.json'), true);
    assert.equal(statSync(prepared.path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(prepared.path, 'utf8')), {
      mcpServers: { arianna: { type: 'http', url: 'http://127.0.0.1:7421/mcp', headers: { Authorization: `Bearer ${given.token}` } } },
    });
    assert.deepEqual(prepared.tools, ['kb_search', 'kb_read']);
    assert.deepEqual(preparedMcp(prepared), { path: prepared.path, tools: ['kb_search', 'kb_read'] });
    // Only what prepareMcp made counts: a literal object names any file.
    assert.equal(preparedMcp({ path: prepared.path, tools: ['kb_read'] }), undefined);
    await releaseMcp(prepared);
  });

  it('never writes over a file that is already there, and removes its own file once or many times', async () => {
    const prepared = await prepareMcp(DIR, 'run-2', endpoint());
    const before = readFileSync(prepared.path, 'utf8');
    // `wx`: another run's file, or anything put there, is never touched.
    await assert.rejects(prepareMcp(DIR, 'run-2', endpoint()), /EEXIST/);
    assert.equal(readFileSync(prepared.path, 'utf8'), before);
    await releaseMcp(prepared);
    assert.equal(existsSync(prepared.path), false);
    await releaseMcp(prepared);
    await assert.rejects(releaseMcp({ path: prepared.path, tools: ['kb_read'] }), /not a configuration made by prepareMcp/);
  });

  it('at the start removes the files a stopped core left, and nothing else (D-261)', async () => {
    const dir = join(DIR, 'stale');
    assert.equal(await removeStaleMcp(dir), 0);
    const left = await prepareMcp(dir, 'run-stale', endpoint());
    // The folder is made private.
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const outside = join(DIR, 'outside.txt');
    writeFileSync(outside, 'kept');
    symlinkSync(outside, join(dir, 'run-link.mcp.json'));
    writeFileSync(join(dir, 'notes.json'), 'kept');
    writeFileSync(join(dir, 'Upper.mcp.json'), 'kept');
    mkdirSync(join(dir, 'run-folder.mcp.json'));
    assert.equal(await removeStaleMcp(dir), 2);
    assert.equal(existsSync(left.path), false);
    // The link is gone, not what it pointed to.
    assert.equal(readFileSync(outside, 'utf8'), 'kept');
    assert.equal(existsSync(join(dir, 'run-link.mcp.json')), false);
    for (const name of ['notes.json', 'Upper.mcp.json', 'run-folder.mcp.json']) assert.ok(existsSync(join(dir, name)), name);
    await assert.rejects(removeStaleMcp('relative/dir'), /absolute/);
  });

  it('tells managed settings of Claude Code by their existence alone, a broken link too', () => {
    const paths = claudeManagedPaths('someone');
    assert.ok(paths.includes('/Library/Application Support/ClaudeCode/managed-settings.json'));
    assert.ok(paths.includes('/Library/Application Support/ClaudeCode/managed-settings.d'));
    assert.ok(paths.includes('/Library/Application Support/ClaudeCode/managed-mcp.json'));
    assert.ok(paths.includes('/Library/Managed Preferences/someone/com.anthropic.claudecode.plist'));
    assert.ok(!claudeManagedPaths('').some((path) => path.includes('//')));
    const dir = join(DIR, 'managed');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'managed-settings.json');
    const link = join(dir, 'managed-mcp.json');
    assert.equal(claudeManagedSettingsPresent([file, link, join(dir, 'missing', 'deeper')]), false);
    // Not a folder on the way: nothing there either.
    writeFileSync(join(dir, 'plain'), '');
    assert.equal(claudeManagedSettingsPresent([join(dir, 'plain', 'managed-settings.json')]), false);
    writeFileSync(file, '{}');
    assert.equal(claudeManagedSettingsPresent([file]), true);
    symlinkSync(join(dir, 'nowhere'), link);
    assert.equal(claudeManagedSettingsPresent([link]), true);
  });

  it('accepts only a loopback url on /mcp, a long base64url token and a list of the known tools', async () => {
    for (const url of [
      'https://127.0.0.1:7421/mcp',
      'http://localhost:7421/mcp',
      'http://127.0.0.2:7421/mcp',
      'http://0.0.0.0:7421/mcp',
      'http://example.com:7421/mcp',
      'http://127.0.0.1/mcp',
      'http://127.0.0.1:0/mcp',
      'http://127.0.0.1:70000/mcp',
      'http://127.0.0.1:7421/mcp/',
      'http://127.0.0.1:7421/other',
      'http://127.0.0.1:7421/mcp?x=1',
      'http://127.0.0.1:7421/mcp#x',
      'http://user:pass@127.0.0.1:7421/mcp',
      'http://127.0.0.1:7421@evil.example/mcp',
      ' http://127.0.0.1:7421/mcp',
      42,
    ]) {
      await assert.rejects(prepareMcp(DIR, 'bad-url', endpoint({ url: url as string })), /url must be/, String(url));
    }
    const secret = 'a'.repeat(42);
    for (const bad of [secret, `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`, `${'a'.repeat(42)} `, 'a'.repeat(513), undefined]) {
      await assert.rejects(
        prepareMcp(DIR, 'bad-token', endpoint({ token: bad as string })),
        (error: unknown) => error instanceof TypeError && /token must be/.test(error.message) && !error.message.includes(secret),
      );
    }
    for (const tools of [[], ['kb_read', 'kb_read'], ['kb_write'], ['Bash'], 'kb_read', undefined]) {
      await assert.rejects(prepareMcp(DIR, 'bad-tools', endpoint({ tools: tools as never })), /mcp: /, JSON.stringify(tools));
    }
    for (const runId of ['', '../x', 'Run', 'a/b', '-a', 'a'.repeat(65), 'a.b']) {
      await assert.rejects(prepareMcp(DIR, runId, endpoint()), /invalid run id/, runId);
    }
    for (const dir of ['relative', '/', `${DIR}/../x`, `${DIR}/`]) {
      await assert.rejects(prepareMcp(dir, 'bad-dir', endpoint()), /dir must be/, dir);
    }
    // Nothing was written by the refusals.
    for (const runId of ['bad-url', 'bad-token', 'bad-tools', 'bad-dir']) assert.equal(existsSync(join(DIR, `${runId}.mcp.json`)), false);
    // Positive: the highest port, every tool, a long token.
    const ok = await prepareMcp(DIR, 'good', endpoint({ url: 'http://127.0.0.1:65535/mcp', tools: [...MCP_TOOL_NAMES], token: 'A-_z'.repeat(20) }));
    await releaseMcp(ok);
  });
});

describe('claude profile with Arianna\'s MCP server (D-261)', () => {
  const mcp = { config: '/arianna/data/mcp/run-1.mcp.json', tools: ['kb_search', 'list_skills'] as const };
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('names the file instead of the empty configuration and allows each tool by exact name', () => {
    const args = claudeArgs({ model: 'sonnet', tools: ['Read', 'Grep'], sandbox: SANDBOX, mcp });
    assert.equal(value(args, '--mcp-config'), mcp.config);
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--restricted') && args.includes('--disable-slash-commands') && args.includes('--no-chrome'));
    // --safe-mode would drop the server: no settings file instead, an empty value of its own.
    assert.ok(!args.includes('--safe-mode'));
    assert.equal(args.filter((arg) => arg === '--setting-sources').length, 1);
    assert.equal(value(args, '--setting-sources'), '');
    assert.equal(value(args, '--tools'), 'Read,Grep');
    assert.equal(value(args, '--allowedTools'), 'Read,Grep,mcp__arianna__kb_search,mcp__arianna__list_skills');
    assert.ok(!(value(args, '--allowedTools') ?? '').includes('*'));
    // Only the server's tools: still allowed, with no built-in tool.
    const none = claudeArgs({ model: 'sonnet', tools: [], sandbox: SANDBOX, mcp });
    assert.equal(value(none, '--tools'), '');
    assert.equal(value(none, '--allowedTools'), 'mcp__arianna__kb_search,mcp__arianna__list_skills');
    // Everything else is the profile without the server.
    const without = claudeArgs({ model: 'sonnet', tools: ['Read', 'Grep'], sandbox: SANDBOX });
    assert.equal(value(without, '--mcp-config'), '{"mcpServers":{}}');
    assert.equal(value(without, '--allowedTools'), 'Read,Grep');
    assert.ok(without.includes('--safe-mode') && !without.includes('--setting-sources'));
    // Hooks and auto memory off in the settings of a run with the server only.
    const settings = (list: string[]) => JSON.parse(value(list, '--settings') ?? '{}') as Record<string, unknown>;
    assert.equal(settings(args).disableAllHooks, true);
    assert.equal(settings(args).autoMemoryEnabled, false);
    assert.equal(settings(without).disableAllHooks, undefined);
    assert.equal(settings(without).autoMemoryEnabled, undefined);
    assert.deepEqual(settings(args).sandbox, settings(without).sandbox);
    assert.deepEqual(settings(args).permissions, settings(without).permissions);
    // The rest is the profile without the server.
    const strip = (list: string[]) =>
      list.filter(
        (arg, index) =>
          ![list.indexOf('--mcp-config') + 1, list.indexOf('--allowedTools') + 1, list.indexOf('--settings') + 1, ...(list.includes('--setting-sources') ? [list.indexOf('--setting-sources') + 1] : [])].includes(index) &&
          !['--safe-mode', '--setting-sources'].includes(arg),
      );
    assert.deepEqual(strip(args), strip(without));
    assert.ok(!claudeArgs({ model: 'sonnet', tools: [], sandbox: SANDBOX }).includes('--allowedTools'));
  });

  it('keeps the token out of the arguments', async () => {
    const given = endpoint();
    const prepared = await prepareMcp(DIR, 'argv', given);
    const args = claudeArgs({ model: 'sonnet', tools: ['Read'], sandbox: SANDBOX, mcp: { config: prepared.path, tools: prepared.tools } });
    assert.ok(!args.some((arg) => arg.includes(given.token) || arg.includes('Bearer')));
    await releaseMcp(prepared);
  });

  it('refuses a configuration that is not an absolute file, and tools it does not know', () => {
    for (const config of ['{"mcpServers":{"x":{}}}', 'relative.json', '/', '/a/../b.json', '--dangerously-skip-permissions', 42]) {
      assert.throws(() => claudeArgs({ model: 'sonnet', tools: [], sandbox: SANDBOX, mcp: { config: config as string, tools: ['kb_read'] } }), /absolute, normalized file/, String(config));
    }
    for (const tools of [[], ['kb_read', 'kb_read'], ['Bash'], ['*']]) {
      assert.throws(() => claudeArgs({ model: 'sonnet', tools: [], sandbox: SANDBOX, mcp: { config: mcp.config, tools: tools as never } }), /mcp: /, JSON.stringify(tools));
    }
  });

  it('turns off what --safe-mode did, and tool search, only for a run with the server', () => {
    const env = claudeEnv({ PATH: 'p', HOME: 'h' }, { mcp: true });
    assert.equal(env.ENABLE_TOOL_SEARCH, 'false');
    for (const key of [
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'CLAUDE_CODE_DISABLE_ORG_MEMORY',
      'CLAUDE_CODE_DISABLE_WORKFLOWS',
      'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
      'CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS',
    ]) {
      assert.equal(env[key], '1', key);
    }
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.deepEqual(Object.keys(env).sort(), [...Object.keys(claudeEnv({ PATH: 'p', HOME: 'h' })), ...Object.keys(MCP_LAUNCH_ENV)].sort());
    // Without the server, as before; and a variable of the core never overrides one of these.
    assert.deepEqual(Object.keys(claudeEnv({ PATH: 'p' })).sort(), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'LANG', 'PATH']);
    assert.equal(claudeEnv({ PATH: 'p', ENABLE_TOOL_SEARCH: 'true', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' }).ENABLE_TOOL_SEARCH, undefined);
    assert.equal(claudeEnv({ PATH: 'p', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' }, { mcp: true }).CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  });

  it('accepts Arianna\'s server alone and connected, with exactly the tools given', () => {
    const init = {
      cwd: '/w',
      tools: ['Read', 'mcp__arianna__kb_search', 'mcp__arianna__list_skills'],
      mcp_servers: [{ name: 'arianna', status: 'connected', extra: 'a field of a newer binary' }],
      permissionMode: 'dontAsk',
      apiKeySource: 'none',
      skills: [],
      slash_commands: [],
      plugins: [{ path: 'builtin' }],
      agents: [...CLAUDE_BUILTIN_AGENTS],
      output_style: 'default',
    };
    const expected = { cwd: '/w', tools: ['Read'] as const, mcp: mcp.tools };
    assert.deepEqual(profileViolations(init, expected), []);
    // The server missing, another one beside it, another one instead, not connected.
    assert.deepEqual(profileViolations({ ...init, mcp_servers: [] }, expected), ['mcp_servers']);
    assert.deepEqual(profileViolations({ ...init, mcp_servers: [...init.mcp_servers, { name: 'gmail', status: 'connected' }] }, expected), ['mcp_servers']);
    assert.deepEqual(profileViolations({ ...init, mcp_servers: [{ name: 'gmail', status: 'connected' }] }, expected), ['mcp_servers']);
    for (const status of ['failed', 'pending', 'needs-auth', undefined]) {
      assert.deepEqual(profileViolations({ ...init, mcp_servers: [{ name: 'arianna', status }] }, expected), ['mcp_servers'], String(status));
    }
    assert.deepEqual(profileViolations({ ...init, mcp_servers: ['arianna'] }, expected), ['mcp_servers']);
    assert.deepEqual(profileViolations({ ...init, mcp_servers: undefined }, expected), ['mcp_servers']);
    // A tool of the server not given, one of another server, one missing, the search tool that defers them.
    for (const tools of [
      [...init.tools, 'mcp__arianna__kb_read'],
      [...init.tools, 'mcp__gmail__send'],
      ['Read', 'mcp__arianna__kb_search'],
      [...init.tools, 'ToolSearch'],
    ]) {
      assert.deepEqual(profileViolations({ ...init, tools }, expected), ['tools'], tools.join(','));
    }
    // Without --safe-mode, the user's profile coming in all the same.
    for (const [extra, field] of [
      [{ agents: [...CLAUDE_BUILTIN_AGENTS, 'reviewer'] }, 'agents'],
      [{ agents: 'Plan' }, 'agents'],
      // Required with the server: a field gone is no proof that no agent came in.
      [{ agents: undefined }, 'agents'],
      [{ output_style: 'Explanatory' }, 'output_style'],
      [{ output_style: undefined }, 'output_style'],
      [{ memory_paths: { auto: 'fake/memory' } }, 'memory_paths'],
      [{ memory_paths: [] }, 'memory_paths'],
      [{ skills: ['my-skill'] }, 'skills'],
      [{ slash_commands: ['/mine'] }, 'slash_commands'],
      [{ plugins: [{ path: 'fake/plugins/mail' }] }, 'plugins'],
      [{ plugin_errors: [{ plugin: 'mail', type: 'generic-error' }] }, 'plugins'],
      [{ mcp_server_errors: [{ name: 'gmail' }] }, 'mcp_servers'],
    ] as const) {
      assert.deepEqual(profileViolations({ ...init, ...extra }, expected), [field], JSON.stringify(extra));
    }
    // Positive: fewer built-in agents, none, empty or absent memory paths (2.1.303 has none), empty errors.
    for (const extra of [{ agents: ['Explore'] }, { agents: [] }, { memory_paths: {} }, { memory_paths: undefined }, { plugin_errors: [] }, { mcp_server_errors: [] }]) {
      assert.deepEqual(profileViolations({ ...init, ...extra }, expected), [], JSON.stringify(extra));
    }
    // Without the server these stay to --safe-mode, as before.
    assert.deepEqual(
      profileViolations({ ...init, tools: ['Read'], mcp_servers: [], agents: ['reviewer'], output_style: 'Explanatory', memory_paths: { auto: 'x' } }, { cwd: '/w', tools: ['Read'] }),
      [],
    );
    // Without the server, as before: none at all, and its tools are strangers.
    assert.deepEqual(profileViolations({ ...init, tools: ['Read'] }, { cwd: '/w', tools: ['Read'] }), ['mcp_servers']);
    assert.deepEqual(profileViolations({ ...init, mcp_servers: [] }, { cwd: '/w', tools: ['Read'] }), ['tools']);
  });

  it('reports a call to the server by its name only, never its arguments nor its result', () => {
    const recorded = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8').split('\n')[0] ?? '') as Record<string, unknown>;
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'], mcp: ['kb_search'] });
    const init = { ...recorded, cwd: '/w', tools: ['Read', 'mcp__arianna__kb_search'], mcp_servers: [{ name: 'arianna', status: 'connected' }] };
    const events = [
      ...stream.feed(JSON.stringify(init)),
      ...stream.feed(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'm1', name: 'mcp__arianna__kb_search', input: { query: 'SECRET-QUERY' } }] },
        }),
      ),
      ...stream.feed(JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'm1', content: 'SECRET-RESULT' }] } })),
    ];
    assert.equal(stream.result, undefined);
    assert.deepEqual(
      events.filter((event) => event.type !== 'init'),
      [{ type: 'tool', name: 'mcp__arianna__kb_search' }],
    );
    assert.ok(!JSON.stringify(events).includes('SECRET'));
  });
});
