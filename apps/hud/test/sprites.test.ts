import assert from 'node:assert/strict';
import { test } from 'node:test';

import { characterId, characterNameValid, conversationState, frameAt, poseFrames, poseOf, sheetAnimations, sheetRowsOf, type Pose } from '../src/lib/sprites.ts';
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

test('sheetRowsOf: 112×96 is three rows, 112×128 four, any other size none', () => {
  assert.equal(sheetRowsOf(112, 96), 3);
  assert.equal(sheetRowsOf(112, 128), 4);
  for (const [width, height] of [[112, 64], [128, 96], [112, 160], [0, 0]] as const) assert.equal(sheetRowsOf(width, height), undefined, `${String(width)}×${String(height)}`);
});

test('sheetAnimations: every frame inside the sheet, the fourth row only on four-row sheets', () => {
  const three = sheetAnimations(3);
  const four = sheetAnimations(4);
  assert.deepEqual(three.map(({ id }) => id), ['walk-down', 'walk-up', 'walk-right', 'walk-left', 'type', 'read']);
  assert.deepEqual(four.map(({ id }) => id).slice(6), ['think', 'wait', 'pause', 'blink']);
  for (const [rows, list] of [[3, three], [4, four]] as const) {
    for (const animation of list) {
      assert.ok(animation.frames.length > 1 && animation.ms > 0, animation.id);
      for (const frame of animation.frames) assert.ok(frame.column >= 0 && frame.column < 7 && frame.row >= 0 && frame.row < rows, animation.id);
    }
  }
  assert.equal(three.find(({ id }) => id === 'walk-left')?.mirror, true);
});

test('characterNameValid: the names the core accepts, with the same id', () => {
  assert.equal(characterId('Robòt  Blu!'), 'robot-blu');
  for (const name of ['Robot blu', ' Gatto ', 'x'.repeat(40), 'R2']) assert.equal(characterNameValid(name), true, name);
  // Letters without an ascii form give no id: refused here as by the core.
  for (const name of ['', '   ', '!!!', '日本', 'a\nb', 'a​b', 'x'.repeat(41)]) assert.equal(characterNameValid(name), false, JSON.stringify(name));
});
