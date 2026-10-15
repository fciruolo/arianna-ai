// The "Computer" panel of the Coder's run (D-095, tappa 1): terminal pieces, the File tab and a panel without inputs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applyEdit, applyTerminal, emptyChat, mergeMessages } from '../src/lib/chat-state.ts';
import { atWork, computerTask, delegationCredit, filesView, mayReadFile, sandboxRefusal, savedCalls } from '../src/lib/computer.ts';
import { parseServerMessage } from '../src/lib/protocol.ts';
import type { EditPiece, Message, MessageCredit, Task, TerminalPiece } from '../src/lib/types.ts';

const C = 'c1';
const piece = (extra: Partial<TerminalPiece> = {}): TerminalPiece => ({
  callId: 'toolu_1',
  conversationId: C,
  taskId: 't1',
  step: 2,
  part: 'command',
  label: 'L1',
  truncated: false,
  hidden: 0,
  seq: 0,
  total: 1,
  text: 'pnpm test',
  ...extra,
});
const edit = (path: string): EditPiece => ({ editId: `e-${path}`, conversationId: C, taskId: 't1', step: 2, path, tool: 'Edit', label: 'L1', added: 1, removed: 0, seq: 0, total: 1, text: '+a' });
const message = (id: string, extra: Partial<Message> = {}): Message => ({ id, conversationId: C, ts: '', role: 'assistant', channel: 'web', label: 'L1', body: 'x', taskId: 't1', agent: 'coder', model: null, ...extra });
const task = (status: Task['status']): Record<string, Task> => ({ t1: { id: 't1', conversationId: C, title: 't', status, effectiveLabel: 'L1', waitingReason: null, waitingApprovalId: null } });
const credit: MessageCredit = {
  messageId: '5',
  delegationId: 'd1',
  agent: 'coder',
  executor: 'claude',
  alias: 'sonnet',
  model: null,
  durationMs: 1000,
  cost: null,
  repo: 'demo',
  readChat: false,
  files: [
    { path: 'src/a.ts', change: 'modified' },
    { path: 'old.ts', change: 'deleted' },
  ],
};

describe('terminal frames', () => {
  it('the protocol takes a terminal piece and refuses a label above L1 or an unknown part', () => {
    const frame = { type: 'terminal', ...piece() };
    assert.deepEqual(parseServerMessage(JSON.stringify(frame)), frame);
    assert.equal(parseServerMessage(JSON.stringify({ ...frame, label: 'L2' })), undefined);
    assert.equal(parseServerMessage(JSON.stringify({ ...frame, part: 'input' })), undefined);
    assert.equal(parseServerMessage(JSON.stringify({ ...frame, seq: 1 })), undefined);
  });

  it('the pieces of a part join in order, the output follows its command, other conversations are ignored', () => {
    let state = applyTerminal(emptyChat(C), piece());
    state = applyTerminal(state, piece({ part: 'output', seq: 1, total: 2, text: 'b', error: true }));
    assert.equal(state.terminal.t1?.[0]?.output?.text, undefined);
    state = applyTerminal(state, piece({ part: 'output', seq: 0, total: 2, text: 'a', error: true }));
    const [call] = state.terminal.t1 ?? [];
    assert.ok(call?.command !== undefined && call.output !== undefined);
    assert.equal(call.command.text, 'pnpm test');
    assert.equal(call.output.text, 'ab');
    assert.equal(call.output.error, true);
    assert.equal(applyTerminal(state, piece({ conversationId: 'other', callId: 'x' })), state);
  });
});

