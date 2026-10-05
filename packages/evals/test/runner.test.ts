import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { caseErrorCode, formatReport, runGroup, runTier, type EvalCase, type EvalGroup } from '../src/index.ts';

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

describe('hooks of runGroup (D-081)', () => {
  it('waits before each case and reports each result in order', async () => {
    const log: string[] = [];
    const group = makeGroup({
      subject: {
        status: 'active',
        evaluate: (input) => {
          log.push(`run ${String(input)}`);
          return double(input);
        },
      },
    });
    const report = await runGroup(group, [makeCase('a', 1, 2), makeCase('b', 2, 4)], {
      beforeCase: () => {
        log.push('wait');
        return Promise.resolve();
      },
      onResult: (result, index, total) => log.push(`result ${result.id} ${String(index)}/${String(total)}`),
    });
    assert.equal(report.status, 'passed');
    assert.deepEqual(log, ['wait', 'run 1', 'result a 0/2', 'wait', 'run 2', 'result b 1/2']);
  });

  it('without hooks the evaluator gets no signal', async () => {
    const seen: unknown[] = [];
    const evaluate = (input: unknown, signal?: AbortSignal): number => {
      seen.push(signal);
      return double(input);
    };
    await runGroup(makeGroup({ subject: { status: 'active', evaluate } }), [makeCase('a', 1, 2)]);
    assert.deepEqual(seen, [undefined]);
  });

  it('stops at the signal: the case in progress is aborted and no other case starts', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const group = makeGroup({
      subject: {
        status: 'active',
        evaluate: (input, signal) => {
          started.push(String(input));
          controller.abort(new Error('cancelled by the user'));
          if (signal?.aborted === true) throw new Error('aborted');
          return double(input);
        },
      },
    });
    await assert.rejects(runGroup(group, [makeCase('a', 1, 2), makeCase('b', 2, 4)], { signal: controller.signal }), /cancelled by the user/);
    assert.deepEqual(started, ['1']);
  });

  it('a preempted attempt is dropped and the case runs again after beforeCase', async () => {
    let attempts = 0;
    let waits = 0;
    let stops = 0;
    let current: AbortController | undefined;
    const results: string[] = [];
    const group = makeGroup({
      subject: {
        status: 'active',
        evaluate: (input, signal) => {
          attempts += 1;
          // The first attempt is preempted while it runs.
          if (attempts === 1) {
            current?.abort();
            assert.equal(signal?.aborted, true);
            throw new Error('cancelled');
          }
          return double(input);
        },
      },
    });
    const report = await runGroup(group, [makeCase('a', 1, 2)], {
      beforeCase: () => {
        waits += 1;
        return Promise.resolve();
      },
      watchCase: () => {
        current = new AbortController();
        return {
          signal: current.signal,
          stop: () => {
            stops += 1;
          },
        };
      },
      onResult: (result) => results.push(`${result.id}:${String(result.passed)}`),
    });
    assert.equal(report.status, 'passed');
    assert.equal(attempts, 2);
    assert.equal(waits, 2);
    assert.equal(stops, 2);
    assert.deepEqual(results, ['a:true']);
  });

  it('a failed case carries a short error code', async () => {
    class FakeModelError extends Error {
      override name = 'LocalModelError';
      readonly kind = 'timeout';
    }
    const group = makeGroup({
      subject: {
        status: 'active',
        evaluate: () => {
          throw new FakeModelError('endpoint x echoed a prompt');
        },
      },
    });
    const report = await runGroup(group, [makeCase('a', 1, 2)]);
    assert.equal(report.status, 'failed');
    assert.equal(report.results[0]?.errorCode, 'LocalModelError:timeout');
    assert.equal(caseErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'Error:ECONNREFUSED');
    assert.equal(caseErrorCode(Object.assign(new Error('x'), { code: 'not a code!' })), 'error');
  });
});
