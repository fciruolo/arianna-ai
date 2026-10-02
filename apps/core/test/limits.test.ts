import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeLimit, limitReached, parseLimits, remainingMs } from '../src/limits.ts';
import { canMove, movesInto, TASK_STATUSES } from '../src/task-status.ts';

const FRESH = { steps: 0, minutes: 0, cost: 0 };

describe('parseLimits', () => {
  it('reads the snake_case keys of the agent cards', () => {
    assert.deepEqual(parseLimits({ max_steps: 30, max_minutes: 20, max_cost: 0 }), { maxSteps: 30, maxMinutes: 20, maxCost: 0 });
    assert.deepEqual(parseLimits({}), {});
  });

  it('rejects unknown keys and bad values', () => {
    assert.throws(() => parseLimits({ max_tokens: 1 }), /unknown key/);
    assert.throws(() => parseLimits({ max_steps: -1 }), /at least 0/);
    assert.throws(() => parseLimits({ max_steps: '3' }), /at least 0/);
    assert.throws(() => parseLimits([]), /object/);
  });
});

describe('limitReached', () => {
  it('stops at the step cap, not before', () => {
    assert.equal(limitReached({ maxSteps: 3 }, { ...FRESH, steps: 2 }), undefined);
    assert.deepEqual(limitReached({ maxSteps: 3 }, { ...FRESH, steps: 3 }), { limit: 'steps', used: 3, max: 3 });
  });

  it('stops at the time cap, not before', () => {
    assert.equal(limitReached({ maxMinutes: 20 }, { ...FRESH, minutes: 19.9 }), undefined);
    assert.equal(limitReached({ maxMinutes: 20 }, { ...FRESH, minutes: 20 })?.limit, 'minutes');
  });

  it('lets free steps run with max_cost 0, stops any paid one', () => {
    assert.equal(limitReached({ maxCost: 0 }, FRESH), undefined);
    assert.equal(limitReached({ maxCost: 0 }, { ...FRESH, cost: 0.01 })?.limit, 'cost');
  });

  it('has no cap when no limit is set', () => {
    assert.equal(limitReached({}, { steps: 1e6, minutes: 1e6, cost: 1e6 }), undefined);
  });
});

describe('remainingMs and describeLimit', () => {
  it('gives the time left before the cap', () => {
    assert.equal(remainingMs({ maxMinutes: 2 }, { ...FRESH, minutes: 1.5 }), 30_000);
    assert.equal(remainingMs({ maxMinutes: 2 }, { ...FRESH, minutes: 3 }), 0);
    assert.equal(remainingMs({}, FRESH), undefined);
  });

  it('writes one line', () => {
    assert.equal(describeLimit({ limit: 'steps', used: 30, max: 30 }), 'limit reached: 30 of 30 steps');
  });
});

describe('task moves', () => {
  it('allows the cardwall flow', () => {
    for (const [from, to] of [
      ['inbox', 'ready'],
      ['ready', 'running'],
      ['running', 'running'],
      ['running', 'waiting_user'],
      ['waiting_user', 'ready'],
      ['running', 'to_verify'],
      ['to_verify', 'done'],
      ['failed', 'ready'],
    ] as const) {
      assert.ok(canMove(from, to), `${from} -> ${to}`);
    }
  });

  it('refuses shortcuts and moves out of done', () => {
    for (const [from, to] of [
      ['inbox', 'running'],
      ['ready', 'done'],
      ['running', 'done'],
      ['done', 'ready'],
      ['to_verify', 'running'],
      // resumeTask must not act on a task in progress.
      ['running', 'ready'],
    ] as const) {
      assert.ok(!canMove(from, to), `${from} -> ${to}`);
    }
    for (const to of TASK_STATUSES) assert.ok(!canMove('done', to));
  });

  it('lists the statuses that lead into one', () => {
    assert.deepEqual(movesInto('to_verify'), ['running']);
  });
});
