// The terminal of a run (D-095, tappa 1): commands and outputs of Bash taken
// from the stream of `claude -p`, cut, with the values of the vault hidden.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  bashCommandOf,
  ClaudeStream,
  clipTerminal,
  HIDDEN_LINE,
  MAX_TERMINAL_BYTES,
  MAX_RAW_TERMINAL_BYTES,
  MAX_TERMINAL_LINES,
  rawTerminal,
  terminalShown,
  terminalText,
  toolResultText,
} from '@arianna/executors';
import { secretMatcher } from '@arianna/policy';

const recorded = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8').trim().split('\n');
const init = (cwd: string): string => JSON.stringify({ ...(JSON.parse(recorded[0] ?? '') as object), cwd });
// The recorded assistant message, past the partial messages built by hand (D-249).
const assistant = JSON.parse(recorded.find((line) => line.startsWith('{"type":"assistant"')) ?? '') as { message: Record<string, unknown> };
const use = (id: string, name: string, input: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...assistant, ...extra, message: { ...assistant.message, id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false, ...extra }] }, parent_tool_use_id: null });

describe('clipTerminal', () => {
  it('keeps a short text as it is', () => {
    assert.deepEqual(clipTerminal('ok\nfine'), { text: 'ok\nfine', truncated: false });
    assert.deepEqual(clipTerminal('a\r\nb'), { text: 'a\nb', truncated: false });
  });

  it('cuts past the lines and the bytes', () => {
    const many = Array.from({ length: MAX_TERMINAL_LINES + 50 }, (_, line) => `riga ${String(line)}`).join('\n');
    const cut = clipTerminal(many);
    assert.equal(cut.truncated, true);
    assert.equal(cut.text.split('\n').length, MAX_TERMINAL_LINES);
    assert.equal(cut.text.split('\n').at(-1), `riga ${String(MAX_TERMINAL_LINES - 1)}`);
    const wide = clipTerminal('è'.repeat(MAX_TERMINAL_BYTES));
    assert.equal(wide.truncated, true);
    assert.ok(Buffer.byteLength(wide.text) <= MAX_TERMINAL_BYTES);
    assert.equal(wide.text, 'è'.repeat(MAX_TERMINAL_BYTES / 2));
    const exact = clipTerminal('x'.repeat(MAX_TERMINAL_BYTES));
    assert.equal(exact.truncated, false);
  });
});

describe('terminalShown', () => {
  const value = 'segreto-del-vault-1234';
  const secrets = secretMatcher([{ ref: 'vault://test', value }]);

  it('passes a text without values of the vault', () => {
    assert.deepEqual(terminalShown('npm test\nok', secrets), { text: 'npm test\nok', hidden: 0 });
  });

  it('replaces the lines holding a value of the vault', () => {
    const shown = terminalShown(`prima\nTOKEN=${value}\ndopo`, secrets);
    assert.deepEqual(shown, { text: `prima\n${HIDDEN_LINE}\ndopo`, hidden: 1 });
    assert.equal(shown.text.includes(value), false);
  });

  it('shows nothing when the value is split over lines', () => {
    const secretsWithNewline = secretMatcher([{ ref: 'vault://pem', value: 'riga-uno\nriga-due' }]);
    assert.equal(terminalShown('x\nriga-uno\nriga-due\ny', secretsWithNewline), undefined);
  });
});

describe('terminalText', () => {
  const value = 'segreto-del-vault-5678';
  const secrets = secretMatcher([{ ref: 'vault://test', value }]);

  it('filters the vault on the whole text before the cut: a value across the limit leaves no piece', () => {
    // The value starts a few bytes before the 16 KiB limit, on the same line.
    const raw = `${'x'.repeat(MAX_TERMINAL_BYTES - 6)}${value}\ndopo`;
    const shown = terminalText(raw, secrets);
    assert.ok(shown !== undefined);
    assert.equal(shown.hidden, 1);
    assert.equal(shown.text.includes(value.slice(0, 6)), false);
    assert.equal(shown.text, `${HIDDEN_LINE}\ndopo`);
    // A value over several lines across the 200-line limit: nothing is shown.
    const pem = secretMatcher([{ ref: 'vault://pem', value: 'inizio-chiave\nfine-chiave' }]);
    const lines = `${Array.from({ length: MAX_TERMINAL_LINES - 1 }, () => 'a').join('\n')}\ninizio-chiave\nfine-chiave`;
    assert.equal(terminalText(lines, pem), undefined);
  });

  it('cuts a clean text and counts nothing hidden', () => {
    const long = Array.from({ length: MAX_TERMINAL_LINES + 1 }, () => 'y').join('\n');
    assert.deepEqual(terminalText(long, secrets), { text: long.split('\n').slice(0, MAX_TERMINAL_LINES).join('\n'), truncated: true, hidden: 0 });
  });

  it('the stream passes a text whole, or empty past the raw limit', () => {
    assert.deepEqual(rawTerminal('ok'), { text: 'ok', truncated: false });
    assert.deepEqual(rawTerminal('z'.repeat(MAX_RAW_TERMINAL_BYTES + 1)), { text: '', truncated: true });
  });
});

describe('Bash in the stream', () => {
  it('reads the command and the output of a call, whole for the vault filter', () => {
    assert.equal(bashCommandOf('Bash', { command: 'ls -la', description: 'list' }), 'ls -la');
    assert.equal(bashCommandOf('Read', { command: 'ls' }), undefined);
    assert.equal(bashCommandOf('Bash', { command: 3 }), undefined);
    assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
    assert.equal(toolResultText(42), undefined);

    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(init('/w'));
    const long = Array.from({ length: MAX_TERMINAL_LINES + 1 }, () => 'x').join('\n');
    const events = [
      use('toolu_1', 'Bash', { command: 'pnpm test' }),
      use('toolu_2', 'Read', { file_path: '/w/a.ts' }),
      result('toolu_2', 'contenuto di un file'),
      result('toolu_1', long, { is_error: true }),
      // A second result for the same call, and one for a call never seen: ignored.
      result('toolu_1', 'again'),
      result('toolu_9', 'unknown'),
    ].flatMap((line) => stream.feed(line).filter((event) => event.type === 'command' || event.type === 'command-output'));
    assert.deepEqual(events, [
      { type: 'command', callId: 'toolu_1', command: 'pnpm test', truncated: false },
      { type: 'command-output', callId: 'toolu_1', output: long, truncated: false, error: true },
    ]);
  });

  it('ignores the calls of subagents', () => {
    const stream = new ClaudeStream({ cwd: '/w', tools: ['Read'] });
    stream.feed(init('/w'));
    const events = stream.feed(use('toolu_s', 'Bash', { command: 'ls' }, { parent_tool_use_id: 'toolu_0' }));
    assert.deepEqual(events, []);
    assert.deepEqual(stream.feed(result('toolu_s', 'a')), []);
  });
});
