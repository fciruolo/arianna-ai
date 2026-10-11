// Finance data never leaves this machine (D-183): source, context mark, gateway, taint, declassify.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertDeclassifiable,
  canUseCloud,
  canUseWebTools,
  contentHash,
  createContext,
  createLabelRules,
  declassify,
  declassifyRequest,
  derive,
  deriveSource,
  gatewayCheck as check,
  isContext,
  isFinanceContext,
  isFinanceSource,
  labelForSource,
  labelOf,
  PolicyError,
  recordFinanceRead,
  recordRead,
  secretMatcher,
  type Context,
  type Decision,
  type DeclassifyApproval,
  type Label,
  type Labeled,
  type Target,
} from '../src/index.ts';

/** The next step of a block, undefined for an allow. */
const nextOf = (decision: Decision): string | undefined => (decision.decision === 'block' ? decision.next : undefined);
const gatewayCheck = (payload: readonly Labeled<unknown>[], context: Context, target: Target) => check(payload, context, target, secretMatcher([]));

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const CODEX: Target = { kind: 'executor', id: 'codex', locality: 'cloud' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };
const TELEGRAM: Target = { kind: 'channel', id: 'telegram' };
const PHONE: Target = { kind: 'channel', id: 'phone' };
const PUSH: Target = { kind: 'channel', id: 'push' };
const WEB_CHAT: Target = { kind: 'channel', id: 'web' };
const VOICE: Target = { kind: 'channel', id: 'voice' };
const WEB_SEARCH: Target = { kind: 'web' };
const LINK: Target = { kind: 'link', consent: 'click' };

const fake = (label: Label, source = 'test', value: unknown = 'fake text'): Labeled<unknown> => ({ value, label, source });
const finance = (label: Label, value: unknown = 'Spesa finta: 12,50 al Bar Esempio'): Labeled<unknown> => fake(label, 'finance:transactions', value);

/** A private context that has read finance data. */
function sealed(): Context {
  const read = recordRead(createContext('L2'), 'L2', 'finance:transactions');
  assert.equal(read.allowed, true);
  return read.context;
}

test('finance source: strings starting with finance:, whatever the case and spaces, are finance data', () => {
  assert.equal(isFinanceSource('finance:transactions'), true);
  assert.equal(isFinanceSource('finance:derived'), true);
  assert.equal(isFinanceSource('Finance:transactions'), true);
  assert.equal(isFinanceSource('FINANCE:tx'), true);
  assert.equal(isFinanceSource(' finance:tx'), true);
  assert.equal(isFinanceSource('kb/finance/notes.md'), false);
  assert.equal(isFinanceSource('finance'), false);
  assert.equal(isFinanceSource('my-finance:tx'), false);
  assert.equal(isFinanceSource(undefined), false);
  assert.equal(isFinanceSource(42), false);
});

test('finance label: a finance value is at least L2, other values keep their label', () => {
  assert.equal(labelOf(finance('L0')), 'L2');
  assert.equal(labelOf(finance('L1')), 'L2');
  assert.equal(labelOf(finance('L3')), 'L3');
  assert.equal(labelOf(fake('L1')), 'L1');
  assert.equal(labelOf({ value: 'x', label: 'bogus' as Label, source: 'test' }), 'L2');
});

test('reading finance data marks the context and reads it as L2', () => {
  const context = sealed();
  assert.equal(isFinanceContext(context), true);
  assert.equal(context.effective, 'L2');
  assert.equal(isContext(context), true);
  const low = recordRead(createContext('L2'), 'L0', 'finance:accounts');
  assert.equal(low.allowed, true);
  assert.equal(low.context.effective, 'L2');
  assert.equal(isFinanceContext(low.context), true);
  const helper = recordFinanceRead(createContext('L2'));
  assert.equal(helper.allowed, true);
  assert.equal(isFinanceContext(helper.context), true);
});

test('an ordinary read does not mark the context: it stays as before', () => {
  const read = recordRead(createContext('L2'), 'L1', 'kb/note.md');
  assert.equal(read.allowed, true);
  assert.equal(isFinanceContext(read.context), false);
  assert.deepEqual({ ...read.context }, { clearance: 'L2', effective: 'L1' });
  assert.deepEqual({ ...recordRead(createContext('L2'), 'L1').context }, { clearance: 'L2', effective: 'L1' });
});

test('a work context (clearance L1) cannot read finance data, whatever its label', () => {
  const work = createContext('L1');
  const read = recordRead(work, 'L0', 'finance:transactions');
  assert.equal(read.allowed, false);
  assert.equal(read.context, work);
  assert.equal(isFinanceContext(read.context), false);
});

test('the finance mark is never lost after other reads', () => {
  let context = sealed();
  for (const label of ['L0', 'L1', 'L2'] as const) {
    const read = recordRead(context, label, 'kb/other.md');
    assert.equal(read.allowed, true);
    context = read.context;
    assert.equal(isFinanceContext(context), true);
  }
  // A denied read leaves the marked context as it was.
  const denied = recordRead(context, 'L3');
  assert.equal(denied.allowed, false);
  assert.equal(isFinanceContext(denied.context), true);
});

