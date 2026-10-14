// The terminal of a run (D-095, tappa 1): clearance, vault and the pieces under the pg_notify limit.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { HIDDEN_LINE, MAX_TERMINAL_BYTES } from '@arianna/executors';
import { Secret } from '@arianna/vault';

import { parseTerminal, terminalEntryOf, terminalFailure, terminalFor, terminalNotices } from '../src/live-terminal.ts';
import { MAX_NOTICE_BYTES } from '../src/reply.ts';

const command = (text: string) => ({ type: 'command' as const, callId: 'toolu_1', command: text, truncated: false });
const output = (text: string, error = false) => ({ type: 'command-output' as const, callId: 'toolu_1', output: text, truncated: true, error });
const WHERE = { conversationId: 'c1', taskId: 't1', step: 3 };

describe('terminalEntryOf', () => {
  it('passes a command and an output of a project within the clearance of the conversation', () => {
    assert.deepEqual(terminalEntryOf(command('pnpm test'), { label: 'L1', clearance: 'L1' }), {
      callId: 'toolu_1',
      part: 'command',
      label: 'L1',
      text: 'pnpm test',
      truncated: false,
      hidden: 0,
    });
    assert.deepEqual(terminalEntryOf(output('2 failing', true), { label: 'L0', clearance: 'L2' }), {
      callId: 'toolu_1',
      part: 'output',
      label: 'L0',
      text: '2 failing',
      truncated: true,
      hidden: 0,
      error: true,
    });
  });

  it('a conversation with a clearance below the label of the project gets nothing', () => {
    assert.equal(terminalEntryOf(command('cat README.md'), { label: 'L1', clearance: 'L0' }), undefined);
    assert.equal(terminalEntryOf(output('contenuto'), { label: 'L1', clearance: 'L0' }), undefined);
  });

  it('a project above L1 gets nothing, whatever the clearance', () => {
    assert.equal(terminalEntryOf(command('ls'), { label: 'L2', clearance: 'L3' }), undefined);
    assert.equal(terminalEntryOf(command('ls'), { label: 'L3', clearance: 'L3' }), undefined);
  });

  it('refuses a call id that is empty, too long or with control characters', () => {
    const options = { label: 'L1' as const, clearance: 'L1' as const };
    assert.equal(terminalEntryOf({ ...command('ls'), callId: '' }, options), undefined);
    assert.equal(terminalEntryOf({ ...command('ls'), callId: 'x'.repeat(129) }, options), undefined);
    assert.equal(terminalEntryOf({ ...command('ls'), callId: 'a\nb' }, options), undefined);
  });

  it('replaces the lines holding a value revealed by the vault', () => {
    const value = new Secret('vault://live-terminal-test', `segreto-${randomUUID()}`).reveal();
    const entry = terminalEntryOf(output(`ok\nTOKEN=${value}\nfine`), { label: 'L1', clearance: 'L1' });
    assert.equal(entry?.text, `ok\n${HIDDEN_LINE}\nfine`);
    assert.equal(entry.hidden, 1);
    assert.equal(JSON.stringify(entry).includes(value), false);
  });
});

describe('terminalFor', () => {
  const task = { id: 't1', conversationId: 'c1', clearance: 'L1' as const };

  it('sends to the conversation of the task, within its clearance', () => {
    assert.deepEqual(terminalFor(task, 3, 'L1', command('ls'))?.where, WHERE);
  });

  it('a conversation whose clearance is below the label of the project gets no terminal notice', () => {
    assert.equal(terminalFor({ ...task, clearance: 'L0' }, 3, 'L1', command('ls')), undefined);
    assert.equal(terminalFor({ ...task, clearance: 'L0' }, 3, 'L1', output('x')), undefined);
  });

  it('a task outside a conversation sends nothing', () => {
    assert.equal(terminalFor({ ...task, conversationId: null }, 3, 'L0', command('ls')), undefined);
  });
});

describe('terminalNotices', () => {
  it('cuts the text in pieces under the pg_notify limit that join back, each one parsed by the live feed', () => {
    const text = Array.from({ length: 200 }, (_, index) => `riga è ${String(index)} "\\" \u0001`).join('\n').slice(0, MAX_TERMINAL_BYTES);
    const entry = { callId: 'toolu_1', part: 'output' as const, label: 'L1' as const, text, truncated: false, hidden: 0 };
    const notices = terminalNotices(WHERE, entry);
    assert.ok(notices.length > 1);
    for (const notice of notices) assert.ok(Buffer.byteLength(notice) <= MAX_NOTICE_BYTES);
    const parsed = notices.map((notice) => parseTerminal(notice));
    assert.ok(parsed.every((item) => item !== undefined && item.total === notices.length && item.taskId === 't1'));
    assert.equal(parsed.map((item) => item?.text).join(''), text);
  });

  it('an empty output is one empty piece', () => {
    const notices = terminalNotices(WHERE, { callId: 'toolu_1', part: 'output', label: 'L0', text: '', truncated: false, hidden: 0, refused: true });
    assert.deepEqual(parseTerminal(notices[0] ?? ''), { callId: 'toolu_1', ...WHERE, part: 'output', label: 'L0', truncated: false, hidden: 0, refused: true, seq: 0, total: 1, text: '' });
  });

  it('the live feed refuses a malformed notice or a label above L1', () => {
    const [notice] = terminalNotices(WHERE, { callId: 'toolu_1', part: 'command', label: 'L1', text: 'ls', truncated: false, hidden: 0 });
    const value = JSON.parse(notice ?? '') as Record<string, unknown>;
    assert.equal(parseTerminal(JSON.stringify({ ...value, label: 'L2' })), undefined);
    assert.equal(parseTerminal(JSON.stringify({ ...value, part: 'input' })), undefined);
    assert.equal(parseTerminal(JSON.stringify({ ...value, seq: 1 })), undefined);
    assert.equal(parseTerminal('not json'), undefined);
  });

  it('the log of a failed entry says the class and code of the error, never its message', () => {
    assert.equal(terminalFailure(Object.assign(new Error('cat .env'), { code: '22023' })), 'terminal not sent: Error (22023)');
  });
});
