import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABEL_CLASS, LABEL_LEGEND, LABEL_RULE, LABEL_TEXT, MODE_HINT } from '../src/lib/labels.ts';

test('the labels speak (D-129): the words of the SPEC, never the codes, in order, each with its colour', () => {
  assert.deepEqual(LABEL_TEXT, { L0: 'Pubblico', L1: 'Interno', L2: 'Privato', L3: 'Segreto' });
  assert.deepEqual(Object.values(LABEL_CLASS), ['text-l0', 'text-l1', 'text-l2', 'text-l3']);
  assert.deepEqual(LABEL_LEGEND.map((entry) => entry.label), ['L0', 'L1', 'L2', 'L3']);
  const shown = [...LABEL_LEGEND.flatMap((entry) => [entry.meaning, entry.example, entry.goes]), LABEL_RULE, ...Object.values(MODE_HINT)];
  for (const text of shown) {
    assert.ok(text.length > 10, text);
    assert.doesNotMatch(text, /\bL[0-3]\b/, text);
  }
  // What the legend promises matches the rules: Segreto never goes out, Privato only with the user's approval.
  assert.match(LABEL_LEGEND[3]?.goes ?? '', /Non esce mai/);
  assert.match(LABEL_LEGEND[2]?.goes ?? '', /approvi tu/);
});

test('the texts built from a label say its word (D-129): declassification, a saved note, unknown codes as they are', async () => {
  const { declassifyLabels, labelWord } = await import('../src/lib/labels.ts');
  const { savedText } = await import('../src/lib/capture.ts');
  assert.equal(declassifyLabels({ from: 'L2', to: 'L1' }), 'Privato → Interno');
  assert.equal(declassifyLabels({ from: 'L2' }), undefined);
  assert.doesNotMatch(savedText({ path: 'kb/inbox/a.md', label: 'L2' }), /\bL[0-3]\b/);
  assert.equal(labelWord('L3'), 'Segreto');
  assert.equal(labelWord('A1'), 'A1');
});

test('the legend does not promise less or more than the SPEC: Interno reaches the external channels, Pubblico everything', () => {
  assert.match(LABEL_LEGEND[1]?.goes ?? '', /Telegram/);
  assert.match(LABEL_LEGEND[1]?.goes ?? '', /progetti approvati/);
  assert.match(LABEL_LEGEND[0]?.goes ?? '', /ovunque/);
  assert.doesNotMatch(LABEL_LEGEND[2]?.goes ?? '', /cloud|Telegram/);
});
