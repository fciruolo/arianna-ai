import { randomBytes } from 'node:crypto';
import { after, before } from 'node:test';

import { loadConfig } from '@arianna/config';

import { connect, type Sql } from '../../src/db/client.ts';
import { prepareDatabase, resolveLogins } from '../../src/db/logins.ts';

export interface TestDatabase {
  /** As the application role, like the core (D-046). */
  sql: Sql;
  /** As the owner of the schema: for tests that alter tables or check triggers below the grants. */
  owner: Sql;
  schema: string;
  /** Drops the schema and closes the connections. */
  close: () => Promise<void>;
}

// Test files run in parallel against one cluster, and migrations touch what is
// shared by every schema: the arianna_app role and its database-wide grants.
const CLUSTER_LOCK = 'arianna.test-cluster';

/**
 * Runs `work` while no other test file migrates: for tests that change a role
 * or a database-wide grant that 0007_app_role.sql would reset under them.
 */
export async function withClusterLock<T>(owner: Sql, work: () => Promise<T>): Promise<T> {
  const lock = await owner.reserve();
  try {
    await lock`SELECT pg_advisory_lock(hashtext(${CLUSTER_LOCK}))`;
    try {
      return await work();
    } finally {
      await lock`SELECT pg_advisory_unlock(hashtext(${CLUSTER_LOCK}))`;
    }
  } finally {
    lock.release();
  }
}

/** A throwaway schema with every migration applied from zero. Needs `pnpm db:up`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const config = loadConfig();
  const logins = await resolveLogins(config);
  const schema = `test_${randomBytes(6).toString('hex')}`;

  const admin = connect(config, logins.owner);
  const owner = connect(config, logins.owner, { schema });
  const sql = connect(config, logins.app, { schema });
  const close = async (): Promise<void> => {
    await sql.end();
    await owner.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };

  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    await withClusterLock(owner, () => prepareDatabase(owner, logins.app));
  } catch (error) {
    // Leave no schema and no open socket behind, or the test run would hang.
    await close().catch(() => undefined);
    throw error;
  }
  return { sql, owner, schema, close };
}

/** Registers setup and teardown for the calling test file; call the result inside tests. */
export function useTestDatabase(): () => TestDatabase {
  let db: TestDatabase | undefined;
  before(async () => {
    db = await createTestDatabase();
  });
  after(async () => {
    await db?.close();
  });
  return () => {
    if (db === undefined) throw new Error('the test database is not ready');
    return db;
  };
}
