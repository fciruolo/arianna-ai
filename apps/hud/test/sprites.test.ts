import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conversationState, frameAt, poseFrames, poseOf, type Pose } from '../src/lib/sprites.ts';
import type { Activity, ActivityKind, Approval, Task, TaskStatus } from '../src/lib/types.ts';

const POSES: Pose[] = ['idle', 'thinking', 'working', 'reading', 'waiting', 'paused'];

test('every pose stays inside the sheet: the fourth row only on four-row sheets', () => {
  for (const rows of [3, 4] as const) {
    for (const pose of POSES) {
      const { frames, ms } = poseFrames(pose, rows);
      assert.ok(frames.length > 0 && ms > 0, pose);
      for (const frame of frames) {
        assert.ok(frame.column >= 0 && frame.column < 7, `${pose} column`);
        assert.ok(frame.row >= 0 && frame.row < rows, `${pose} row ${String(frame.row)} on ${String(rows)} rows`);
      }
    }
  }
  assert.deepEqual(poseFrames('thinking', 4).frames, [{ column: 0, row: 3 }, { column: 1, row: 3 }]);
  assert.deepEqual(poseFrames('thinking', 3).frames, [{ column: 5, row: 0 }, { column: 6, row: 0 }]);
  assert.deepEqual(poseFrames('working', 3).frames, [{ column: 3, row: 0 }, { column: 4, row: 0 }]);
});

test('idle blinks once per cycle on a sheet that has the blink frame', () => {
  const blinks = (rows: 3 | 4) => poseFrames('idle', rows).frames.filter((frame) => frame.row === 3).length;
  assert.equal(blinks(4), 1);
  assert.equal(blinks(3), 0);
});

test('frameAt cycles through the frames, and holds the first with reduced motion', () => {
  const pose = poseFrames('working', 4);
  assert.deepEqual(frameAt(pose, 0, false), { column: 3, row: 0 });
  assert.deepEqual(frameAt(pose, 180, false), { column: 4, row: 0 });
  assert.deepEqual(frameAt(pose, 360, false), { column: 3, row: 0 });
  assert.deepEqual(frameAt(pose, 180, true), { column: 3, row: 0 });
  assert.deepEqual(frameAt(pose, -5, false), { column: 3, row: 0 });
});

test('poseOf: the line of activity wins over the status; without either the agent is idle', () => {
  const line = (kind: ActivityKind): Activity => ({ conversationId: 'c', taskId: 't', step: 1, kind, detail: '' });
  assert.equal(poseOf('idle', line('read')), 'reading');
  assert.equal(poseOf('idle', line('search')), 'reading');
  assert.equal(poseOf('thinking', line('write')), 'working');
  assert.equal(poseOf('idle', line('delegate')), 'working');
  assert.equal(poseOf('waiting', line('thinking')), 'thinking');
  assert.equal(poseOf('waiting', undefined), 'waiting');
  assert.equal(poseOf('working', undefined), 'working');
  assert.equal(poseOf(undefined, undefined), 'idle');
});

test('conversationState: only the tasks of the open conversation count; at work wins over waiting', () => {
  const task = (status: TaskStatus) => ({ id: `t-${status}`, conversationId: 'c', waitingApprovalId: null, status });
  assert.equal(conversationState([], 'c'), 'idle');
  assert.equal(conversationState([task('done'), task('failed'), task('to_verify')], 'c'), 'idle');
  assert.equal(conversationState([task('done'), task('waiting_user')], 'c'), 'waiting');
  for (const status of ['inbox', 'ready', 'running'] as const) {
    assert.equal(conversationState([task('waiting_user'), task(status)], 'c'), 'thinking');
  }
});

test('conversationState: "waiting" only with a real approval or question in this conversation (D-084)', () => {
  type Row = Pick<Task, 'id' | 'conversationId' | 'status' | 'waitingApprovalId'>;
  const approval = (id: string, taskId: string | null, state: Approval['state'] = 'pending') => ({ id, taskId, state });
  // A system chat: the failed task of its source conversation is not one of its tasks.
  const elsewhere: Row = { id: 'src', conversationId: 'source', status: 'waiting_user', waitingApprovalId: 'a1' };
  assert.equal(conversationState([elsewhere], 'system', [approval('a1', 'src')]), 'idle');
  assert.equal(conversationState([elsewhere], undefined, [approval('a1', 'src')]), 'idle');
  // Waiting for an approval still pending: waiting; decided elsewhere (or no longer listed): not.
  const waiting: Row = { id: 't1', conversationId: 'c', status: 'waiting_user', waitingApprovalId: 'a1' };
  assert.equal(conversationState([waiting], 'c', [approval('a1', 't1')]), 'waiting');
  assert.equal(conversationState([waiting], 'c', [approval('a1', 't1', 'approved')]), 'idle');
  assert.equal(conversationState([waiting], 'c', []), 'idle');
  // A pending approval of a task of this conversation counts even before the task says it waits.
  const settled: Row = { id: 't2', conversationId: 'c', status: 'to_verify', waitingApprovalId: null };
  assert.equal(conversationState([settled], 'c', [approval('a2', 't2')]), 'waiting');
  assert.equal(conversationState([settled], 'c', [approval('a2', 'other')]), 'idle');
  assert.equal(conversationState([settled], 'c', [approval('a3', null)]), 'idle');
});
