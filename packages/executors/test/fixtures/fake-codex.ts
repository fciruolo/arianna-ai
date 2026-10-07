// A fake `codex exec --json` for the adapter tests: replays the stream of a
// real run (codex-stream.jsonl, recorded from 0.160.0) and bends it per
// scenario. The scenario is the first line of the prompt, `scenario: <name>`:
// the adapter passes no environment of its own, so the prompt is the only way
// in. It writes what it received to `.fake-codex.json` in its working directory.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === 'sandbox') {
  // `codex sandbox <permissions> -- <command>`: run with no sandbox, so that the canary tests see what a broken one lets through.
  const command = argv.slice(argv.indexOf('--') + 1);
  const result = spawnSync(command[0] ?? 'false', command.slice(1), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const prompt = readFileSync(0, 'utf8');
const scenario = /^scenario: ([a-z0-9-]+)/.exec(prompt)?.[1] ?? 'ok';
writeFileSync(join(process.cwd(), '.fake-codex.json'), JSON.stringify({ argv, env: process.env, prompt }));

const resumeAt = argv.indexOf('resume');
const resumed = resumeAt === -1 ? undefined : argv[resumeAt + 1];
const threadId = resumed ?? '01a114e7-94d7-77c2-bb06-60bdefff158e';

type Message = Record<string, unknown>;
const recorded = readFileSync(join(import.meta.dirname, 'codex-stream.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Message);
const thread = { type: 'thread.started', thread_id: threadId };
const turn = { type: 'turn.started' };
const completed = recorded.at(-1) as Message;
const message = (text: string, id = 'item_0') => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const item = (type: string, extra: Message = {}) => ({ type: 'item.started', item: { id: 'item_9', type, ...extra } });
const apiError = (status: number, text: string) => JSON.stringify({ type: 'error', status, error: { type: 'invalid_request_error', message: text } });

const out = (line: unknown) => process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
const hang = () => setInterval(() => undefined, 1_000);

switch (scenario) {
  case 'ok':
    out(thread);
    out(turn);
    out(message(resumed === undefined ? 'ok' : 'resumed'));
    out(completed);
    break;
  case 'tool':
    for (const line of recorded) out(line);
    break;
  case 'quota': {
    const text = "You've hit your usage limit. Upgrade or try again later.";
    out(thread);
    out(turn);
    out({ type: 'error', message: text });
    out({ type: 'turn.failed', error: { message: text } });
    process.exitCode = 1;
    break;
  }
  case 'http-429':
    out(thread);
    out(turn);
    out({ type: 'turn.failed', error: { message: apiError(429, 'Too many requests') } });
    process.exitCode = 1;
    break;
  case 'error':
    out(thread);
    out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata not found. Defaulting to fallback metadata.' } });
    out(turn);
    out({ type: 'error', message: apiError(400, 'The model is not supported when using Codex with a ChatGPT account.') });
    out({ type: 'turn.failed', error: { message: apiError(400, 'The model is not supported when using Codex with a ChatGPT account.') } });
    process.exitCode = 1;
    break;
  case 'many-tools':
    out(thread);
    out(turn);
    for (let index = 0; index < 5; index += 1) out(item('command_execution', { command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' }));
    hang();
    break;
  case 'hang':
    out(thread);
    hang();
    break;
  case 'ignore-term':
    process.on('SIGTERM', () => undefined);
    out(thread);
    hang();
    break;
  case 'crash':
    out(thread);
    process.exit(3);
    break;
  case 'garbage':
    out(thread);
    out('not json');
    break;
  case 'before-thread':
    out(turn);
    out(thread);
    out(message('ok'));
    out(completed);
    break;
  case 'mcp':
    out(thread);
    out(turn);
    out(item('mcp_tool_call', { server: 'mail', tool: 'send' }));
    out(message('ok'));
    out(completed);
    break;
  case 'web-search':
    out(thread);
    out(turn);
    out(item('web_search', { query: 'secret' }));
    out(message('ok'));
    out(completed);
    break;
  case 'new-session':
    out({ type: 'thread.started', thread_id: '01a114e7-0000-7000-8000-000000000002' });
    out(turn);
    out(message('ok'));
    out(completed);
    break;
  case 'exit-after-turn':
    out(thread);
    out(turn);
    out(message('ok'));
    out(completed);
    process.exitCode = 2;
    break;
  case 'no-turn':
    out(thread);
    out(turn);
    out(message('half'));
    break;
  case 'odd-items':
    out(thread);
    out(turn);
    out({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'thinking' } });
    out({ type: 'item.completed', item: { id: 't', type: 'todo_list', items: [] } });
    out({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: '/w/a.ts', kind: 'rename' }, { path: '', kind: 'add' }, 'x', { path: '/w/b.ts', kind: 'add' }], status: 'completed' } });
    out({ type: 'some.future.event', anything: true });
    out(message('ok'));
    out(completed);
    break;
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exitCode = 9;
}