test('createContext keeps the mark only with L2, and a forged mark is not a context', () => {
  const marked = createContext('L2', 'L2', { finance: true });
  assert.equal(isFinanceContext(marked), true);
  assert.equal(isFinanceContext(createContext('L2', 'L2')), false);
  assert.equal(isFinanceContext(createContext('L2', 'L2', { finance: false })), false);
  assert.throws(() => createContext('L2', 'L1', { finance: true }), PolicyError);
  assert.throws(() => createContext('L1', 'L1', { finance: true }), PolicyError);
  const forged = { clearance: 'L2', effective: 'L2', finance: true } as Context;
  assert.equal(isContext(forged), false);
  assert.equal(isFinanceContext(forged), false);
});

test('a marked context cannot use the cloud nor web tools, an unmarked one at L1 still can', () => {
  assert.equal(canUseCloud(sealed()), false);
  assert.equal(canUseWebTools(sealed()), false);
  assert.equal(canUseCloud(createContext('L2', 'L1')), true);
  assert.equal(canUseWebTools(createContext('L2', 'L1')), true);
});

test('gateway: a finance fragment, even L1, is blocked towards Claude by the finance rule', () => {
  const decision = gatewayCheck([finance('L1')], createContext('L1'), CLAUDE);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.rule, 'finance');
  assert.equal(nextOf(decision), 'stay-local');
  assert.equal(decision.label, 'L2');
});

test('gateway: a finance fragment L0 is blocked towards every cloud target, before any other rule', () => {
  for (const target of [CLAUDE, CODEX, WEB_SEARCH, LINK, TELEGRAM, PHONE, PUSH]) {
    const decision = gatewayCheck([fake('L0'), finance('L0')], createContext('L1'), target);
    assert.equal(decision.rule, 'finance', `target ${JSON.stringify(target)}`);
    const channel = target.kind === 'channel';
    assert.equal(nextOf(decision), channel ? 'notify-reference' : 'stay-local');
  }
});

test('gateway: a marked context with an L0 fragment is blocked towards Telegram with notify-reference', () => {
  const decision = gatewayCheck([fake('L0')], sealed(), TELEGRAM);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.rule, 'finance');
  assert.equal(nextOf(decision), 'notify-reference');
});

test('gateway: a marked context is blocked towards every cloud target', () => {
  for (const target of [CLAUDE, CODEX, WEB_SEARCH, LINK, PHONE, PUSH]) {
    assert.equal(gatewayCheck([fake('L0', 'test', 'https://example.org/fake')], sealed(), target).rule, 'finance');
  }
});

test('gateway: the finance rule comes before L3 and the scanner, and its reason holds no content', () => {
  const value = 'IBAN finto IT60X0542811101000000123456 con carta 4111 1111 1111 1111';
  const decision = gatewayCheck([finance('L1', value)], createContext('L1'), CLAUDE);
  assert.equal(decision.rule, 'finance');
  assert.equal(decision.reason.includes('IT60'), false);
  assert.equal(decision.reason.includes('4111'), false);
  assert.equal(gatewayCheck([fake('L3')], sealed(), CLAUDE).rule, 'finance');
});

test('gateway: finance data and marked contexts still reach the local model, the web chat and the voice', () => {
  for (const target of [LOCAL_MODEL, WEB_CHAT, VOICE]) {
    const own = gatewayCheck([finance('L1')], sealed(), target);
    assert.equal(own.decision, 'allow', `target ${JSON.stringify(target)}`);
    assert.equal(own.rule, 'local');
    assert.equal(own.label, 'L2');
    assert.equal(gatewayCheck([fake('L0')], sealed(), target).decision, 'allow');
  }
});

test('gateway: L3 stays out of local targets even in a marked context', () => {
  const decision = gatewayCheck([finance('L3')], sealed(), LOCAL_MODEL);
  assert.equal(decision.rule, 'secret');
});

test('gateway: without finance data nor mark, cloud targets work as before', () => {
  const decision = gatewayCheck([fake('L1', 'kb/finance-notes.md')], createContext('L1'), CLAUDE);
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.rule, 'cloud');
  assert.equal(gatewayCheck([fake('L0')], createContext('L1'), TELEGRAM).rule, 'cloud');
  assert.equal(gatewayCheck([fake('L2')], createContext('L2', 'L2'), TELEGRAM).rule, 'contaminated');
});

test('taint: an output that read finance data is finance and at least L2', () => {
  const inputs = [fake('L0'), finance('L0')];
  assert.equal(deriveSource(inputs, 'model:omlx'), 'finance:derived');
  assert.equal(derive(inputs), 'L2');
  const output: Labeled<unknown> = { value: 'Riassunto finto', label: derive(inputs), source: deriveSource(inputs, 'model:omlx') };
  assert.equal(gatewayCheck([output], createContext('L1'), CLAUDE).rule, 'finance');
  // An output of an output keeps the mark.
  assert.equal(deriveSource([output, fake('L0')], 'model:omlx'), 'finance:derived');
});

