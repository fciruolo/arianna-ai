import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  answerText,
  bestValues,
  measureBars,
  modelLine,
  modelRows,
  pillsOf,
  relativeWidths,
  sameQuestions,
  secondsText,
  selectedTrials,
  toggleSelected,
  tpsText,
  trialNote,
  verdict,
  type Comparison,
  type ComparisonTrial,
} from '../src/lib/model-compare.ts';

// «Confronto dei modelli» (D-199): invented models and numbers.

const NOW = 'a'.repeat(64);
const OLD = 'b'.repeat(64);

/** The five measures of a trial: [passed, total] each. */
function measures(values: Record<string, [number, number]>): ComparisonTrial['measures'] {
  const thresholds: Record<string, number> = { schema: 1, tool: 0.85, refusal: 1, recovery: 0.7, plan: 0.85 };
  return Object.entries(values).map(([name, [passed, total]]) => ({ name, passed, total, rate: passed / total, threshold: thresholds[name] ?? 0 }));
}

function trial(id: string, modelId: string, overrides: Partial<ComparisonTrial> = {}): ComparisonTrial {
  return {
    id,
    modelId,
    role: 'orchestrator',
    weightsSha256: null,
    catalogStatus: 'experimental',
    status: 'passed',
    requestedAt: `2026-10-1${id}T10:00:00.000Z`,
    startedAt: null,
    finishedAt: null,
    total: 51,
    passed: 47,
    done: 51,
    measures: measures({ schema: [51, 51], tool: [33, 36], refusal: [6, 6], recovery: [5, 6], plan: [3, 3] }),
    latencyMedianMs: 9000,
    latencyMaxMs: 20000,
    reasons: [],
    preemptions: 0,
    error: null,
    casesSha256: NOW,
    tokensPerSecond: 18,
    firstTokenMs: 1100,
    caseMeanMs: 9800,
    model: { name: modelId, provider: null, sizeBytes: null, quantization: null, ramMinGib: 18, from: 'trial' },
    inCatalog: true,
    present: true,
    inUse: false,
    currentQuestions: true,
    ...overrides,
  };
}

const reference = trial('3', 'qwen-27b', { inUse: true, model: { name: 'Qwen3.8 27B', provider: 'Qwen', sizeBytes: 15_200_000_000, quantization: '4bit', ramMinGib: 18, from: 'trial' } });
const fast = trial('4', 'qwen-35b', {
  passed: 44,
  tokensPerSecond: 62,
  firstTokenMs: 500,
  caseMeanMs: 3400,
  measures: measures({ schema: [51, 51], tool: [33, 36], refusal: [6, 6], recovery: [2, 6], plan: [3, 3] }),
  model: { name: 'Qwen3.8 35B-A3B', provider: null, sizeBytes: null, quantization: '4bit', ramMinGib: 20, from: 'trial' },
});
const bad = trial('5', 'minicpm', {
  passed: 39,
  tokensPerSecond: 55,
  measures: measures({ schema: [49, 51], tool: [28, 36], refusal: [6, 6], recovery: [3, 6], plan: [3, 3] }),
  inCatalog: false,
  present: false,
  model: { name: 'MiniCPM-V 4.7', provider: 'OpenBMB', sizeBytes: null, quantization: null, ramMinGib: 21, from: 'trial' },
});

