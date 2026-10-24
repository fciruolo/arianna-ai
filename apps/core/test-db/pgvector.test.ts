import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '@arianna/config';

import { resolveLogin } from '../src/db/logins.ts';
import { runDoctor } from '../src/doctor.ts';
import { coreChecks, groupChecks } from '../src/readiness.ts';
import { useTestDatabase, withClusterLock } from './support/database.ts';

// pgvector (migration 0092, D-308): the type works for the application role
// with unqualified names, and the extension stays out of the schemas the
// tests drop.
const db = useTestDatabase();

test('the extension lives in its own schema, not in the schema of the migrations', async () => {
  const { owner } = db();
  const [row] = await owner<{ schema: string }[]>`
    SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`;
  assert.equal(row?.schema, 'extensions');
  // Nothing else in it: the core never puts a table there.
  const [count] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'extensions'::regnamespace`;
  assert.equal(count?.n, 0);
});

test('a vector column and a nearest-neighbour search, as the application role', async () => {
  const { owner, sql } = db();
  // Tables are the owner's (D-046): the core only reads and writes rows.
  await owner`CREATE TABLE fake_embeddings (id int PRIMARY KEY, embedding vector(3) NOT NULL)`;
  await owner`CREATE INDEX fake_embeddings_hnsw ON fake_embeddings USING hnsw (embedding vector_cosine_ops)`;
  await owner`GRANT SELECT, INSERT ON fake_embeddings TO arianna_app`;
  await sql`
    INSERT INTO fake_embeddings (id, embedding)
    VALUES (1, '[1, 0, 0]'), (2, '[0, 1, 0]'), (3, '[0.9, 0.1, 0]'), (4, '[0, 0, 1]')`;
  const query = '[1, 0.05, 0]';
  const rows = await sql<{ id: number; distance: number }[]>`
    SELECT id, embedding <=> ${query}::vector AS distance
    FROM fake_embeddings ORDER BY embedding <=> ${query}::vector LIMIT 2`;
  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 3],
  );
  assert.ok((rows[0]?.distance ?? 1) < 0.01);
  // Euclidean distance too, with its operator unqualified.
  const [nearest] = await sql<{ id: number }[]>`SELECT id FROM fake_embeddings ORDER BY embedding <-> '[0, 0, 0.8]' LIMIT 1`;
  assert.equal(nearest?.id, 4);
});

test('the application role cannot create objects in the schema of the extension, nor drop it', async () => {
  const { owner, sql } = db();
  // The grants on `extensions` are the database's: roles.test.ts opens them
  // for a moment under this lock.
  await withClusterLock(owner, async () => {
    await assert.rejects(sql`CREATE TABLE extensions.intruder (id int)`, /permission denied/);
    await assert.rejects(sql`DROP EXTENSION vector`, /must be owner/);
  });
  // A wrong dimension is refused by the type, whoever writes.
  await assert.rejects(sql`SELECT '[1, 2]'::vector(3)`, /expected 3 dimensions/);
});

test('doctor: database.vector passes, and fails when the application role cannot use the schema', async () => {
  const { owner, schema } = db();
  const vector = async (): Promise<{ ok: boolean; detail: string } | undefined> =>
    (await runDoctor({ config: loadConfig(), schema })).find((check) => check.id === 'database.vector');
  // Under the lock: the REVOKE below is the database's.
  await withClusterLock(owner, async () => {
    assert.match((await vector())?.detail ?? '', /^pgvector \d+\.\d+\.\d+ in extensions$/);
    assert.equal((await vector())?.ok, true);
    await owner`REVOKE USAGE ON SCHEMA extensions FROM arianna_app`;
    try {
      assert.deepEqual(await vector(), { id: 'database.vector', ok: false, detail: 'arianna_app cannot use the schema extensions' });
    } finally {
      await owner`GRANT USAGE ON SCHEMA extensions TO arianna_app`;
    }
  });
});

test('«Pronta per i dati veri» (D-192): the core checks pgvector as the application role, row «vector»', async () => {
  const { owner, sql } = db();
  const config = loadConfig();
  const app = await resolveLogin(config, 'app');
  const vectorGroup = async (): Promise<{ id: string; ok: boolean } | undefined> =>
    groupChecks(await coreChecks(config, sql, app, () => Promise.resolve('1.0'))).find((group) => group.id === 'vector');
  await withClusterLock(owner, async () => {
    assert.deepEqual(await vectorGroup(), { id: 'vector', ok: true });
    await owner`REVOKE USAGE ON SCHEMA extensions FROM arianna_app`;
    try {
      assert.deepEqual(await vectorGroup(), { id: 'vector', ok: false });
    } finally {
      await owner`GRANT USAGE ON SCHEMA extensions TO arianna_app`;
    }
  });
});
