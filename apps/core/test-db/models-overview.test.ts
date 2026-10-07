// The last trial of each model in the list of the "Modelli" page (I-3, stage M2).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { DATA_DIR, defaultCloudModels, loadCatalog, resolveHome } from '@arianna/config';

import { weightsDigest } from '../src/model-evals.ts';
import { lastEvals, loadModelsOverview } from '../src/models-overview.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

test('lastEvals keeps the newest trial of each model, whatever its state', async () => {
  const { sql } = db();
  assert.deepEqual(await lastEvals(sql), []);
  const weights = 'a'.repeat(64);
  await sql`
    INSERT INTO model_evals (model_id, role, weights_sha256, catalog_status, status, requested_at, started_at, finished_at, total, passed, measures, cases, latency_median_ms)
    VALUES ('fake-a', 'orchestrator', ${weights}, 'experimental', 'passed', '2026-10-01T10:00:00Z', '2026-10-01T10:00:01Z', '2026-10-01T10:05:00Z', 10, 9, '[]', '[]', 1200)`;
  await sql`
    INSERT INTO model_evals (model_id, role, weights_sha256, catalog_status, status, requested_at, finished_at, error)
    VALUES ('fake-a', 'orchestrator', ${weights}, 'experimental', 'cancelled', '2026-10-02T10:00:00Z', '2026-10-02T10:01:00Z', 'cancelled')`;
  await sql`
    INSERT INTO model_evals (model_id, role, weights_sha256, catalog_status, requested_at)
    VALUES ('fake-b', 'orchestrator', ${weights}, 'experimental', '2026-09-30T10:00:00Z')`;

  const rows = await lastEvals(sql);
  assert.deepEqual(
    rows.map(({ modelId, status, passed, total }) => ({ modelId, status, passed, total })),
    [
      { modelId: 'fake-a', status: 'cancelled', passed: null, total: null },
      { modelId: 'fake-b', status: 'queued', passed: null, total: null },
    ],
  );
  assert.ok(rows[0]?.requestedAt instanceof Date);
  assert.equal(rows[0].weightsSha256, weights);
});

test('loadModelsOverview puts the last trial on its catalog model', async () => {
  const { sql } = db();
  const home = resolveHome({});
  const model = loadCatalog(home).models[0];
  assert.ok(model !== undefined);
  await sql`
    INSERT INTO model_evals (model_id, role, weights_sha256, catalog_status, status, requested_at, started_at, finished_at, total, passed, measures, cases)
    VALUES (${model.id}, 'orchestrator', ${weightsDigest(model)}, 'experimental', 'failed', now(), now(), now(), 10, 4, '[]', '[]')`;
  const overview = await loadModelsOverview(sql, {
    home,
    dataDir: join(home, DATA_DIR),
    config: () => ({ roles: {}, cloud: { executors: [], models: defaultCloudModels() }, agents: {} }),
    adapters: () => ({ claude: false, codex: false }),
  });
  const found = overview.local.find(({ id }) => id === model.id);
  assert.equal(found?.lastEval?.status, 'failed');
  assert.equal(found.lastEval.passed, 4);
  assert.equal(found.lastEval.sameWeights, true);
  assert.equal(overview.local.filter(({ lastEval }) => lastEval !== null).length, 1);
});
