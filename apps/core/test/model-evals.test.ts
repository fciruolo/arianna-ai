import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import type { CatalogEntry, ModelCatalog } from '@arianna/config';
import type { GroupReport } from '@arianna/evals';

import { checkCandidate, rowFromReport, weightsDigest } from '../src/model-evals.ts';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'fake-model-4bit',
    family: 'fake',
    runtime: 'mlx',
    ramMinGib: 8,
    roles: ['orchestrator'],
    status: 'experimental',
    files: [
      { path: 'config.json', url: 'https://example.org/config.json', sizeBytes: 10, sha256: HEX_A },
      { path: 'model.safetensors', url: 'https://example.org/model.safetensors', sizeBytes: 20, sha256: HEX_B },
    ],
    ...overrides,
  };
}

const catalog = (...models: CatalogEntry[]): ModelCatalog => ({ version: 1, models });
const DIR = join('/fake', 'data', 'models');
/** Every file present with the size the catalog says. */
const allThere = (path: string): number | undefined => (path.endsWith('config.json') ? 10 : path.endsWith('model.safetensors') ? 20 : undefined);

test('the weights digest does not depend on the order of the files, and changes with any of them', () => {
  const one = entry();
  const reversed = entry({ files: [...one.files].reverse() });
  assert.equal(weightsDigest(one), weightsDigest(reversed));
  assert.match(weightsDigest(one), /^[0-9a-f]{64}$/);
  const other = entry({ files: one.files.map((file, index) => (index === 0 ? { ...file, sha256: 'c'.repeat(64) } : file)) });
  assert.notEqual(weightsDigest(one), weightsDigest(other));
  const renamed = entry({ files: one.files.map((file, index) => (index === 0 ? { ...file, path: 'other.json' } : file)) });
  assert.notEqual(weightsDigest(one), weightsDigest(renamed));
});

test('a candidate is in the catalog, suited to the role and on disk', () => {
  const check = checkCandidate(catalog(entry()), 'fake-model-4bit', 'orchestrator', DIR, allThere);
  assert.equal(check.ok, true);
  assert.deepEqual(checkCandidate(catalog(entry()), 'not-there', 'orchestrator', DIR, allThere), { ok: false, code: 'not-in-catalog' });
  assert.deepEqual(checkCandidate(catalog(entry({ roles: ['extractor'] })), 'fake-model-4bit', 'orchestrator', DIR, allThere), { ok: false, code: 'role' });
  const missing = (path: string): number | undefined => (path.endsWith('config.json') ? 10 : undefined);
  assert.deepEqual(checkCandidate(catalog(entry()), 'fake-model-4bit', 'orchestrator', DIR, missing), { ok: false, code: 'files-missing' });
  const short = (path: string): number | undefined => (path.endsWith('config.json') ? 10 : 19);
  assert.deepEqual(checkCandidate(catalog(entry()), 'fake-model-4bit', 'orchestrator', DIR, short), { ok: false, code: 'files-missing' });
  // The files are looked for in data/models/<id>.
  const seen: string[] = [];
  checkCandidate(catalog(entry()), 'fake-model-4bit', 'orchestrator', DIR, (path) => {
    seen.push(path);
    return allThere(path);
  });
  assert.deepEqual(seen, [join(DIR, 'fake-model-4bit', 'config.json'), join(DIR, 'fake-model-4bit', 'model.safetensors')]);
});

test('the stored outcome has ids, outcomes, times and codes, never what the model said', () => {
  const report: GroupReport = {
    name: 'orchestrator',
    status: 'failed',
    threshold: 0,
    total: 2,
    passed: 1,
    rate: 0.5,
    measures: [{ name: 'tool', total: 2, passed: 1, rate: 0.5, threshold: 0.85 }],
    latency: { medianMs: 1234.4, maxMs: 2000.6 },
    reasons: ['measure "tool" below threshold'],
    results: [
      { id: 'tool-1', passed: true, tags: ['tool'], durationMs: 1234.4, actual: { action: 'reply', text: 'SEGRETO del modello' } },
      { id: 'tool-2', passed: false, tags: ['tool'], durationMs: 2000.6, error: 'omlx echoed SEGRETO', errorCode: 'LocalModelError:timeout' },
    ],
  };
  const row = rowFromReport(report);
  assert.deepEqual(row, {
    status: 'failed',
    total: 2,
    passed: 1,
    measures: [{ name: 'tool', total: 2, passed: 1, rate: 0.5, threshold: 0.85 }],
    latencyMedianMs: 1234,
    latencyMaxMs: 2001,
    reasons: ['measure "tool" below threshold'],
    cases: [
      { id: 'tool-1', passed: true, ms: 1234 },
      { id: 'tool-2', passed: false, ms: 2001, error: 'LocalModelError:timeout' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(row), /SEGRETO|tags/);
  assert.throws(() => rowFromReport({ name: 'x', status: 'pending', until: 'later', cases: 0 }));
});
