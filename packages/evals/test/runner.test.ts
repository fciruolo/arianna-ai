import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatReport, runGroup, runTier, type EvalCase, type EvalGroup } from '../src/index.ts';

function makeCase(id: string, input: unknown, expect: unknown, tags: string[] = []): EvalCase {
  return { id, input, expect, tags };
}

// Subject under evaluation: doubles a number, throws on anything else.
function double(input: unknown): number {
  if (typeof input !== 'number') throw new Error('not a number');
  return input * 2;
}

function makeGroup(overrides: Partial<EvalGroup> = {}): EvalGroup {
  return {
    name: 'doubling',
    tier: 'deterministic',
    threshold: 1,
    strictTags: [],
    subject: { status: 'active', evaluate: double },
    ...overrides,
  };
}

test('a group passes when every case matches', async () => {
  const report = await runGroup(makeGroup(), [makeCase('a', 1, 2), makeCase('b', 2, 4)]);
  assert.equal(report.status, 'passed');
});

test('a group fails below its threshold and passes at it', async () => {
  const cases = [makeCase('a', 1, 2), makeCase('b', 2, 4), makeCase('c', 3, 6), makeCase('d', 4, 0)];
  const strict = await runGroup(makeGroup({ threshold: 0.8 }), cases);
  assert.equal(strict.status, 'failed');
  const lenient = await runGroup(makeGroup({ threshold: 0.75 }), cases);
  assert.equal(lenient.status, 'passed');
});

test('a failed case with a strict tag fails the group even above the threshold', async () => {
  const cases = [makeCase('a', 1, 2), makeCase('b', 2, 4), makeCase('leak', 3, 0, ['privacy'])];
  const report = await runGroup(makeGroup({ threshold: 0.5, strictTags: ['privacy'] }), cases);
  assert.equal(report.status, 'failed');
  const tolerant = await runGroup(makeGroup({ threshold: 0.5, strictTags: ['other'] }), cases);
  assert.equal(tolerant.status, 'passed');
});

test('an active group without cases fails instead of passing by default', async () => {
  const report = await runGroup(makeGroup(), []);
  assert.equal(report.status, 'failed');
});

test('an evaluator that throws fails the case, not the run', async () => {
  const report = await runGroup(makeGroup(), [makeCase('bad-input', 'x', 2)]);
  assert.equal(report.status, 'failed');
  assert.equal(report.results[0]?.error, 'not a number');
});

test('values are compared deeply and strictly', async () => {
  const group = makeGroup({ subject: { status: 'active', evaluate: () => ({ locality: 'local' }) } });
  assert.equal((await runGroup(group, [makeCase('a', 0, { locality: 'local' })])).status, 'passed');
  assert.equal((await runGroup(group, [makeCase('a', 0, { locality: 'cloud' })])).status, 'failed');
});

test('a pending group is reported and never counted as passed', async () => {
  const pending = makeGroup({ name: 'later', subject: { status: 'pending', until: 'task 9.9' } });
  const report = await runGroup(pending, [makeCase('a', 1, 2)]);
  assert.deepEqual(report, { name: 'later', status: 'pending', until: 'task 9.9', cases: 1 });
});

test('a tier runs only its own groups and fails if one of them fails', async () => {
  const groups = [
    makeGroup({ name: 'good' }),
    makeGroup({ name: 'bad' }),
    makeGroup({ name: 'other-tier', tier: 'live' }),
  ];
  const cases: Record<string, EvalCase[]> = {
    good: [makeCase('a', 1, 2)],
    bad: [makeCase('b', 1, 3)],
  };
  const report = await runTier('deterministic', groups, (name) => cases[name] ?? []);
  assert.deepEqual(
    report.groups.map((group) => [group.name, group.status]),
    [
      ['good', 'passed'],
      ['bad', 'failed'],
    ],
  );
  assert.equal(report.ok, false);

  const text = formatReport(report);
  assert.match(text, /bad\s+FAIL/);
  assert.match(text, /failed: b \(got 2\)/);
  assert.match(text, /Result: FAILED/);
});

test('a tier with only passed and pending groups is ok', async () => {
  const groups = [makeGroup(), makeGroup({ name: 'later', subject: { status: 'pending', until: 'task 9.9' } })];
  const report = await runTier('deterministic', groups, () => [makeCase('a', 1, 2)]);
  assert.equal(report.ok, true);
  assert.match(formatReport(report), /later\s+PENDING\s+waits for task 9\.9/);
});
