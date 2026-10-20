// A fake `claude -p` for the adapter tests: replays the stream of a real run
// (claude-stream.jsonl, recorded from 2.1.288) and bends it per scenario. The
// scenario is the first line of the prompt, `scenario: <name>`: the adapter
// passes no environment of its own, so the prompt is the only way in.
// It writes what it received to `.fake-claude.json` in its working directory.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const scenario = /^scenario: ([a-z0-9-]+)/.exec(prompt)?.[1] ?? 'ok';
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
// Arianna's MCP server (D-261): a file path instead of the empty JSON; read as the binary would, while the run lasts.
const mcpFlag = flag('--mcp-config') ?? '';
const mcpConfig: unknown = mcpFlag.startsWith('{') ? undefined : JSON.parse(readFileSync(mcpFlag, 'utf8'));
// The token is written as its sha256: a record in the working directory must not carry it (the canary looks for it there).
const hashTokens = (text: string): string => text.replace(/Bearer ([A-Za-z0-9_-]+)/g, (_, token: string) => `Bearer sha256:${createHash('sha256').update(token).digest('hex')}`);
const recordedMcp: unknown = mcpConfig === undefined ? undefined : JSON.parse(hashTokens(JSON.stringify(mcpConfig)));
writeFileSync(join(process.cwd(), '.fake-claude.json'), JSON.stringify({ argv, env: process.env, prompt, mcpConfig: recordedMcp }));
const sessionRef = flag('--resume') ?? '00000000-0000-4000-8000-000000000001';
const tools = (flag('--tools') ?? '').split(',').filter((tool) => tool !== '');

