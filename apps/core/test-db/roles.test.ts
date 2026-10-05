import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '@arianna/config';
import { Secret, VaultError } from '@arianna/vault';

import { runDoctor, type DoctorCheck } from '../src/doctor.ts';
import { useTestDatabase, withClusterLock } from './support/database.ts';

const db = useTestDatabase();
const config = loadConfig();

function byId(checks: DoctorCheck[]): (id: string) => { ok: boolean; detail: string } {
  return (id) => {
    const check = checks.find((candidate) => candidate.id === id);
    if (check === undefined) throw new Error(`no check ${id}`);
    return { ok: check.ok, detail: check.detail };
  };
}

test('the application role logs in with its password and works on rows', async () => {
  const { sql } = db();
  const [who] = await sql<{ user: string }[]>`SELECT current_user AS user`;
  assert.equal(who?.user, 'arianna_app');
  const [task] = await sql<{ id: string }[]>`INSERT INTO tasks (title) VALUES ('fake task') RETURNING id::text`;
  await sql`UPDATE tasks SET title = 'renamed' WHERE id = ${task?.id ?? ''}`;
});

test('the application role cannot touch the schema, delete rows or become someone else', async () => {
  const { sql } = db();
  await assert.rejects(sql`CREATE TABLE intruder (id int)`, /permission denied for schema/);
  // A temporary approvals would shadow the real one inside the label_changes guard.
  await assert.rejects(sql`CREATE TEMP TABLE approvals (id uuid)`, /permission denied to create temporary tables/);
  await assert.rejects(sql`ALTER TABLE tasks ADD COLUMN extra int`, /must be owner/);
  await assert.rejects(sql`ALTER TABLE events DISABLE TRIGGER events_append_only`, /must be owner/);
  await assert.rejects(sql`DROP TABLE jobs`, /must be owner/);
  await assert.rejects(
    sql.unsafe('CREATE OR REPLACE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$'),
    /must be owner|permission denied/,
  );
  await assert.rejects(sql`DELETE FROM tasks`, /permission denied/);
  await assert.rejects(sql`TRUNCATE jobs`, /permission denied/);
  await assert.rejects(sql.unsafe(`SET ROLE ${config.database.user}`), /permission denied/);
  await assert.rejects(sql`ALTER ROLE arianna_app SUPERUSER`, /permission denied/);
});

test('doctor, with the development passwords: database sound, not ready for real data', async () => {
  const checks = byId(await runDoctor({ config, schema: db().schema }));
  assert.equal(checks('database.passwords').ok, false);
  assert.match(checks('database.passwords').detail, /development defaults/);
  assert.equal(checks('database.owner').ok, true);
  assert.equal(checks('database.default-passwords').ok, false);
  assert.match(checks('database.default-passwords').detail, /still accepted for arianna, arianna_app/);
  assert.deepEqual(checks('database.migrations'), { ok: true, detail: '19 applied' });
  assert.equal(checks('database.app-role').ok, true, checks('database.app-role').detail);
  assert.equal(checks('events.chain').ok, true);
});

test('doctor does not trust the configuration: vault passwords equal to the defaults still fail', async () => {
  const vaulted = { ...config, database: { ...config.database, password: 'vault://db-owner', appPassword: 'vault://db-app' } };
  const values: Record<string, string> = { 'vault://db-owner': 'arianna_dev', 'vault://db-app': 'arianna_app_dev' };
  const resolve = (ref: string): Promise<Secret> => Promise.resolve(new Secret(ref, values[ref] ?? ''));
  const checks = byId(await runDoctor({ config: vaulted, resolve, schema: db().schema }));
  assert.equal(checks('database.passwords').ok, false);
  assert.match(checks('database.passwords').detail, /owner password is short; the app password is short/);
  assert.equal(checks('database.default-passwords').ok, false);
});

test('doctor refuses one value behind two references', async () => {
  const vaulted = { ...config, database: { ...config.database, password: 'vault://db-owner', appPassword: 'vault://db-app' } };
  const resolve = (ref: string): Promise<Secret> => Promise.resolve(new Secret(ref, 'Same-Value-For-Both-0123456789'));
  const checks = byId(await runDoctor({ config: vaulted, resolve, schema: db().schema }));
  assert.equal(checks('database.passwords').ok, false);
  assert.match(checks('database.passwords').detail, /the two passwords are the same/);
  assert.doesNotMatch(JSON.stringify(checks('database.passwords')), /Same-Value/);
});

test('doctor on a schema never migrated reports it instead of crashing', async () => {
  const { owner } = db();
  const empty = `${db().schema}_empty`;
  await owner.unsafe(`CREATE SCHEMA ${empty}`);
  try {
    const checks = byId(await runDoctor({ config, schema: empty }));
    assert.equal(checks('database.migrations').ok, false);
    assert.match(checks('database.migrations').detail, /not checked \(42P01\)/);
    assert.equal(checks('events.chain').ok, false);
  } finally {
    await owner.unsafe(`DROP SCHEMA ${empty} CASCADE`);
  }
});

