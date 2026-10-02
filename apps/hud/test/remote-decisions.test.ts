import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addRemoteDecision, MAX_REMOTE_DECISIONS, remoteDecision, type RemoteDecision } from '../src/lib/remote-decisions.ts';
import type { LiveEvent } from '../src/lib/types.ts';

function decided(payload: Record<string, unknown>, kind = 'approval.decided'): LiveEvent {
  return { id: '9', ts: '2026-10-02T10:00:00.000Z', taskId: null, runId: null, agent: null, kind, label: 'L0', payload };
}

test('a decision from Telegram or the phone becomes a note, with the action when known', () => {
  assert.deepEqual(remoteDecision(decided({ approvalId: 'a1', state: 'approved', via: 'telegram' }), 'payment'), {
    approvalId: 'a1',
    state: 'approved',
    via: 'telegram',
    action: 'payment',
    ts: '2026-10-02T10:00:00.000Z',
  });
  assert.equal(remoteDecision(decided({ approvalId: 'a2', state: 'rejected', via: 'phone' }))?.action, undefined);
});

test('decisions taken here, other events and malformed payloads make no note', () => {
  assert.equal(remoteDecision(decided({ approvalId: 'a1', state: 'approved', via: 'web' })), undefined);
  assert.equal(remoteDecision(decided({ approvalId: 'a1', state: 'approved', via: 'telegram' }, 'approval.requested')), undefined);
  assert.equal(remoteDecision(decided({ approvalId: 'a1', state: 'expired', via: 'telegram' })), undefined);
  assert.equal(remoteDecision(decided({ state: 'approved', via: 'telegram' })), undefined);
  assert.equal(remoteDecision(decided({ approvalId: 7, state: 'approved', via: 'telegram' })), undefined);
});

test('notes are newest first, one per approval, and capped', () => {
  const note = (approvalId: string): RemoteDecision => ({ approvalId, state: 'approved', via: 'telegram', action: undefined, ts: '' });
  let list: RemoteDecision[] = [];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) list = addRemoteDecision(list, note(id));
  assert.deepEqual(list.map((item) => item.approvalId), ['f', 'e', 'd', 'c', 'b']);
  assert.equal(list.length, MAX_REMOTE_DECISIONS);
  list = addRemoteDecision(list, { ...note('d'), state: 'rejected' });
  assert.deepEqual(list.map((item) => [item.approvalId, item.state]), [['d', 'rejected'], ['f', 'approved'], ['e', 'approved'], ['c', 'approved'], ['b', 'approved']]);
});
