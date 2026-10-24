// What the core reads from the folders of the Mac (D-314, I-22) is Private whatever label it was given:
// the source `mac:*` raises it to L2, so that no cloud target receives it and no declassification lowers it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createContext,
  declassifyRequest,
  derive,
  fakePiiCheck,
  gatewayCheck as check,
  isMacSource,
  labelOf,
  MAC_LABEL,
  PolicyError,
  secretMatcher,
  type Context,
  type Label,
  type Labeled,
  type Target,
} from '../src/index.ts';

const gatewayCheck = (payload: readonly Labeled<unknown>[], context: Context, target: Target) => check(payload, context, target, secretMatcher([]), fakePiiCheck(payload));
const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const CODEX: Target = { kind: 'executor', id: 'codex', locality: 'cloud' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };
const PUSH: Target = { kind: 'channel', id: 'push' };
const WEB_CHAT: Target = { kind: 'channel', id: 'web' };
const WEB_SEARCH: Target = { kind: 'web' };
const LINK: Target = { kind: 'link', consent: 'click' };

const mac = (label: Label, value: unknown = 'lista-spesa-finta.txt\npreventivo-finto.pdf'): Labeled<unknown> => ({ value, label, source: 'mac:turn:task-finto:2' });

test('mac source: strings starting with mac:, whatever the case and spaces, are files of the Mac', () => {
  assert.equal(isMacSource('mac:turn:t:1'), true);
  assert.equal(isMacSource(' MAC:list'), true);
  assert.equal(isMacSource('kb/mac/notes.md'), false);
  assert.equal(isMacSource('macchina:1'), false);
  assert.equal(isMacSource('turn:t:1'), false);
  assert.equal(isMacSource(undefined), false);
  assert.equal(isMacSource(7), false);
});

test('mac label: a value read from the Mac is at least L2, whatever label it was given; other values keep theirs', () => {
  assert.equal(MAC_LABEL, 'L2');
  assert.equal(labelOf(mac('L0')), 'L2');
  assert.equal(labelOf(mac('L1')), 'L2');
  assert.equal(labelOf(mac('L3')), 'L3');
  assert.equal(labelOf({ value: 'x', label: 'L1', source: 'turn:t:1' }), 'L1');
  assert.equal(derive([{ value: 'x', label: 'L0', source: 'eval' }, mac('L0')]), 'L2');
});

test('gateway: a file of the Mac, even labeled L0 or L1 by mistake, never reaches a cloud target', () => {
  for (const target of [CLAUDE, CODEX, PUSH, WEB_SEARCH, LINK]) {
    for (const label of ['L0', 'L1'] as const) {
      const decision = gatewayCheck([{ value: 'fake text', label: 'L0', source: 'eval' }, mac(label)], createContext('L1'), target);
      assert.equal(decision.decision, 'block', `${target.kind} ${label}`);
    }
  }
});

test('gateway: a file of the Mac reaches the local model and the web chat of a private conversation', () => {
  for (const target of [LOCAL_MODEL, WEB_CHAT]) {
    const decision = gatewayCheck([mac('L2')], createContext('L2', 'L2'), target);
    assert.equal(decision.decision, 'allow', target.kind);
  }
});

test('declassify: what is read from the Mac is refused; the same text from another source may be asked', () => {
  assert.throws(() => declassifyRequest(mac('L2'), 'L1', createContext('L2', 'L2')), PolicyError);
  const other = declassifyRequest({ value: 'lista-spesa-finta.txt', label: 'L2', source: 'message:1' }, 'L1', createContext('L2', 'L2'));
  assert.equal(other.to, 'L1');
});
