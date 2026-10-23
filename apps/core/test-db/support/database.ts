import { randomBytes } from 'node:crypto';
import { after, before } from 'node:test';

import { loadConfig } from '@arianna/config';
import { piiReport } from '@arianna/policy';

import { connect, type Sql } from '../../src/db/client.ts';
import { prepareDatabase, resolveLogins } from '../../src/db/logins.ts';
import { configurePiiGuard } from '../../src/pii-guard.ts';
import { createTeardown } from '../../test/support/teardown.ts';

// The second scanner (D-113) finds nothing in these tests: they are about
// everything else. pii-gateway.test.ts sets its own fake service.
configurePiiGuard({ state: 'ready', warm: () => Promise.resolve(true), scan: (texts) => Promise.resolve(piiReport(texts, texts.map(() => []))), stop: () => Promise.resolve() });

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
 * Time the setup of a file may take. Migrating waits for CLUSTER_LOCK, held in
 * turn by every file of every run on this cluster: with other runs at work the
 * wait goes well past the minute of `--test-timeout`, and the file would fail
 * before its first test.
 */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
/** Time the teardown may take: dropping a schema waits for the migrations of the others too. */
export const TEARDOWN_TIMEOUT_MS = 5 * 60_000;
/** Time one close may take: below the hook's, so that a close that hangs is the error reported. */
export const CLOSE_TIMEOUT_MS = TEARDOWN_TIMEOUT_MS - 30_000;
/** Seconds `end` waits for running queries before it closes the sockets anyway. */
const END_SECONDS = 10;

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
  // Every pool is ended whatever happens to the others: an open socket keeps the test process alive.
  const close = async (): Promise<void> => {
    try {
      await sql.end({ timeout: END_SECONDS });
    } finally {
      try {
        await owner.end({ timeout: END_SECONDS });
      } finally {
        try {
          await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.end({ timeout: END_SECONDS });
        }
      }
    }
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

/**
 * Registers setup and teardown for the calling test file; call the result inside tests.
 * A setup that ends after the teardown (its hook timed out) closes what it opened.
 */
export function useTestDatabase(): () => TestDatabase {
  let db: TestDatabase | undefined;
  const teardown = createTeardown(CLOSE_TIMEOUT_MS);
  before(
    async () => {
      db = await teardown.keep(await createTestDatabase(), (opened) => opened.close());
    },
    { timeout: SETUP_TIMEOUT_MS },
  );
  after(() => teardown.closeAll(), { timeout: TEARDOWN_TIMEOUT_MS });
  return () => {
    if (db === undefined) throw new Error('the test database is not ready');
    return db;
  };
}
