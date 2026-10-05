import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Answer } from '@arianna/agents';

import { earlierCall, stoppedRepeats } from '../src/orchestrator/orchestrator.ts';
import type { Turn } from '../src/orchestrator/turns.ts';

function turn(step: number, answer: Answer, result = 'ok'): Turn {
  return { step, runId: 'run', label: 'L0', answer, thought: null, result, messageId: null };
}

const turns = [
  turn(1, { action: 'plan', steps: ['Cercare'] }),
  turn(2, { action: 'call', tool: 'kb.search', arguments: { query: 'caparra', limit: 5 } }),
  turn(3, { action: 'call', tool: 'kb.read', arguments: { path: 'kb/private/affitto.md' } }),
];

test('a call with the same tool and arguments, in any key order, is the earlier one (D-076)', () => {
  assert.equal(earlierCall(turns, 'kb.search', { limit: 5, query: 'caparra' }), 2);
  assert.equal(earlierCall(turns, 'kb.read', { path: 'kb/private/affitto.md' }), 3);
});

test('another tool, other arguments or one argument less make a new call', () => {
  assert.equal(earlierCall(turns, 'kb.read', { path: 'kb/private/caparra.md' }), undefined);
  assert.equal(earlierCall(turns, 'kb.search', { query: 'caparra' }), undefined);
  assert.equal(earlierCall(turns, 'kb.search', { query: 'Caparra', limit: 5 }), undefined);
  assert.equal(earlierCall(turns, 'kb.write', { path: 'kb/private/affitto.md' }), undefined);
  assert.equal(earlierCall([], 'kb.search', { query: 'caparra' }), undefined);
});

test('after a page is written, the same read or search is a new call; a write is still a repeat', () => {
  const read = { action: 'call', tool: 'kb.read', arguments: { path: 'kb/inbox/nota.md' } } as const;
  const write = { action: 'call', tool: 'kb.write', arguments: { path: 'kb/inbox/nota.md', content: 'Nota.' } } as const;
  const before = [turn(1, read, 'error: kb.read: page kb/inbox/nota.md not found')];
  assert.equal(earlierCall(before, 'kb.read', read.arguments), 1);
  const after = [...before, turn(2, write, 'written kb/inbox/nota.md')];
  assert.equal(earlierCall(after, 'kb.read', read.arguments), undefined);
  assert.equal(earlierCall(after, 'kb.write', write.arguments), 2);
  // A write that failed changed nothing.
  const failed = [...before, turn(2, write, 'error: kb.write: refused')];
  assert.equal(earlierCall(failed, 'kb.read', read.arguments), 1);
});

test('stopped repeats are read from the turns, and every third one waits', () => {
  const search = { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } } as const;
  const steps = [1, 2, 3, 4, 5].map((step) => turn(step, search, 'whatever the text'));
  assert.deepEqual(stoppedRepeats(steps), [
    { step: 2, waits: false },
    { step: 3, waits: false },
    { step: 4, waits: true },
    { step: 5, waits: false },
  ]);
  assert.deepEqual(stoppedRepeats(turns), []);
});

const CARD = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d';
const wait = { action: 'call', tool: 'task.update', arguments: { task_id: CARD, status: 'waiting_user', note: 'Attendo.' } } as const;
const ready = { action: 'call', tool: 'task.update', arguments: { task_id: CARD.slice(0, 8), status: 'ready' } } as const;
const updated = (to: string) => `updated card ${CARD}: x → ${to}`;

test('the same card update is a repeat until an update of the same card goes through with other arguments', () => {
  assert.equal(earlierCall([turn(1, wait, updated('waiting_user'))], 'task.update', wait.arguments), 1);
  // Waiting, ready (named by a prefix), waiting again: the third call is a new one.
  const moved = [turn(1, wait, updated('waiting_user')), turn(2, ready, updated('ready'))];
  assert.equal(earlierCall(moved, 'task.update', wait.arguments), undefined);
  assert.equal(earlierCall(moved, 'task.update', ready.arguments), 2);
  // An update of another card does not restart the count.
  const other = { action: 'call', tool: 'task.update', arguments: { task_id: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', status: 'ready' } } as const;
  const elsewhere = [turn(1, wait, updated('waiting_user')), turn(2, other, 'updated card 8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f: x → ready')];
  assert.equal(earlierCall(elsewhere, 'task.update', wait.arguments), 1);
});

test('failed updates never restart the count: A, B, A, B are two repeats', () => {
  const failed = [turn(1, wait, 'error: task.update: no open card'), turn(2, ready, 'error: task.update: no open card')];
  assert.equal(earlierCall(failed, 'task.update', wait.arguments), 1);
  assert.equal(earlierCall([...failed, turn(3, wait, 'error: task.update: the same call')], 'task.update', ready.arguments), 2);
  const steps = [...failed, turn(3, wait, 'x'), turn(4, ready, 'x')];
  assert.deepEqual(stoppedRepeats(steps), [
    { step: 3, waits: false },
    { step: 4, waits: false },
  ]);
});