test('the verdict: speed ratio, questions wrong more and where, thresholds; computed from numbers only', () => {
  const lines = verdict([reference, fast, bad]);
  assert.deepEqual(lines, [
    {
      name: 'Qwen3.8 35B-A3B',
      text: 'scrive 3,4 volte più veloce di Qwen3.8 27B (62 contro 18 token al secondo) e sbaglia 3 domande in più, tutte nella ripresa dopo un errore, sotto la soglia nella ripresa dopo un errore (33% contro 70%).',
    },
    {
      name: 'MiniCPM-V 4.7',
      text: 'scrive 3,1 volte più veloce di Qwen3.8 27B (55 contro 18 token al secondo) e sbaglia 8 domande in più (5 nella scelta degli strumenti, 2 nella ripresa dopo un errore): sta sotto la soglia in tre capacità su cinque, come orchestratore non va.',
    },
  ]);
  // Fewer wrong, slower, on other questions, without a speed.
  const slow = trial('6', 'slow', { passed: 49, tokensPerSecond: 9, casesSha256: OLD, measures: measures({ schema: [51, 51], tool: [35, 36], refusal: [6, 6], recovery: [5, 6], plan: [3, 3] }) });
  assert.deepEqual(verdict([slow, reference]).map((line) => line.text), [
    'scrive 2 volte più lento di Qwen3.8 27B (9 contro 18 token al secondo) e sbaglia 2 domande in meno, tutte nella scelta degli strumenti (su domande diverse: confronto indicativo), sopra la soglia in tutte le capacità.',
  ]);
  const unmeasured = trial('7', 'old', { tokensPerSecond: null });
  assert.match(verdict([reference, unmeasured])[0]?.text ?? '', /^non ha una velocità da confrontare con Qwen3\.8 27B \(questa prova non l’ha misurata\) e sbaglia tante domande quante Qwen3\.8 27B/);
  // The reference below a threshold says so; one trial alone has no verdict.
  const weakReference = trial('8', 'weak', { inUse: true, measures: measures({ schema: [51, 51], tool: [20, 36], refusal: [6, 6], recovery: [5, 6], plan: [3, 3] }) });
  assert.equal(verdict([weakReference, fast])[0]?.text, '(riferimento) sta sotto la soglia nella scelta degli strumenti.');
  assert.deepEqual(verdict([reference]), []);
  // Without the model in use among them, the first is the reference (here below a threshold itself).
  assert.deepEqual(verdict([fast, bad]).map((line) => line.name), ['Qwen3.8 35B-A3B', 'MiniCPM-V 4.7']);
});

test('one row per model, its newest finished trial on top, the others under it; the reference first', () => {
  const comparison: Comparison = {
    role: 'orchestrator',
    inUse: { modelId: 'qwen-27b', name: 'Qwen3.8 27B', inCatalog: true, present: true },
    casesSha256: NOW,
    questions: 51,
    trials: [
      trial('9', 'qwen-35b', { status: 'running', passed: 2, done: 3, tokensPerSecond: null }),
      fast,
      bad,
      reference,
      trial('2', 'qwen-27b', { passed: 46, casesSha256: OLD, currentQuestions: false }),
      trial('1', 'gone-early', { status: 'cancelled', total: 32, passed: 1, done: 1, casesSha256: OLD, currentQuestions: false, inCatalog: false, present: false }),
    ],
  };
  const rows = modelRows(comparison, { showGone: true, onlyCurrent: false });
  assert.deepEqual(
    rows.map((row) => [row.modelId, row.main.id, row.history.map((item) => item.id)]),
    [
      ['qwen-27b', '3', ['2']],
      ['minicpm', '5', []],
      ['qwen-35b', '4', ['9']],
      ['gone-early', '1', []],
    ],
  );
  // The filters: no models gone from the disk, only the questions of today.
  assert.deepEqual(modelRows(comparison, { showGone: false, onlyCurrent: false }).map((row) => row.modelId), ['qwen-27b', 'qwen-35b']);
  assert.deepEqual(
    modelRows(comparison, { showGone: true, onlyCurrent: true }).map((row) => [row.modelId, row.history.length]),
    [
      ['qwen-27b', 0],
      ['minicpm', 0],
      ['qwen-35b', 1],
    ],
  );
  assert.deepEqual(modelRows(null, { showGone: true, onlyCurrent: false }), []);

  // The best of each column, among finished rows only.
  const best = bestValues(rows);
  assert.equal(best.score, 47 / 51);
  assert.equal(best.tps, 62);
  assert.equal(best.first, 500);
  assert.equal(best.perCase, 3400);
  assert.equal(best.recovery, 5 / 6);

  // Two or three selected, never an unfinished row.
  let selected = toggleSelected([], '3');
  selected = toggleSelected(selected, '4');
  selected = toggleSelected(selected, '5');
  assert.deepEqual(toggleSelected(selected, '1'), ['3', '4', '5']);
  assert.deepEqual(toggleSelected(selected, '4'), ['3', '5']);
  assert.deepEqual(selectedTrials(rows, ['1', '4', '3']).map((item) => item.id), ['3', '4']);
});