test('doctor reports an unreadable vault without going further', async () => {
  const vaulted = { ...config, database: { ...config.database, password: 'vault://db-owner', appPassword: 'vault://db-app' } };
  const resolve = (ref: string): Promise<Secret> => Promise.reject(new VaultError('decrypt-failed', `${ref}: sops could not decrypt the secret`));
  const checks = await runDoctor({ config: vaulted, resolve, schema: db().schema });
  assert.deepEqual(
    checks.map((check) => [check.id, check.ok]),
    [
      ['database.passwords', false],
      ['database', false],
    ],
  );
  assert.match(checks[0]?.detail ?? '', /vault:\/\/db-owner/);
});

test('doctor catches a role with too much, a table without grants and a migration without a file', async () => {
  const { owner, schema } = db();
  // The TEMPORARY grant is database-wide: another file migrating meanwhile
  // would revoke it before the doctor looks.
  await withClusterLock(owner, async () => {
    await owner`GRANT UPDATE ON events TO arianna_app`;
    await owner`GRANT DELETE ON jobs TO arianna_app`;
    await owner`CREATE TABLE forgotten (id int)`;
    await owner`INSERT INTO schema_migrations (version, name, sha256) VALUES ('9999', 'ghost', ${'0'.repeat(64)})`;
    await owner`GRANT INSERT ON schema_migrations TO arianna_app`;
    await owner`CREATE SEQUENCE orphan_seq`;
    // A function that runs as the owner; PUBLIC may execute a new function.
    await owner`CREATE FUNCTION owner_hands() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`;
    // An overload is not the purge, and the purge itself opened to everyone and unpinned.
    await owner`CREATE FUNCTION purge_conversation(text) RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`;
    await owner`GRANT EXECUTE ON FUNCTION purge_conversation(uuid) TO PUBLIC`;
    await owner`ALTER FUNCTION purge_conversation(uuid) RESET search_path`;
    await owner.unsafe(`GRANT CREATE ON SCHEMA ${schema} TO arianna_app`);
    // Database-wide, revoked below under the lock: the other files never check it.
    await owner.unsafe(`GRANT TEMPORARY ON DATABASE ${config.database.name} TO arianna_app`);
    try {
      const checks = byId(await runDoctor({ config, schema }));
      assert.equal(checks('database.app-role').ok, false);
      assert.match(checks('database.app-role').detail, /cannot read forgotten/);
      assert.match(checks('database.app-role').detail, /may delete, truncate, maintain or add triggers on jobs/);
      assert.match(checks('database.app-role').detail, /may update append-only events/);
      assert.match(checks('database.app-role').detail, /may write schema_migrations/);
      assert.match(checks('database.app-role').detail, /cannot use sequence orphan_seq/);
      assert.match(checks('database.app-role').detail, /can create objects in the schema/);
      assert.match(checks('database.app-role').detail, /can create temporary tables/);
      assert.match(checks('database.app-role').detail, /may run as the owner through owner_hands/);
      assert.match(checks('database.app-role').detail, /may run as the owner through owner_hands, purge_conversation/);
      assert.match(checks('database.app-role').detail, /anyone may run purge_conversation/);
      assert.match(checks('database.app-role').detail, /purge_conversation has no fixed search_path/);
      assert.deepEqual(checks('database.migrations'), { ok: false, detail: 'applied without a file 9999' });
    } finally {
      await owner`REVOKE UPDATE ON events FROM arianna_app`;
      await owner`REVOKE DELETE ON jobs FROM arianna_app`;
      await owner`DROP TABLE forgotten`;
      await owner`DELETE FROM schema_migrations WHERE version = '9999'`;
      await owner`REVOKE INSERT ON schema_migrations FROM arianna_app`;
      await owner`DROP SEQUENCE orphan_seq`;
      await owner`DROP FUNCTION owner_hands()`;
      await owner`DROP FUNCTION purge_conversation(text)`;
      await owner`REVOKE EXECUTE ON FUNCTION purge_conversation(uuid) FROM PUBLIC`;
      await owner.unsafe(`ALTER FUNCTION purge_conversation(uuid) SET search_path = ${schema}, pg_temp`);
      await owner.unsafe(`REVOKE CREATE ON SCHEMA ${schema} FROM arianna_app`);
      await owner.unsafe(`REVOKE TEMPORARY ON DATABASE ${config.database.name} FROM arianna_app`);
    }
    assert.equal(byId(await runDoctor({ config, schema }))('database.app-role').ok, true);
  });
});
