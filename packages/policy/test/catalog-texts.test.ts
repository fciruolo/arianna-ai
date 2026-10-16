import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  createContext,
  fakePiiCheck,
  forgetCatalogTexts,
  gatewayCheck,
  isCatalogFragment,
  markCatalogText,
  MAX_CATALOG_TEXTS,
  piiExemptions,
  piiReport,
  piiScanTexts,
  secretMatcher,
  type Labeled,
  type PiiEntity,
  type Target,
} from '../src/index.ts';

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };

// An invented style in the form of the catalog of Open Design (D-160): «xAI» is what Rizzo-PII took for a person.
const STYLE = [
  'Skills chosen by the user for this agent: third-party reference text (public, untrusted).',
  '----- BEGIN STYLE x-ai [0123456789abcdef] -----',
  'Source: Open Design (https://github.com/nexu-io/open-design), commit 0000000000000000000000000000000000000000, file design-systems/x-ai/DESIGN.md.',
  '# Design System Inspired by xAI',
  'Invented palette: black and white, a grotesque type.',
  '----- END STYLE x-ai [0123456789abcdef] -----',
].join('\n');

/** The fake recognizer: every occurrence of `names` in a text is a FULLNAME, as Rizzo-PII read «xAI». */
function persons(texts: readonly string[], names: readonly string[]): PiiEntity[][] {
  return texts.map((text) =>
    names.flatMap((name) => [...text.matchAll(new RegExp(name, 'g'))].map((match) => ({ kind: 'FULLNAME', start: match.index, end: match.index + name.length, score: 0.97 }))),
  );
}

const check = (payload: Labeled<unknown>[]) =>
  gatewayCheck(payload, createContext('L1'), CLAUDE, secretMatcher([]), fakePiiCheck(payload, persons(payload.map((item) => String(item.value)), ['xAI', 'Mario Bianchi'])));

afterEach(() => {
  forgetCatalogTexts();
});

test('a marked catalog text in its own fragment is not read by the second scanner (D-250)', () => {
  markCatalogText('skills:designer', STYLE);
  const payload: Labeled<unknown>[] = [
    { value: 'Fai un\'altra versione della pagina', label: 'L1', source: 'task:x' },
    { value: STYLE, label: 'L0', source: 'skills:designer' },
  ];
  const decision = check(payload);
  assert.ok(decision.decision === 'allow', decision.reason);
  assert.equal(decision.reason, 'L1 to a cloud target, scan clean, 1 catalog text not read by the second check');
  assert.deepEqual(decision.texts, ['Fai un\'altra versione della pagina', STYLE], 'the style leaves whole');
});

test('without the mark the same style is read and blocked, as before D-250', () => {
  const decision = check([{ value: STYLE, label: 'L0', source: 'skills:designer' }]);
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
});

test('a catalog text changed by one character is read again', () => {
  markCatalogText('skills:designer', STYLE);
  const changed = `${STYLE} `;
  assert.equal(isCatalogFragment({ value: changed, label: 'L0', source: 'skills:designer' }), false);
  const decision = check([{ value: changed, label: 'L0', source: 'skills:designer' }]);
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
});

test('the same text in a fragment of another source, or of another label, is read', () => {
  markCatalogText('skills:designer', STYLE);
  for (const fragment of [
    { value: STYLE, label: 'L0', source: 'task:x' },
    { value: STYLE, label: 'L0', source: 'skills:coder' },
    { value: STYLE, label: 'L0', source: 'project-rules:negozio-finto' },
    { value: STYLE, label: 'L1', source: 'skills:designer' },
  ] as Labeled<unknown>[]) {
    assert.equal(isCatalogFragment(fragment), false, fragment.source);
    const decision = check([fragment]);
    assert.ok(decision.decision === 'block', fragment.source);
    assert.equal(decision.rule, 'pii');
  }
});

test('a person in the brief still blocks in the same payload as an exempt style', () => {
  markCatalogText('skills:designer', STYLE);
  const decision = check([
    { value: 'Rifai la pagina per Mario Bianchi', label: 'L1', source: 'task:x' },
    { value: STYLE, label: 'L0', source: 'skills:designer' },
  ]);
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
  assert.deepEqual(decision.pii, [{ kind: 'FULLNAME', fragment: 0 }], 'only the brief');
});

test('every other rule still reads an exempt fragment: the scanner and the vault', () => {
  const withIban = `${STYLE}\nIT60X0542811101000000123456`;
  markCatalogText('skills:designer', withIban);
  const scanned = check([{ value: withIban, label: 'L0', source: 'skills:designer' }]);
  assert.ok(scanned.decision === 'block');
  assert.equal(scanned.rule, 'scanner');

  const withSecret = `${STYLE}\nfinto-segreto-del-vault-1234`;
  markCatalogText('skills:designer', withSecret);
  const payload: Labeled<unknown>[] = [{ value: withSecret, label: 'L0', source: 'skills:designer' }];
  const vault = gatewayCheck(payload, createContext('L1'), CLAUDE, secretMatcher([{ ref: 'vault://test/finto', value: 'finto-segreto-del-vault-1234' }]), fakePiiCheck(payload));
  assert.ok(vault.decision === 'block');
  assert.equal(vault.rule, 'secret');
});

test('a check made on the whole text of an exempt fragment does not match: the core sends it empty', () => {
  markCatalogText('skills:designer', STYLE);
  const payload: Labeled<unknown>[] = [{ value: STYLE, label: 'L0', source: 'skills:designer' }];
  // What a core that forgot the exemption would ask: the full text, clean. It is not the check of these texts.
  const decision = gatewayCheck(payload, createContext('L1'), CLAUDE, secretMatcher([]), piiReport([STYLE], [[]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii-unavailable');
  assert.deepEqual(piiScanTexts([STYLE, 'brief'], piiExemptions(payload.concat([{ value: 'brief', label: 'L1', source: 'task:x' }]))), ['', 'brief']);
});

test('only the source of a skills block can be marked, and only a text', () => {
  assert.throws(() => { markCatalogText('task:x', STYLE); }, /not the source of a skills block/);
  assert.throws(() => { markCatalogText('skills:', STYLE); }, /not the source of a skills block/);
  assert.throws(() => { markCatalogText('skills:designer\nx', STYLE); }, /not the source of a skills block/);
  assert.throws(() => { markCatalogText('skills:designer', ''); }, /no text/);
  assert.equal(isCatalogFragment({ value: { text: STYLE }, label: 'L0', source: 'skills:designer' }), false, 'a JSON value is never a catalog text');
  assert.equal(isCatalogFragment(null), false);
});

test('the marks are bounded: the oldest is forgotten first', () => {
  markCatalogText('skills:designer', STYLE);
  for (let index = 0; index < MAX_CATALOG_TEXTS; index += 1) markCatalogText('skills:designer', `skill ${String(index)}`);
  assert.equal(isCatalogFragment({ value: STYLE, label: 'L0', source: 'skills:designer' }), false);
  assert.equal(isCatalogFragment({ value: `skill ${String(MAX_CATALOG_TEXTS - 1)}`, label: 'L0', source: 'skills:designer' }), true);
});