test('taint: an output with no finance input keeps its own source and label', () => {
  const inputs = [fake('L0'), fake('L1')];
  assert.equal(deriveSource(inputs, 'model:omlx'), 'model:omlx');
  assert.equal(derive(inputs), 'L1');
});

const approvalFor = (item: Labeled<unknown>, from: Label, to: Label): DeclassifyApproval => ({
  id: 'appr-fake-1',
  kind: 'declassify',
  state: 'approved',
  detail: { sha256: contentHash(item.value), from, to },
});

test('declassify: finance data is refused, even with an approval for its exact text', () => {
  const item = finance('L2');
  const clear = createContext('L2', 'L2');
  assert.throws(() => declassifyRequest(item, 'L1', clear), PolicyError);
  assert.throws(() => declassify(item, 'L1', approvalFor(item, 'L2', 'L1'), clear), PolicyError);
  const derived: Labeled<unknown> = { value: 'Riassunto finto', label: 'L2', source: 'finance:derived' };
  assert.throws(() => declassify(derived, 'L1', approvalFor(derived, 'L2', 'L1'), clear), PolicyError);
  const spelled: Labeled<unknown> = { value: 'Riassunto finto', label: 'L2', source: ' FINANCE:tx' };
  assert.throws(() => declassifyRequest(spelled, 'L1', clear), PolicyError);
});

test('declassify: in a marked context it is refused, in an unmarked one it works as before', () => {
  const item = fake('L2');
  assert.throws(() => {
    assertDeclassifiable(sealed());
  }, PolicyError);
  assert.throws(() => declassifyRequest(item, 'L1', sealed()), PolicyError);
  assert.throws(() => declassify(item, 'L1', approvalFor(item, 'L2', 'L1'), sealed()), PolicyError);
  const clear = createContext('L2', 'L2');
  assert.doesNotThrow(() => {
    assertDeclassifiable(clear);
  });
  assert.equal(declassifyRequest(item, 'L1', clear).to, 'L1');
  assert.equal(declassify(item, 'L1', approvalFor(item, 'L2', 'L1'), clear).item.label, 'L1');
});

test('declassify: a context not made by the policy is refused, even one claiming no finance mark', () => {
  const item = fake('L2');
  for (const forged of [
    { clearance: 'L2', effective: 'L2', finance: true },
    { clearance: 'L2', effective: 'L2' },
  ] as Context[]) {
    assert.throws(() => {
      assertDeclassifiable(forged);
    }, /not created by the policy/);
    assert.throws(() => declassifyRequest(item, 'L1', forged), PolicyError);
    assert.throws(() => declassify(item, 'L1', approvalFor(item, 'L2', 'L1'), forged), PolicyError);
  }
});

const SPELLING_TARGETS: readonly Target[] = [WEB_SEARCH, CLAUDE];

test('gateway: another spelling of a finance source is still finance data', () => {
  for (const source of ['FINANCE:tx', ' finance:tx']) {
    for (const target of SPELLING_TARGETS) {
      assert.equal(gatewayCheck([fake('L0', source)], createContext('L1'), target).rule, 'finance', `${source} to ${JSON.stringify(target)}`);
    }
  }
});

test('gateway: a source that is not a string is not finance data; a marked context still blocks it', () => {
  const odd = { value: 'fake text', label: 'L0', source: 42 } as unknown as Labeled<unknown>;
  assert.equal(gatewayCheck([odd], createContext('L1'), CLAUDE).rule, 'cloud');
  assert.equal(labelOf(odd), 'L0');
  const missing = { value: 'fake text', label: 'L1' } as unknown as Labeled<unknown>;
  assert.equal(gatewayCheck([missing], sealed(), CLAUDE).rule, 'finance');
});

test('label rules: a finance source rule below L2 is refused, at L2 or above it is accepted', () => {
  assert.throws(() => createLabelRules({ folders: [], sources: [{ name: 'finance:transactions', label: 'L1' }] }), /finance data/);
  assert.throws(() => createLabelRules({ folders: [], sources: [{ name: 'FINANCE:tx', label: 'L0' }] }), /finance data/);
  const rules = createLabelRules({ folders: [], sources: [{ name: 'finance:transactions', label: 'L2' }, { name: 'web', label: 'L1' }] });
  assert.equal(labelForSource(rules, 'finance:transactions'), 'L2');
  assert.equal(labelForSource(rules, 'web'), 'L1');
});

test('label rules: a finance source is at least L2 even without a rule, other sources keep theirs', () => {
  const rules = createLabelRules({ folders: [], sources: [{ name: 'web', label: 'L0' }] });
  assert.equal(labelForSource(rules, 'finance:accounts'), 'L2');
  assert.equal(labelForSource(rules, 'web'), 'L0');
  assert.equal(labelForSource(createLabelRules({ folders: [], sources: [{ name: 'finance:vault', label: 'L3' }] }), 'finance:vault'), 'L3');
});
