import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CatalogEntry } from '@arianna/config';

import {
  caseComparison,
  caseRow,
  catalogCopy,
  comparisonOf,
  questionsOf,
  quantizationOf,
  readableName,
  sameQuestions,
  speedSummary,
  type ModelEvalRow,
} from '../src/model-evals.ts';

// «Confronto dei modelli» (D-199): pure parts, invented models and cases.

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    family: 'fake',
    runtime: 'mlx',
    ramMinGib: 18,
    roles: ['orchestrator'],
    status: 'experimental',
    files: [
      { path: 'a.safetensors', url: 'https://example.org/a', sizeBytes: 1000, sha256: 'a'.repeat(64) },
      { path: 'b.safetensors', url: 'https://example.org/b', sizeBytes: 500, sha256: 'b'.repeat(64) },
    ],
    ...overrides,
  };
}

test('a case keeps the kind of action and a tool of the registry, never the arguments nor a made-up tool', () => {
  const base = { id: 'c1', passed: true, durationMs: 1200.4 };
  assert.deepEqual(caseRow({ ...base, actual: { action: 'call', tool: 'kb.search', arguments: { query: 'SEGRETO' }, schemaOk: true } }), {
    id: 'c1',
    passed: true,
    ms: 1200,
    action: 'call',
    tool: 'kb.search',
  });
  // A tool that is not in the registry: the action stays, the name does not.
  assert.deepEqual(caseRow({ ...base, actual: { action: 'call', tool: 'scrivi la mail a Rossi', schemaOk: true } }), { id: 'c1', passed: true, ms: 1200, action: 'call' });
  assert.deepEqual(caseRow({ ...base, actual: { action: 'reply', text: 'SEGRETO', schemaOk: true } }), { id: 'c1', passed: true, ms: 1200, action: 'reply' });
  assert.deepEqual(caseRow({ ...base, passed: false, actual: { action: 'invalid', schemaOk: false } }), { id: 'c1', passed: false, ms: 1200, action: 'unreadable' });
  assert.deepEqual(caseRow({ ...base, passed: false, actual: { action: 'refuse', schemaOk: false } }), { id: 'c1', passed: false, ms: 1200, action: 'unreadable' });
  // An error: the code only.
  assert.deepEqual(caseRow({ ...base, passed: false, error: 'echo SEGRETO', errorCode: 'LocalModelError:bad-response' }), {
    id: 'c1',
    passed: false,
    ms: 1200,
    error: 'LocalModelError:bad-response',
  });
  // The speed: integers, only what was measured.
  assert.deepEqual(caseRow({ ...base, actual: { action: 'plan', steps: '3-5', schemaOk: true, speed: { firstTextMs: 400.6, tokens: 80, generationMs: 1999.5 } } }), {
    id: 'c1',
    passed: true,
    ms: 1200,
    action: 'plan',
    firstMs: 401,
    tokens: 80,
    genMs: 2000,
  });
  assert.doesNotMatch(JSON.stringify(caseRow({ ...base, actual: { action: 'call', tool: 'kb.search', arguments: { query: 'SEGRETO' }, schemaOk: true } })), /SEGRETO|3-5/);
});

test('the speed of a trial: all the tokens over all the writing time, the mean first word; null when nothing was measured', () => {
  assert.deepEqual(
    speedSummary([
      { id: 'a', passed: true, ms: 3000, firstMs: 1000, tokens: 40, genMs: 2000 },
      { id: 'b', passed: false, ms: 2000, firstMs: 500, tokens: 20, genMs: 1500 },
      // An error does not count, nor a case without counts for the rate.
      { id: 'c', passed: false, ms: 9000, error: 'LocalModelError:timeout', firstMs: 9000, tokens: 1, genMs: 1 },
      { id: 'd', passed: true, ms: 900, firstMs: 300 },
    ]),
    { tokensPerSecond: 17.14, firstTokenMs: 600 },
  );
  // An old trial, or a server without counts and without streaming.
  assert.deepEqual(speedSummary([{ id: 'a', passed: true, ms: 3000 }]), { tokensPerSecond: null, firstTokenMs: null });
  assert.deepEqual(speedSummary([{ id: 'a', passed: true, ms: 3000, firstMs: 200 }]), { tokensPerSecond: null, firstTokenMs: 200 });
  assert.deepEqual(speedSummary([]), { tokensPerSecond: null, firstTokenMs: null });
});