test('question by question only on the same questions', () => {
  assert.equal(sameQuestions([reference, fast]), true);
  assert.equal(sameQuestions([reference, trial('6', 'x', { casesSha256: OLD })]), false);
  assert.equal(sameQuestions([reference, trial('6', 'x', { casesSha256: null })]), false);
  assert.equal(sameQuestions([reference]), false);
});

test('pills, notes and the line of a model', () => {
  assert.deepEqual(pillsOf(reference).map((pill) => pill.text), ['In uso · riferimento']);
  assert.deepEqual(pillsOf(fast).map((pill) => pill.text), ['Da provare']);
  assert.deepEqual(pillsOf(bad).map((pill) => pill.text), ['Tolto dal catalogo']);
  assert.deepEqual(pillsOf(trial('6', 'x', { present: false, casesSha256: OLD, currentQuestions: false })).map((pill) => pill.text), ['Cancellato dal disco', 'Domande di allora']);
  assert.equal(modelLine(reference.model), '4 bit · 15,2 GB · Qwen');
  assert.equal(modelLine({ name: 'x', provider: null, sizeBytes: null, quantization: 'Q4_K_M', ramMinGib: null, from: 'catalog' }), 'Q4_K_M');
  const now = new Date('2026-10-13T12:00:00Z');
  assert.equal(trialNote(trial('5', 'x', { status: 'cancelled', total: 32, done: 1, requestedAt: '2026-10-05T10:00:00Z' }), now, 'Europe/Rome'), 'Annullata dopo 1 domanda su 32, il 5 ott: non si confronta.');
  assert.equal(trialNote(trial('5', 'x', { status: 'running', total: 51, done: 7 }), now), 'In corso: 7 domande su 51.');
  assert.equal(trialNote(reference, now), null);
});

test('closed words for an answer, numbers for the bars', () => {
  assert.deepEqual(answerText({ passed: true, action: 'call', tool: 'kb.search' }), { outcome: 'giusta', detail: null, ok: true });
  assert.deepEqual(answerText({ passed: false, action: 'call', tool: 'kb.search' }), { outcome: 'sbagliata', detail: 'cerca nei documenti', ok: false });
  assert.deepEqual(answerText({ passed: false, action: 'call', tool: 'repo.read' }), { outcome: 'sbagliata', detail: 'usa repo.read', ok: false });
  assert.deepEqual(answerText({ passed: false, action: 'call' }), { outcome: 'sbagliata', detail: 'usa uno strumento che non esiste', ok: false });
  assert.deepEqual(answerText({ passed: false, action: 'reply' }), { outcome: 'sbagliata', detail: 'risponde senza strumenti', ok: false });
  assert.deepEqual(answerText({ passed: false, action: 'unreadable' }), { outcome: 'formato illeggibile', detail: null, ok: false });
  assert.deepEqual(answerText({ passed: false, error: 'LocalModelError:bad-response' }), { outcome: 'formato illeggibile', detail: null, ok: false });
  assert.deepEqual(answerText({ passed: false, error: 'LocalModelError:timeout' }), { outcome: 'sbagliata', detail: 'il modello non ha risposto', ok: false });
  assert.deepEqual(answerText({ passed: true }), { outcome: 'giusta', detail: null, ok: true });
  assert.deepEqual(answerText(null), { outcome: 'non provata', detail: null, ok: null });

  const bars = measureBars([reference, fast]);
  const recovery = bars.find((bar) => bar.name === 'recovery');
  assert.equal(recovery?.label, 'Ripresa dopo un errore');
  assert.equal(recovery.threshold, 0.7);
  assert.deepEqual(recovery.bars.map((bar) => [bar?.passed, bar?.total, bar?.below]), [
    [5, 6, false],
    [2, 6, true],
  ]);
  assert.deepEqual(relativeWidths([18, 62, null, 0]), [29, 100, null, 2]);
  assert.deepEqual(relativeWidths([null]), [null]);
  assert.equal(tpsText(17.6), '18');
  assert.equal(tpsText(7.46), '7,5');
  assert.equal(tpsText(null), '—');
  assert.equal(secondsText(1100), '1,1 s');
  assert.equal(secondsText(480), '0,5 s');
  assert.equal(secondsText(12_400), '12 s');
  assert.equal(secondsText(null), '—');
});
