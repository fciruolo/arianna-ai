import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { errorText, MODEL_EVAL_STATUS_TEXT, modelEvalErrorText } from '../src/lib/italian.ts';
import { anyOpen, canTry, dateText, isOpen, latencyText, promotionHint, scoreText, type ModelEval } from '../src/lib/model-evals.ts';

function trial(overrides: Partial<ModelEval> = {}): ModelEval {
  return {
    id: '1',
    modelId: 'fake-27b',
    role: 'orchestrator',
    weightsSha256: '0123456789abcdef'.repeat(4),
    catalogStatus: 'experimental',
    status: 'passed',
    requestedAt: '2026-10-05T10:00:00.000Z',
    startedAt: '2026-10-05T10:00:01.000Z',
    finishedAt: '2026-10-05T12:03:00.000Z',
    total: 32,
    passed: 31,
    done: 32,
    measures: [],
    latencyMedianMs: 12_300,
    latencyMaxMs: 125_000,
    reasons: [],
    preemptions: 0,
    error: null,
    ...overrides,
  };
}

test('open trials keep the page refreshing; finished ones do not', () => {
  assert.equal(isOpen(trial({ status: 'queued' })), true);
  assert.equal(isOpen(trial({ status: 'running' })), true);
  for (const status of ['passed', 'failed', 'error', 'cancelled'] as const) assert.equal(isOpen(trial({ status })), false);
  assert.equal(anyOpen([trial(), trial({ status: 'running' })]), true);
  assert.equal(anyOpen([trial(), trial({ status: 'cancelled' })]), false);
  assert.equal(anyOpen([]), false);
});

test('score, latency and date read in Italian', () => {
  assert.equal(scoreText(trial()), '31/32');
  assert.equal(scoreText(trial({ status: 'running', done: 5, passed: 4 })), '5/32 casi');
  assert.equal(scoreText(trial({ status: 'queued', total: null, passed: null })), '—');
  assert.equal(scoreText(trial({ status: 'cancelled', passed: null })), '—');
  assert.equal(latencyText(null), '—');
  assert.equal(latencyText(850.4), '850 ms');
  assert.equal(latencyText(12_300), '12,3 s');
  assert.equal(latencyText(125_000), '2 min 5 s');
  assert.equal(dateText('2026-10-05T12:03:00.000Z', 'Europe/Rome'), '05/10/2026 14:03');
  assert.equal(MODEL_EVAL_STATUS_TEXT.failed, 'soglie mancate');
});

test('promotion is only suggested, for an experimental model whose last finished trial passed', () => {
  const hint = promotionHint([trial()], 'fake-27b', 'experimental', 'Europe/Rome');
  assert.equal(hint, 'Soglie superate il 05/10/2026 14:03 (pesi 01234567, secondo il catalogo): la promozione si fa a mano.');
  assert.equal(promotionHint([trial()], 'fake-27b', 'verified'), undefined);
  assert.equal(promotionHint([trial()], 'other-model', 'experimental'), undefined);
  // The last finished trial counts: a later failure takes the hint away, an open trial does not.
  const later = trial({ id: '2', status: 'failed', requestedAt: '2026-10-06T10:00:00.000Z', finishedAt: '2026-10-06T11:00:00.000Z' });
  assert.equal(promotionHint([trial(), later], 'fake-27b', 'experimental'), undefined);
  const open = trial({ id: '3', status: 'running', requestedAt: '2026-10-07T10:00:00.000Z', finishedAt: null });
  assert.ok(promotionHint([trial(), open], 'fake-27b', 'experimental') !== undefined);
  assert.match(promotionHint([trial({ weightsSha256: null })], 'fake-27b', 'experimental') ?? '', /pesi sconosciuti/);
});

test('a model can be tried with its files on disk and no trial open', () => {
  assert.equal(canTry([], { id: 'fake-27b', present: true }), true);
  assert.equal(canTry([], { id: 'fake-27b', present: false }), false);
  assert.equal(canTry([trial({ status: 'queued' })], { id: 'fake-27b', present: true }), false);
  assert.equal(canTry([trial({ status: 'queued' })], { id: 'other', present: true }), true);
  assert.equal(canTry([trial({ status: 'failed' })], { id: 'fake-27b', present: true }), true);
});

test('the codes and refusals of a trial become Italian, unknown ones generic', () => {
  assert.equal(modelEvalErrorText(null), undefined);
  assert.equal(modelEvalErrorText('preempted'), 'annullata: chiamate e task hanno avuto la precedenza troppe volte sullo stesso caso');
  assert.equal(modelEvalErrorText('interrupted'), 'interrotta dal riavvio del nucleo');
  assert.equal(modelEvalErrorText('LocalModelError:timeout'), 'il modello locale non ha risposto');
  assert.equal(modelEvalErrorText('TypeError'), 'errore del nucleo');
  assert.equal(errorText(new ApiError(409, 'a trial of this model is already queued or running')), 'Una prova di questo modello è già in coda o in corso.');
  assert.equal(errorText(new ApiError(409, 'the trial is already passed')), 'Questa prova è già finita.');
  assert.match(errorText(new ApiError(409, 'the files of the model are not in data/models')), /arianna:models pull/);
});