describe('the File tab', () => {
  it('while the run works shows only the paths of its changes, and no file may be read', () => {
    let state = mergeMessages(emptyChat(C), [message('4', { role: 'user', agent: null })]);
    state = applyEdit(state, edit('src/a.ts'));
    state = applyEdit(state, edit('src/b.ts'));
    state = applyEdit(state, { ...edit('src/a.ts'), editId: 'again' });
    const view = filesView(state, 't1', 'running', undefined);
    assert.deepEqual(view, { mode: 'live', paths: ['src/a.ts', 'src/b.ts'] });
    assert.equal(mayReadFile(view, 0), false);
    // Even with a credit already there, a run at work does not read files.
    assert.equal(mayReadFile(filesView(state, 't1', 'running', credit), 0), false);
    assert.equal(computerTask(state, new Map()), 't1');
  });

  it('once the run ended shows the files of the delegation, readable except a deleted one', () => {
    const state = mergeMessages(emptyChat(C), [message('4', { role: 'user', agent: null }), message('5')]);
    const credits = new Map([['5', credit]]);
    assert.equal(delegationCredit(state, credits, 't1'), credit);
    assert.equal(computerTask(state, credits), 't1');
    const view = filesView(state, 't1', 'done', credit);
    assert.equal(view.mode, 'final');
    assert.equal(mayReadFile(view, 0), true);
    assert.equal(mayReadFile(view, 1), false);
    assert.equal(mayReadFile(view, 9), false);
  });

  it('a conversation without a run of the Coder has no task to show', () => {
    const state = mergeMessages(emptyChat(C), [message('4', { role: 'user', agent: null })]);
    assert.equal(computerTask(state, new Map()), undefined);
    // Arianna at work on her own is not a run of the Coder, and an unknown status is not "at work".
    assert.equal(atWork(task('running').t1?.status), true);
    assert.equal(atWork(undefined), false);
  });
});

describe('savedCalls', () => {
  it('pairs a saved command with its output, in order', () => {
    const row = { step: 1, truncated: false, hidden: 0, refused: false, error: false };
    const calls = savedCalls([
      { ...row, callId: 'a', part: 'command', text: 'ls' },
      { ...row, callId: 'b', part: 'command', text: 'git status' },
      { ...row, callId: 'a', part: 'output', text: 'README.md', error: true },
    ]);
    assert.deepEqual(calls.map((call) => [call.callId, call.command?.text, call.output?.text, call.output?.error]), [
      ['a', 'ls', 'README.md', true],
      ['b', 'git status', undefined, undefined],
    ]);
    assert.deepEqual(savedCalls([]), []);
  });
});

describe('sandboxRefusal', () => {
  it('marks the refusals of the cage: a read outside the folder, the network', () => {
    assert.equal(sandboxRefusal('cat: .zshrc: Operation not permitted'), true);
    assert.equal(sandboxRefusal('curl: (6) Could not resolve host: example.com'), true);
    assert.equal(sandboxRefusal('curl: (56) CONNECT tunnel failed, response 403'), true);
    assert.equal(sandboxRefusal('npm error getaddrinfo ENOTFOUND registry.npmjs.org'), true);
  });

  it('does not mark an ordinary error or output', () => {
    assert.equal(sandboxRefusal('ls: missing.txt: No such file or directory'), false);
    assert.equal(sandboxRefusal('fatal: not a git repository'), false);
    assert.equal(sandboxRefusal(''), false);
    assert.equal(sandboxRefusal(undefined), false);
  });
});

describe('ComputerPanel.vue', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'ComputerPanel.vue'), 'utf8');

  it('has no field that could write to the run', () => {
    const template = source.slice(source.indexOf('<template>'));
    assert.ok(template.length > 0);
    assert.doesNotMatch(template, /<(input|textarea|select|form)\b/i);
    assert.doesNotMatch(template, /contenteditable/i);
    assert.doesNotMatch(template, /v-model/);
  });

  it('reads a file only through the guard that refuses a run at work', () => {
    const calls = source.match(/loadDelegationFile\(/g) ?? [];
    assert.equal(calls.length, 1);
    const guard = source.indexOf('!mayReadFile(view, index)) return;');
    assert.ok(guard > 0 && guard < source.indexOf('await loadDelegationFile('));
  });
});
