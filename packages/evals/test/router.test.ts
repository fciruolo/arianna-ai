import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';

import { loadCases } from '../src/cases.ts';
import { evaluateRouter, matchesRouterExpectation } from '../src/router.ts';

describe('matchesRouterExpectation', () => {
  const actual = { decision: 'route', executor: 'claude', model: 'sonnet', locality: 'cloud' };

  it('checks only the listed fields', () => {
    assert.equal(matchesRouterExpectation(actual, { model: 'sonnet' }), true);
    assert.equal(matchesRouterExpectation(actual, { locality: 'local' }), false);
    assert.equal(matchesRouterExpectation(actual, { decision: 'route', model: 'opus' }), false);
  });

  it('null means absent', () => {
    assert.equal(matchesRouterExpectation(actual, { approval: null }), true);
    assert.equal(matchesRouterExpectation({ ...actual, approval: 'budget' }, { approval: null }), false);
    assert.equal(matchesRouterExpectation(actual, { approval: 'budget' }), false);
  });

  it('rejects non-objects', () => {
    assert.equal(matchesRouterExpectation(undefined, {}), false);
    assert.equal(matchesRouterExpectation(actual, null), false);
  });
});

describe('router cases', () => {
  it('every privacy case pins the decision, not just its absence of errors', () => {
    const cases = loadCases(join(resolveHome(), 'evals', 'router')).filter((item) => item.tags.includes('privacy'));
    assert.ok(cases.length >= 10);
    for (const item of cases) assert.ok('decision' in (item.expect as object), item.id);
  });

  it('a forged context that claims L0 never reaches the cloud', () => {
    const outcome = evaluateRouter({ step: { kind: 'coding', agent: 'coder' }, context: { clearance: 'L1', effective: 'L0', forged: true } });
    assert.equal(outcome.locality, 'local');
  });
});

describe('evaluateRouter: context reads', () => {
  const step = { kind: 'coding', agent: 'coder' };

  it('an allowed L2 read contaminates the run, which stays local', () => {
    const actual = evaluateRouter({ step, context: { clearance: 'L2', reads: ['L2'] } });
    assert.equal(actual.locality, 'local');
  });

  it('a read above the clearance is denied and does not contaminate', () => {
    const actual = evaluateRouter({ step, context: { clearance: 'L1', reads: ['L2'] } });
    assert.equal(actual.locality, 'cloud');
  });
});
