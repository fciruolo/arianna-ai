import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateDifficulty, HARD_FILES } from '../src/index.ts';

test('without signals the card default stands', () => {
  assert.deepEqual(estimateDifficulty({ base: 'normal' }), { difficulty: 'normal', rules: [] });
  assert.deepEqual(estimateDifficulty({ base: 'hard', text: 'aggiungi un endpoint' }), { difficulty: 'hard', rules: [] });
});

test('a trivial keyword lowers normal to trivial', () => {
  assert.deepEqual(estimateDifficulty({ base: 'normal', text: 'Correggi un refuso nel README', files: 1 }), {
    difficulty: 'trivial',
    rules: ['trivial-keyword'],
  });
});

test('a trivial keyword does not lower with many files, a hard keyword, or a hard default', () => {
  assert.equal(estimateDifficulty({ base: 'normal', text: 'rename', files: 2 }).difficulty, 'normal');
  assert.equal(estimateDifficulty({ base: 'normal', text: 'rename for the migration' }).difficulty, 'hard');
  assert.equal(estimateDifficulty({ base: 'hard', text: 'typo' }).difficulty, 'hard');
});

test('keywords match whole words only', () => {
  assert.equal(estimateDifficulty({ base: 'normal', text: 'typography' }).difficulty, 'normal');
  assert.equal(estimateDifficulty({ base: 'normal', text: 'securityless' }).difficulty, 'normal');
});

test('a hard keyword raises to hard', () => {
  assert.deepEqual(estimateDifficulty({ base: 'normal', text: 'Rivedi l’architettura della coda' }), {
    difficulty: 'hard',
    rules: ['hard-keyword'],
  });
  assert.equal(estimateDifficulty({ base: 'trivial', text: 'SECURITY fix' }).difficulty, 'hard');
});

test('many files raise to hard, fewer do not', () => {
  assert.deepEqual(estimateDifficulty({ base: 'normal', files: HARD_FILES }), { difficulty: 'hard', rules: ['many-files'] });
  assert.equal(estimateDifficulty({ base: 'normal', files: HARD_FILES - 1 }).difficulty, 'normal');
});

test('each failed attempt raises one level, up to critical', () => {
  assert.equal(estimateDifficulty({ base: 'normal', failedAttempts: 1 }).difficulty, 'hard');
  assert.equal(estimateDifficulty({ base: 'normal', failedAttempts: 2 }).difficulty, 'critical');
  assert.equal(estimateDifficulty({ base: 'normal', failedAttempts: 9 }).difficulty, 'critical');
  assert.deepEqual(estimateDifficulty({ base: 'critical', failedAttempts: 1 }), { difficulty: 'critical', rules: [] });
  assert.equal(estimateDifficulty({ base: 'normal', failedAttempts: 0 }).difficulty, 'normal');
});

test('bad signals are rejected', () => {
  assert.throws(() => estimateDifficulty({ base: 'easy' as 'normal' }), /difficulty/);
  assert.throws(() => estimateDifficulty({ base: 'normal', files: -1 }), /files/);
  assert.throws(() => estimateDifficulty({ base: 'normal', failedAttempts: 1.5 }), /failedAttempts/);
});
