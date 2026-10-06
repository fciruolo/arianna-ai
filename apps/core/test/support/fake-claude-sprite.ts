// A fake `claude -p` for the sprite routes (D-123): replays the stream recorded
// from 2.1.288 (packages/executors/test/fixtures/claude-stream.jsonl) and
// answers with a drawing. The prompt is the only way in (the adapter passes
// no environment of its own): the example at the end of the fixed prompt is
// the answer, unless the user's hint asks for a scenario
// (`User hint: scenario-broken` → not JSON, `scenario-fenced` → in a code
// fence, `scenario-quota` → a quota refusal; `scenario-review<name>` does it
// only in the second pass, D-132).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const asked = /User hint: scenario-([a-z]+)/.exec(prompt)?.[1] ?? 'ok';
const review = prompt.includes('Second pass.');
const scenario = asked.startsWith('review') ? (review ? asked.slice('review'.length) : 'ok') : asked;
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

type Message = Record<string, unknown>;
const recorded = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'executors', 'test', 'fixtures', 'claude-stream.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Message);
const [init, assistant, rateLimit, result] = recorded as [Message, Message & { message: Message }, Message & { rate_limit_info: Message }, Message];
init.cwd = process.cwd();
init.tools = (flag('--tools') ?? '').split(',').filter((tool) => tool !== '');
const out = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

const example = prompt.split('\n').findLast((line) => line.startsWith('{"palette"')) ?? '{}';
const text = scenario === 'broken' ? 'Here is your character!' : scenario === 'fenced' ? `\`\`\`json\n${example}\n\`\`\`` : example;

out(init);
if (scenario === 'quota') {
  out({ ...rateLimit, rate_limit_info: { ...rateLimit.rate_limit_info, status: 'rejected', resetsAt: 1_790_979_600 } });
  out({ ...result, subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit" });
  process.exitCode = 1;
} else {
  out({ ...assistant, message: { ...assistant.message, content: [{ type: 'text', text }] } });
  out({ ...result, result: text });
}
