import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fingerprint, normalizeDescription, OccurrenceCounter } from '../src/index.ts';

test('descriptions are normalized: case, accents, punctuation, spaces', () => {
  assert.equal(normalizeDescription('  Caffè   DEL Corso, n.3 '), 'caffe del corso n 3');
});

test('long reference numbers are masked, short numbers stay', () => {
  assert.equal(normalizeDescription('BONIFICO TRN 1234567890123 Ditta Finta'), 'bonifico trn # ditta finta');
  assert.equal(normalizeDescription('POS CARTA 1234 02/01'), 'pos carta 1234 02 01');
});

test('the fingerprint is a stable sha256 of the tuple', () => {
  const a = fingerprint('conto-1', '2026-01-02', -150, 'Bar Fittizio', 1);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, fingerprint('conto-1', '2026-01-02', -150, 'BAR  fittizio', 1));
});

test('any change of account, day, amount, description or occurrence changes it', () => {
  const base = fingerprint('conto-1', '2026-01-02', -150, 'Bar Fittizio', 1);
  assert.notEqual(base, fingerprint('conto-2', '2026-01-02', -150, 'Bar Fittizio', 1));
  assert.notEqual(base, fingerprint('conto-1', '2026-01-03', -150, 'Bar Fittizio', 1));
  assert.notEqual(base, fingerprint('conto-1', '2026-01-02', -151, 'Bar Fittizio', 1));
  assert.notEqual(base, fingerprint('conto-1', '2026-01-02', -150, 'Bar Inventato', 1));
  assert.notEqual(base, fingerprint('conto-1', '2026-01-02', -150, 'Bar Fittizio', 2));
});

test('two identical coffees on the same day get two fingerprints', () => {
  const counter = new OccurrenceCounter();
  const first = counter.next('conto-1', '2026-01-02', -120, 'Bar Fittizio');
  const second = counter.next('conto-1', '2026-01-02', -120, 'Bar Fittizio');
  assert.notEqual(first, second);
  const again = new OccurrenceCounter();
  assert.equal(again.next('conto-1', '2026-01-02', -120, 'Bar Fittizio'), first);
  assert.equal(again.next('conto-1', '2026-01-02', -120, 'Bar Fittizio'), second);
});
