import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadMigrations, migrate, MigrationError } from '../src/db/migrate.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

test('migrations apply from zero and create every table', async () => {
  const { sql, schema } = db();
  const tables = await sql<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = ${schema} ORDER BY table_name`;
  assert.deepEqual(
    tables.map((table) => table.name),
    [
      'approvals',
      'conversations',
      'events',
      'gateway_log',
      'jobs',
      'label_changes',
      'messages',
      'router_decisions',
      'runs',
      'schema_migrations',
      'tasks',
      'telegram_state',
    ],
  );
});

test('applying again does nothing', async () => {
  assert.deepEqual(await migrate(db().sql, loadMigrations()), []);
});

test('an applied migration that was edited is rejected', async () => {
  const edited = loadMigrations().map((migration) => ({ ...migration, sha256: 'f'.repeat(64) }));
  await assert.rejects(migrate(db().sql, edited), MigrationError);
});

test('an applied migration whose file is missing is rejected', async () => {
  await assert.rejects(migrate(db().sql, []), MigrationError);
});

test('a migration older than the last applied one is rejected', async () => {
  const late = [
    { version: '0000', name: 'late', sql: 'SELECT 1;', sha256: 'c'.repeat(64) },
    ...loadMigrations(),
  ];
  await assert.rejects(migrate(db().sql, late), MigrationError);
});

test('a failing migration leaves nothing behind', async () => {
  const { sql } = db();
  const broken = [
    ...loadMigrations(),
    { version: '9998', name: 'ok', sql: 'CREATE TABLE half_done (id int);', sha256: 'a'.repeat(64) },
    { version: '9999', name: 'broken', sql: 'SELECT no_such_function();', sha256: 'b'.repeat(64) },
  ];
  await assert.rejects(migrate(sql, broken));
  const [row] = await sql<{ found: boolean }[]>`
    SELECT to_regclass('half_done') IS NOT NULL AS found`;
  assert.equal(row?.found, false);
});

test('an agent task cannot be closed without evidence, a user task can', async () => {
  const { sql } = db();
  await assert.rejects(
    sql`INSERT INTO tasks (title, assignee, status) VALUES ('fix bug', 'coder', 'done')`,
    /tasks_done_needs_evidence/,
  );
  await assert.rejects(
    sql`INSERT INTO tasks (title, assignee, status, evidence) VALUES ('fix bug', 'coder', 'done', '{}')`,
    /tasks_done_needs_evidence|tasks_evidence_is_list/,
  );
  await assert.rejects(
    sql`INSERT INTO tasks (title, evidence) VALUES ('fix bug', '{"kind":"diff"}')`,
    /tasks_evidence_is_list/,
  );
  await sql`
    INSERT INTO tasks (title, assignee, status, evidence)
    VALUES ('fix bug', 'coder', 'done', '[{"kind":"diff"}]')`;
  await sql`INSERT INTO tasks (title, assignee, status) VALUES ('pay invoice', 'user', 'done')`;
});

test('a task cannot have read above its clearance, and is never cleared for L3', async () => {
  const { sql } = db();
  await assert.rejects(
    sql`INSERT INTO tasks (title, clearance, effective_label) VALUES ('work', 'L1', 'L2')`,
    /tasks_effective_within_clearance/,
  );
  await assert.rejects(
    sql`INSERT INTO tasks (title, clearance) VALUES ('secrets', 'L3')`,
    /tasks_clearance_below_secret/,
  );
  await sql`INSERT INTO tasks (title, clearance, effective_label) VALUES ('work', 'L1', 'L1')`;
});

test('unlabeled tasks and jobs get safe defaults', async () => {
  const { sql } = db();
  const [task] = await sql<{ label: string; status: string }[]>`
    INSERT INTO tasks (title) VALUES ('untriaged') RETURNING label, status`;
  assert.deepEqual({ ...task }, { label: 'L2', status: 'inbox' });
  const [job] = await sql<{ status: string; attempts: number }[]>`
    INSERT INTO jobs (queue) VALUES ('default') RETURNING status, attempts`;
  assert.deepEqual({ ...job }, { status: 'queued', attempts: 0 });
});

test('jobs reject impossible attempt counts', async () => {
  const { sql } = db();
  await assert.rejects(sql`INSERT INTO jobs (queue, max_attempts) VALUES ('default', 0)`);
  await assert.rejects(sql`INSERT INTO jobs (queue, attempts) VALUES ('default', -1)`);
});