type Message = Record<string, unknown>;
interface Assistant extends Message {
  message: Message;
}
interface RateLimit extends Message {
  rate_limit_info: Message;
}
const lines = readFileSync(join(import.meta.dirname, 'claude-stream.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Message);
// The partial messages (D-249) are built by hand, not recorded: kept apart, sent only by the `partial` scenario.
const partials = lines.filter((message) => message.type === 'stream_event');
const recorded = lines.filter((message) => message.type !== 'stream_event');
const [init, assistant, rateLimit, result] = recorded as [Message, Assistant, RateLimit, Message];
init.cwd = process.cwd();
// The server's tools exist because it lists them; here, those allowed by name.
const mcpTools = mcpConfig === undefined ? [] : (flag('--allowedTools') ?? '').split(',').filter((tool) => tool.startsWith('mcp__'));
init.tools = [...tools, ...mcpTools];
if (mcpConfig !== undefined) init.mcp_servers = [{ name: 'arianna', status: 'connected' }];
for (const message of lines) message.session_id = sessionRef;

const out = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const answer = (text: string, id = 'msg_1') => ({ ...assistant, message: { ...assistant.message, id, content: [{ type: 'text', text }] } });
const hang = () => setInterval(() => undefined, 1_000);

switch (scenario) {
  case 'partial':
    // D-249: the thinking and the text in pieces, then the whole block and the result, as with --include-partial-messages.
    out(init);
    for (const message of partials) out(message);
    out(answer('ok'));
    out({ ...result, result: 'ok' });
    break;
  case 'ok':
    out(init);
    out(answer(flag('--resume') === undefined ? 'ok' : 'resumed'));
    out(rateLimit);
    out({ ...result, result: flag('--resume') === undefined ? 'ok' : 'resumed' });
    break;
  case 'tool':
    out(init);
    out({ ...assistant, message: { ...assistant.message, id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } });
    out(answer('read it', 'msg_2'));
    out({ ...result, num_turns: 2, result: 'read it' });
    break;
  case 'quota':
    out(init);
    out({ ...rateLimit, rate_limit_info: { ...rateLimit.rate_limit_info, status: 'rejected', resetsAt: 1_790_979_600 } });
    out({ ...result, subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit" });
    process.exitCode = 1;
    break;
  case 'error':
    out(init);
    out({ ...result, subtype: 'error_during_execution', is_error: true, result: undefined });
    process.exitCode = 1;
    break;
  case 'max-turns':
    out(init);
    for (let turn = 1; turn <= 5; turn += 1) out(answer(`turn ${String(turn)}`, `msg_${String(turn)}`));
    hang();
    break;
  case 'hang':
    out(init);
    hang();
    break;
  case 'ignore-term':
    // Stopped only by SIGKILL.
    process.on('SIGTERM', () => undefined);
    out(init);
    hang();
    break;
  case 'crash':
    out(init);
    process.exitCode = 3;
    break;
  case 'garbage':
    out(init);
    process.stdout.write('this is not json\n');
    hang();
    break;
  case 'answer': {
    // The answer is the rest of the line `answer: ...` in the prompt (the planner's JSON, D-164).
    const said = /^answer: (.*)$/m.exec(prompt)?.[1] ?? '';
    out(init);
    out(answer(said));
    out({ ...result, result: said });
    break;
  }
  case 'before-init':
    out(answer('no init first'));
    hang();
    break;
  case 'extra-tool':
    out({ ...init, tools: [...tools, 'Bash'] });
    hang();
    break;
  case 'mcp':
    out({ ...init, mcp_servers: [{ name: 'gmail', status: 'connected' }] });
    hang();
    break;
  case 'arianna-mcp-failed':
    out({ ...init, mcp_servers: [{ name: 'arianna', status: 'failed' }] });
    hang();
    break;
  case 'arianna-mcp-user-agent':
    // Without --safe-mode: a personal agent of the user's profile came in.
    out({ ...init, agents: [...(init.agents as unknown[]), 'my-agent'] });
    hang();
    break;
  case 'arianna-mcp-tool-search':
    // Deferred tools behind a search tool of the binary's own.
    out({ ...init, tools: [...tools, 'ToolSearch'] });
    hang();
    break;
  case 'arianna-mcp-call':
    // A call to a tool of the server: its arguments and its result must not reach the events.
    out(init);
    out({
      ...assistant,
      message: { ...assistant.message, id: 'msg_1', content: [{ type: 'tool_use', id: 'm1', name: 'mcp__arianna__kb_search', input: { query: 'SECRET-QUERY-7f3a' } }] },
    });
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm1', content: 'SECRET-RESULT-9c1d' }] } });
    out(answer('found it', 'msg_2'));
    out({ ...result, num_turns: 2, result: 'found it' });
    break;
  case 'arianna-mcp-live': {
    // D-261: the run calls the server with the token of its configuration while it lasts (`tools/list`), and says what it got.
    const server = (mcpConfig as { mcpServers?: { arianna?: { url: string; headers: Record<string, string> } } } | undefined)?.mcpServers?.arianna;
    let status = 0;
    let names: string[] = [];
    if (server !== undefined) {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      status = response.status;
      if (status === 200) names = ((await response.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    }
    writeFileSync(join(process.cwd(), '.fake-claude-mcp.json'), JSON.stringify({ status, names }));
    out(init);
    out(answer('ok'));
    out({ ...result, result: 'ok' });
    break;
  }
  case 'arianna-mcp-web': {
    // D-262: the run asks web_fetch of the server for each address on a `fetch: ` line; `fetch-file: <address> <path>`
    // adds the content of a file to the address, %-encoded, as a run without a sandbox could. It answers only how many came back.
    const server = (mcpConfig as { mcpServers?: { arianna?: { url: string; headers: Record<string, string> } } } | undefined)?.mcpServers?.arianna;
    const texts: string[] = [];
    const urls = [
      ...[...prompt.matchAll(/^fetch: (.+)$/gm)].map((match) => match[1] ?? ''),
      ...[...prompt.matchAll(/^fetch-file: (\S+) (.+)$/gm)].map((match) => `${match[1] ?? ''}${encodeURIComponent(readFileSync(match[2] ?? '', 'utf8'))}`),
    ];
    for (const url of urls) {
      if (server === undefined) break;
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: texts.length + 1, method: 'tools/call', params: { name: 'web_fetch', arguments: { url } } }),
      });
      const body = (await response.json()) as { result?: { content?: { text?: string }[] } };
      texts.push(body.result?.content?.[0]?.text ?? '');
    }
    out(init);
    out(answer(`${String(texts.filter((text) => text !== '').length)} pages`));
    out({ ...result, result: 'ok' });
    break;
  }
  case 'api-key':
    out({ ...init, apiKeySource: 'ANTHROPIC_API_KEY' });
    hang();
    break;
  case 'user-plugin':
    out({ ...init, plugins: [...(init.plugins as unknown[]), { name: 'mail', path: '/somewhere/plugins/mail' }] });
    hang();
    break;
  case 'overage':
    out(init);
    out({ ...rateLimit, rate_limit_info: { ...rateLimit.rate_limit_info, isUsingOverage: true } });
    hang();
    break;
  case 'http-429':
    out(init);
    out({ ...result, is_error: true, api_error_status: 429, result: 'API Error: 429' });
    process.exitCode = 1;
    break;
  case 'http-401':
    out(init);
    out({ ...result, is_error: true, api_error_status: 401, result: 'API Error: 401' });
    process.exitCode = 1;
    break;
  case 'binary-max-turns':
    out(init);
    out({ ...result, subtype: 'error_max_turns', is_error: true, result: undefined });
    process.exitCode = 1;
    break;
  case 'subagent':
    out(init);
    out({ ...answer('from a subagent'), parent_tool_use_id: 'toolu_1' });
    out(answer('ok'));
    out(result);
    break;
  case 'many-turns-ok':
    // The binary counts turns its own way: a success above the limit stays a success.
    out(init);
    out(answer('ok'));
    out({ ...result, num_turns: 99 });
    break;
  case 'odd-status':
    out(init);
    out({ ...rateLimit, rate_limit_info: { ...rateLimit.rate_limit_info, status: 'Fake text, not a code', rateLimitType: 'Five Hours!' } });
    out(answer('ok'));
    out(result);
    break;
  case 'new-session':
    // A resume that silently started another session: the context is lost.
    out({ ...init, session_id: '00000000-0000-4000-8000-000000000002' });
    hang();
    break;
  case 'no-session':
    // A resume of a session the binary no longer has: it ends before any message.
    process.stderr.write('No conversation found with session ID\n');
    process.exitCode = 1;
    break;
  case 'second-init':
    out(init);
    out({ ...init, tools: [...tools, 'Bash'] });
    hang();
    break;
  case 'denied':
    out(init);
    out(answer('denied'));
    out({ ...result, result: 'denied', permission_denials: [{ tool_name: 'Write' }] });
    break;
  case 'leak': {
    // A confinement that failed: the file named on the `file: ` line comes back in the answer.
    const path = /^file: (.+)$/m.exec(prompt)?.[1] ?? '';
    out(init);
    out(answer(readFileSync(path, 'utf8')));
    out({ ...result, result: 'leaked' });
    break;
  }
  case 'tool-config': {
    // A run that left a hook in Claude Code's local settings, which git usually ignores.
    mkdirSync(join(process.cwd(), '.claude'), { recursive: true });
    writeFileSync(join(process.cwd(), '.claude', 'settings.local.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch hook-ran"}]}]}}\n');
    out(init);
    out(answer('done'));
    out({ ...result, result: 'done' });
    break;
  }
  case 'git-config': {
    // A run that rewrote the repository's configuration: a filter command in .git/config.
    const config = join(process.cwd(), '.git', 'config');
    writeFileSync(config, `${readFileSync(config, 'utf8')}[filter "evil"]\n\tclean = touch evil-ran\n`);
    writeFileSync(join(process.cwd(), '.gitattributes'), '*.txt filter=evil\n');
    out(init);
    out(answer('done'));
    out({ ...result, result: 'done' });
    break;
  }
  case 'env': {
    // A run that prints its whole environment: only what the clean environment let through.
    out(init);
    out(answer(JSON.stringify(process.env)));
    out({ ...result, result: 'env' });
    break;
  }
  case 'leak-to-file': {
    // The answer is clean, but the file named on the `file: ` line was copied into the workspace.
    const path = /^file: (.+)$/m.exec(prompt)?.[1] ?? '';
    writeFileSync(join(process.cwd(), 'copy.txt'), readFileSync(path, 'utf8'));
    out(init);
    out(answer('done'));
    out({ ...result, result: 'done' });
    break;
  }
  case 'edit-files': {
    // A run that changed a tracked file and added one in a subfolder (D-082).
    writeFileSync(join(process.cwd(), 'README.md'), `${readFileSync(join(process.cwd(), 'README.md'), 'utf8')}Hello.\n`);
    mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
    writeFileSync(join(process.cwd(), 'docs', 'hello.md'), '# Hello\n\nA page of the Coder.\n');
    out(init);
    out(answer('done'));
    out({ ...result, result: 'done' });
    break;
  }
  case 'live-edits': {
    // Calls to the file tools (D-117): one in the project, one outside it, one under .git; the files are left as they are.
    const use = (id: string, name: string, input: unknown) => ({ ...assistant, message: { ...assistant.message, id, content: [{ type: 'tool_use', id, name, input }] } });
    out(init);
    out(use('msg_1', 'Edit', { file_path: join(process.cwd(), 'README.md'), old_string: '# Fake site\n', new_string: '# Fake site\nHello.\n' }));
    out(use('msg_2', 'Write', { file_path: '/etc/outside.txt', content: 'outside\n' }));
    out(use('msg_3', 'Write', { file_path: join(process.cwd(), '.git', 'hooks', 'pre-commit'), content: 'echo hook\n' }));
    out(use('msg_4', 'Write', { file_path: 'docs/new.md', content: '# New\n' }));
    out(answer('done', 'msg_5'));
    out({ ...result, num_turns: 5, result: 'done' });
    break;
  }
  default:
    process.exitCode = 2;
}