test('the catalog copy: a readable name, the provider, the size of all the files, the quantization when the names say it', () => {
  assert.equal(readableName({ id: 'qwen3.8-27b-4bit', source: 'https://huggingface.co/mlx-community/Qwen3.8-27B-4bit' }), 'Qwen3.8 27B');
  assert.equal(readableName({ id: 'qwen3.8-27b-uncensored-mlx', source: 'https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX' }), 'Qwen3.8 27B Uncensored');
  assert.equal(readableName({ id: 'qwen3.8-35b-a3b-4bit' }), 'Qwen3.8 35B-A3B');
  assert.equal(readableName({ id: 'fake-model', source: 'not a url' }), 'Fake model');
  assert.equal(readableName({ id: 'mlx-4bit' }), 'mlx-4bit');
  assert.equal(quantizationOf({ id: 'qwen3.8-27b-4bit' }), '4bit');
  assert.equal(quantizationOf({ id: 'fake-model', source: 'https://huggingface.co/x/Fake-8bit' }), '8bit');
  assert.equal(quantizationOf({ id: 'fake-q4_k_m-gguf' }), 'Q4_K_M');
  assert.equal(quantizationOf({ id: 'fake-bf16' }), 'bf16');
  assert.equal(quantizationOf({ id: 'fake-model' }), null);
  assert.deepEqual(catalogCopy(entry('qwen3.8-27b-4bit', { provider: 'Qwen;\u0007 conversione finta' })), {
    name: 'Qwen3.8 27B',
    provider: 'Qwen;  conversione finta',
    sizeBytes: 1500,
    quantization: '4bit',
    ramMinGib: 18,
  });
  assert.equal(catalogCopy(entry('fake-model')).provider, null);
});

const HEX_NOW = 'a'.repeat(64);
const HEX_OLD = 'b'.repeat(64);

function row(id: string, modelId: string, overrides: Partial<ModelEvalRow> = {}): Omit<ModelEvalRow, 'cases'> & { caseMeanMs: number | null } {
  return {
    id,
    modelId,
    role: 'orchestrator',
    weightsSha256: null,
    catalogStatus: 'experimental',
    casesSha256: HEX_NOW,
    promptSha256: null,
    status: 'passed',
    requestedAt: new Date('2026-10-13T10:00:00Z'),
    startedAt: new Date('2026-10-13T10:00:01Z'),
    finishedAt: new Date('2026-10-13T11:00:00Z'),
    total: 4,
    passed: 3,
    done: 4,
    measures: [],
    latencyMedianMs: 1000,
    latencyMaxMs: 2000,
    reasons: [],
    preemptions: 0,
    error: null,
    tokensPerSecond: null,
    firstTokenMs: null,
    modelName: null,
    modelProvider: null,
    modelSizeBytes: null,
    modelQuantization: null,
    modelRamMinGib: null,
    caseMeanMs: 1200,
    ...overrides,
  };
}

test('the comparison keeps the trials of models gone from the catalog or the disk, with the model in use as reference', () => {
  const catalog = { version: 1 as const, models: [entry('fake-used-4bit'), entry('fake-other-4bit')] };
  const looked: string[] = [];
  const comparison = comparisonOf(
    [
      row('4', 'fake-gone-8bit', { modelName: 'Fake Gone', modelProvider: 'Lab finto', modelSizeBytes: 2000, modelQuantization: '8bit', modelRamMinGib: 20, casesSha256: HEX_OLD }),
      row('3', 'fake-other-4bit'),
      row('2', 'fake-used-4bit', { modelName: 'Fake Used (copia)', modelSizeBytes: 1500, modelRamMinGib: 18 }),
      row('1', 'fake-used-4bit', { casesSha256: null, status: 'cancelled', total: 4, passed: 1, error: 'user' }),
    ],
    {
      role: 'orchestrator',
      catalog,
      inUse: 'fake-used-4bit',
      present: (item) => {
        looked.push(item.id);
        return item.id === 'fake-used-4bit';
      },
      casesSha256: HEX_NOW,
      questions: 4,
    },
  );
  assert.deepEqual(comparison.inUse, { modelId: 'fake-used-4bit', name: 'Fake used', inCatalog: true, present: true });
  assert.equal(comparison.casesSha256, HEX_NOW);
  assert.deepEqual(
    comparison.trials.map((trial) => [trial.id, trial.model.name, trial.model.from, trial.inCatalog, trial.present, trial.inUse, trial.currentQuestions]),
    [
      ['4', 'Fake Gone', 'trial', false, false, false, false],
      ['3', 'Fake other', 'catalog', true, false, false, true],
      ['2', 'Fake Used (copia)', 'trial', true, true, true, true],
      ['1', 'Fake used', 'catalog', true, true, true, false],
    ],
  );
  // The disk is looked at once per model.
  assert.deepEqual(looked.sort(), ['fake-other-4bit', 'fake-used-4bit']);
  // A model gone with no copy (a trial before D-199): its id.
  const old = comparisonOf([row('9', 'fake-ancient')], { role: 'orchestrator', catalog: { version: 1, models: [] }, inUse: undefined, present: () => true, casesSha256: HEX_NOW, questions: 0 });
  assert.deepEqual(old.trials[0]?.model, { name: 'fake-ancient', provider: null, sizeBytes: null, quantization: null, ramMinGib: null, from: 'id' });
  assert.equal(old.inUse, null);
});

