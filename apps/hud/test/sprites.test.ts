import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conversationState, frameAt, poseFrames, poseOf, type Pose } from '../src/lib/sprites.ts';
import type { Activity, ActivityKind } from '../src/lib/types.ts';

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
  assert.equal(conversationState([]), 'idle');
  assert.equal(conversationState([{ status: 'done' }, { status: 'failed' }, { status: 'to_verify' }]), 'idle');
  assert.equal(conversationState([{ status: 'done' }, { status: 'waiting_user' }]), 'waiting');
  for (const status of ['inbox', 'ready', 'running'] as const) {
    assert.equal(conversationState([{ status: 'waiting_user' }, { status }]), 'thinking');
  }
});
