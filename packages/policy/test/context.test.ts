import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canRead,
  canUseCloud,
  canUseWebTools,
  clearanceFor,
  createContext,
  derive,
  isContext,
  labelForUserMessage,
  PolicyError,
  recordRead,
  recordUserMessage,
  type Label,
} from '../src/index.ts';

const notALabel = (value: unknown): Label => value as Label;
const input = (label: unknown) => ({ value: 'fake', label: label as Label, source: 'test' });

test('taint: an output takes the highest label among its inputs', () => {
  assert.equal(derive([input('L0'), input('L1')]), 'L1');
  assert.equal(derive([input('L1'), input('L2'), input('L0')]), 'L2');
  assert.equal(derive([input('L0')]), 'L0');
});

test('taint: an input without a valid label counts as L2', () => {
  assert.equal(derive([input('L0'), input(undefined)]), 'L2');
  assert.equal(derive([input('L1'), input('l1')]), 'L2');
});

test('taint: an output with no known inputs is L2, not L0', () => {
  assert.equal(derive([]), 'L2');
});

test('work conversations are cleared up to L1, private ones up to L2', () => {
  assert.equal(clearanceFor('work'), 'L1');
  assert.equal(clearanceFor('private'), 'L2');
});

test('a user message takes the clearance of its conversation', () => {
  assert.equal(labelForUserMessage(createContext('L1')), 'L1');
  assert.equal(labelForUserMessage(createContext('L2')), 'L2');
});

test('a new context has read nothing yet', () => {
  assert.deepEqual(createContext('L2'), { clearance: 'L2', effective: 'L0' });
  assert.deepEqual(createContext('L1', 'L1'), { clearance: 'L1', effective: 'L1' });
});

test('no context is ever cleared for L3, nor has read above its clearance', () => {
  assert.throws(() => createContext('L3'), PolicyError);
  assert.throws(() => createContext('L1', 'L2'), PolicyError);
  assert.throws(() => createContext(notALabel('L9')), TypeError);
});

test('clearance: reading up to the ceiling is allowed, above it is not, L3 never', () => {
  const work = createContext('L1');
  assert.equal(canRead(work, 'L0'), true);
  assert.equal(canRead(work, 'L1'), true);
  assert.equal(canRead(work, 'L2'), false);
  const personal = createContext('L2');
  assert.equal(canRead(personal, 'L2'), true);
  assert.equal(canRead(personal, 'L3'), false);
});

test('contamination: a read raises the effective label of the context', () => {
  const result = recordRead(createContext('L2'), 'L2');
  assert.equal(result.allowed, true);
  assert.deepEqual(result.context, { clearance: 'L2', effective: 'L2' });
});

test('contamination: the effective label never goes down', () => {
  const contaminated = createContext('L2', 'L2');
  const result = recordRead(contaminated, 'L0');
  assert.equal(result.allowed, true);
  assert.equal(result.context.effective, 'L2');
});

test('a read above the clearance is denied and does not contaminate', () => {
  const work = createContext('L1', 'L1');
  const result = recordRead(work, 'L2');
  assert.equal(result.allowed, false);
  assert.equal(result.context, work);
  assert.equal(result.context.effective, 'L1');
  assert.match(result.reason, /clearance/);
});

test('a read of L3 is denied even in a private conversation', () => {
  const result = recordRead(createContext('L2'), 'L3');
  assert.equal(result.allowed, false);
  assert.equal(result.context.effective, 'L0');
});

test('a read of an unlabeled value is a read of L2', () => {
  const denied = recordRead(createContext('L1'), notALabel(undefined));
  assert.equal(denied.allowed, false);
  const allowed = recordRead(createContext('L2'), notALabel('l0'));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.context.effective, 'L2');
});

test('a context that has read only L0 and L1 may use cloud executors and web tools', () => {
  const context = createContext('L2', 'L1');
  assert.equal(canUseCloud(context), true);
  assert.equal(canUseWebTools(context), true);
});

test('a contaminated context stays local: no cloud executors, no web tools', () => {
  const after = recordRead(createContext('L2'), 'L2').context;
  assert.equal(canUseCloud(after), false);
  assert.equal(canUseWebTools(after), false);
});

test('a user message is a read: a private conversation that received one stays local', () => {
  const work = recordUserMessage(createContext('L1'));
  assert.deepEqual(work, { clearance: 'L1', effective: 'L1' });
  assert.equal(canUseCloud(work), true);

  const personal = recordUserMessage(createContext('L2'));
  assert.deepEqual(personal, { clearance: 'L2', effective: 'L2' });
  assert.equal(canUseCloud(personal), false);
});

test('only contexts made by the policy are recognized, not look-alike objects', () => {
  const context = createContext('L1');
  assert.equal(isContext(context), true);
  assert.equal(isContext(recordRead(context, 'L1').context), true);
  assert.equal(isContext({ clearance: 'L1', effective: 'L0' }), false);
  assert.equal(isContext(JSON.parse(JSON.stringify(context))), false);
  assert.equal(isContext(null), false);
});
