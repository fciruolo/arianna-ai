import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isContext } from '@arianna/policy';

import { contextOf } from '../src/context-input.ts';
import { evaluateGateway } from '../src/gateway.ts';
import { evaluateRouter } from '../src/router.ts';

describe('contextOf', () => {
  it('applies reads in order: allowed ones contaminate, denied ones are counted and change nothing', () => {
    const privateRun = contextOf({ clearance: 'L2', reads: ['L1', 'L2'] });
    assert.deepEqual({ ...privateRun.context }, { clearance: 'L2', effective: 'L2' });
    assert.equal(privateRun.deniedReads, 0);
    assert.ok(isContext(privateRun.context));
    const workRun = contextOf({ clearance: 'L1', reads: ['L1', 'L2', 'L3'] });
    assert.deepEqual({ ...workRun.context }, { clearance: 'L1', effective: 'L1' });
    assert.equal(workRun.deniedReads, 2);
  });

  it('rejects unknown keys, reads that are not labels and reads on a forged context', () => {
    assert.throws(() => contextOf({ clearance: 'L1', read: ['L2'] }), /unknown context key/);
    assert.throws(() => contextOf({ clearance: 'L1', reads: ['l2'] }), /not a label/);
    assert.throws(() => contextOf({ clearance: 'L1', reads: [null] }), /not a label/);
    assert.throws(() => contextOf({ clearance: 'L1', reads: 'L2' }), /must be a list/);
    assert.throws(() => contextOf({ clearance: 'L1', forged: true, reads: ['L1'] }), /forged/);
    assert.throws(() => contextOf(null), /must be an object/);
  });

  it('a forged context is not a policy context', () => {
    assert.equal(isContext(contextOf({ clearance: 'L1', forged: true }).context), false);
  });
});

describe('deniedReads in the outcomes', () => {
  const target = { kind: 'executor', id: 'claude', locality: 'cloud' };
  const payload = [{ value: 'fake text', label: 'L1' }];

  it('the gateway reports denied reads only when there are some', () => {
    assert.deepEqual(evaluateGateway({ payload, target, context: { clearance: 'L1', reads: ['L2'] } }), { decision: 'allow', rule: 'cloud', deniedReads: 1 });
    assert.deepEqual(evaluateGateway({ payload, target, context: { clearance: 'L1', reads: ['L1'] } }), { decision: 'allow', rule: 'cloud' });
  });

  it('the router reports them too, and refuses a malformed context', () => {
    const step = { kind: 'coding', agent: 'coder' };
    assert.equal(evaluateRouter({ step, context: { clearance: 'L1', reads: ['L2'] } }).deniedReads, 1);
    assert.equal(evaluateRouter({ step, context: { clearance: 'L2', reads: ['L2'] } }).deniedReads, undefined);
    assert.throws(() => evaluateRouter({ step, context: { clearance: 'L1', forged: true, reads: ['L1'] } }), /forged/);
    assert.throws(() => evaluateRouter({ step, context: { clearance: 'L1', efective: 'L0' } }), /unknown context key/);
  });
});
