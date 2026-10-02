import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  contentHash,
  createContext,
  declassify,
  declassifyRequest,
  gatewayCheck,
  PolicyError,
  secretMatcher,
  type DeclassifyApproval,
  type Label,
  type Labeled,
} from '../src/index.ts';

const BRIEF: Labeled<string> = { value: 'Add a retry to the fake invoice parser tests.', label: 'L2', source: 'model:orchestrator' };

const approved = (overrides: Partial<DeclassifyApproval> = {}): DeclassifyApproval => ({
  id: 'approval-1',
  kind: 'declassify',
  state: 'approved',
  detail: declassifyRequest(BRIEF, 'L1'),
  ...overrides,
});

test('the request names the exact text by sha256, with both labels', () => {
  assert.deepEqual(declassifyRequest(BRIEF, 'L1'), { text: BRIEF.value, sha256: contentHash(BRIEF.value), from: 'L2', to: 'L1' });
  assert.match(contentHash(BRIEF.value) ?? '', /^[0-9a-f]{64}$/);
});

test('with an approval for the exact text the label goes down and the change is returned', () => {
  const { item, change } = declassify(BRIEF, 'L1', approved());
  assert.deepEqual(item, { value: BRIEF.value, label: 'L1', source: 'declassified:approval-1' });
  assert.deepEqual(change, { subject: `content:${String(contentHash(BRIEF.value))}`, from: 'L2', to: 'L1', approvalId: 'approval-1' });
  // Only that text leaves, from a fresh run context.
  assert.equal(gatewayCheck([item], createContext('L1'), { kind: 'executor', id: 'claude', locality: 'cloud' }, secretMatcher([])).decision, 'allow');
});

test('without an approved declassify approval nothing changes', () => {
  assert.throws(() => declassify(BRIEF, 'L1', approved({ state: 'pending' })), PolicyError);
  assert.throws(() => declassify(BRIEF, 'L1', approved({ state: 'rejected' })), PolicyError);
  assert.throws(() => declassify(BRIEF, 'L1', approved({ kind: 'action' })), PolicyError);
});

test('an approval covers one text and one change of label only', () => {
  const edited = { ...BRIEF, value: `${BRIEF.value} Also attach the client list.` };
  assert.throws(() => declassify(edited, 'L1', approved()), /different text/);
  assert.throws(() => declassify(BRIEF, 'L0', approved()), /does not cover/);
  assert.throws(() => declassify({ ...BRIEF, label: 'L1' }, 'L0', approved()), /does not cover/);
});

test('labels only go down here, and L3 is never declassified', () => {
  assert.throws(() => declassifyRequest(BRIEF, 'L2'), /not below/);
  assert.throws(() => declassifyRequest({ ...BRIEF, label: 'L1' }, 'L2'), /not below/);
  assert.throws(() => declassifyRequest({ ...BRIEF, label: 'L3' }, 'L1'), /never declassified/);
  assert.throws(() => declassifyRequest(BRIEF, 'L9' as Label), /invalid label/);
});

test('an unlabeled item is L2 and can be declassified like one', () => {
  const unlabeled = { ...BRIEF, label: undefined as unknown as Label };
  assert.equal(declassifyRequest(unlabeled, 'L1').from, 'L2');
});

test('a value without a text form cannot be approved', () => {
  assert.throws(() => declassifyRequest({ value: () => 1, label: 'L2', source: 'test' }, 'L1'), /not text/);
});