test('question by question only on the same questions', () => {
  assert.equal(sameQuestions([{ casesSha256: HEX_NOW }, { casesSha256: HEX_NOW }]), true);
  assert.equal(sameQuestions([{ casesSha256: HEX_NOW }, { casesSha256: HEX_OLD }]), false);
  assert.equal(sameQuestions([{ casesSha256: null }, { casesSha256: null }]), false);
  assert.equal(sameQuestions([]), false);
});

test('the questions with different outcomes, with the fake question and its capability', () => {
  const questions = questionsOf([
    { id: 'q-tool', input: { tools: [], messages: [{ role: 'user', content: 'Cerca la caparra finta.' }] }, expect: {}, tags: ['tool'] },
    {
      id: 'q-recovery',
      input: { tools: [], messages: [{ role: 'user', content: 'Trova la bolletta finta.' }, { role: 'tool', content: 'error: x' }] },
      expect: {},
      tags: ['recovery'],
    },
    { id: 'q-plan', input: { tools: [], messages: [{ role: 'user', content: 'x'.repeat(400) }] }, expect: {}, tags: ['plan', 'other'] },
    { id: 'q-odd', input: 'no messages', expect: {}, tags: [] },
  ]);
  assert.deepEqual(questions.get('q-recovery'), { text: 'Trova la bolletta finta.', capability: 'recovery' });
  assert.equal(questions.get('q-plan')?.text?.length, 300);
  assert.deepEqual(questions.get('q-odd'), { text: null, capability: null });

  const compared = caseComparison(
    [
      {
        id: '1',
        cases: [
          { id: 'q-tool', passed: true, ms: 1, action: 'call', tool: 'kb.search' },
          { id: 'q-recovery', passed: true, ms: 1, action: 'call', tool: 'kb.search' },
          { id: 'q-plan', passed: true, ms: 1, action: 'plan' },
        ],
      },
      {
        id: '2',
        cases: [
          { id: 'q-tool', passed: true, ms: 1, action: 'call', tool: 'kb.search' },
          { id: 'q-recovery', passed: false, ms: 1, action: 'unreadable' },
          { id: 'q-plan', passed: false, ms: 1, error: 'LocalModelError:timeout' },
        ],
      },
    ],
    questions,
  );
  assert.deepEqual(compared, {
    ids: ['1', '2'],
    total: 3,
    differing: [
      { id: 'q-recovery', text: 'Trova la bolletta finta.', capability: 'recovery', results: [{ passed: true, action: 'call', tool: 'kb.search' }, { passed: false, action: 'unreadable' }] },
      { id: 'q-plan', text: 'x'.repeat(300), capability: 'plan', results: [{ passed: true, action: 'plan' }, { passed: false, error: 'LocalModelError:timeout' }] },
    ],
  });
  // A case one trial does not have counts as different; a question gone from the folder has no text.
  const missing = caseComparison(
    [
      { id: '1', cases: [{ id: 'gone', passed: true, ms: 1 }] },
      { id: '2', cases: [] },
    ],
    questions,
  );
  assert.deepEqual(missing.differing, [{ id: 'gone', text: null, capability: null, results: [{ passed: true }, null] }]);
});
