// Arianna's MCP server on the launch side (D-261, task 1.10): the configuration
// file of one run, the arguments and the `init` check with and without it.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import {
  claudeArgs,
  claudeEnv,
  ClaudeStream,
  MCP_TOOL_NAMES,
  mcpToolId,
  nodeToolchain,
  prepareMcp,
  preparedMcp,
  profileViolations,
  releaseMcp,
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
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--restricted') && args.includes('--safe-mode'));
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
    const strip = (list: string[]) => list.filter((_, index) => index !== list.indexOf('--mcp-config') + 1 && index !== list.indexOf('--allowedTools') + 1);
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

  it('turns tool search off only for a run with the server', () => {
    assert.equal(claudeEnv({ PATH: 'p' }, { mcp: true }).ENABLE_TOOL_SEARCH, 'false');
    assert.equal(claudeEnv({ PATH: 'p' }).ENABLE_TOOL_SEARCH, undefined);
    assert.equal(claudeEnv({ PATH: 'p', ENABLE_TOOL_SEARCH: 'true' }).ENABLE_TOOL_SEARCH, undefined);
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
