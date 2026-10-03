// A fake `claude -p` for the adapter tests: replays the stream of a real run
// (claude-stream.jsonl, recorded from 2.1.288) and bends it per scenario. The
// scenario is the first line of the prompt, `scenario: <name>`: the adapter
// passes no environment of its own, so the prompt is the only way in.
// It writes what it received to `.fake-claude.json` in its working directory.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const scenario = /^scenario: ([a-z0-9-]+)/.exec(prompt)?.[1] ?? 'ok';
writeFileSync(join(process.cwd(), '.fake-claude.json'), JSON.stringify({ argv, env: process.env, prompt }));

const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const sessionRef = flag('--resume') ?? '00000000-0000-4000-8000-000000000001';
const tools = (flag('--tools') ?? '').split(',').filter((tool) => tool !== '');

type Message = Record<string, unknown>;
interface Assistant extends Message {
  message: Message;
}
interface RateLimit extends Message {
  rate_limit_info: Message;
}
const recorded = readFileSync(join(import.meta.dirname, 'claude-stream.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Message);
const [init, assistant, rateLimit, result] = recorded as [Message, Assistant, RateLimit, Message];
init.cwd = process.cwd();
init.tools = tools;
for (const message of recorded) message.session_id = sessionRef;

const out = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const answer = (text: string, id = 'msg_1') => ({ ...assistant, message: { ...assistant.message, id, content: [{ type: 'text', text }] } });
const hang = () => setInterval(() => undefined, 1_000);

switch (scenario) {
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
  case 'leak-to-file': {
    // The answer is clean, but the file named on the `file: ` line was copied into the workspace.
    const path = /^file: (.+)$/m.exec(prompt)?.[1] ?? '';
    writeFileSync(join(process.cwd(), 'copy.txt'), readFileSync(path, 'utf8'));
    out(init);
    out(answer('done'));
    out({ ...result, result: 'done' });
    break;
  }
  default:
    process.exitCode = 2;
}
