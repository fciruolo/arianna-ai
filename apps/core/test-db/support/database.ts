import { randomBytes } from 'node:crypto';
import { after, before } from 'node:test';

import { loadConfig } from '@arianna/config';

import { connect, type Sql } from '../../src/db/client.ts';
import { loadMigrations, migrate } from '../../src/db/migrate.ts';

export interface TestDatabase {
  sql: Sql;
  schema: string;
  /** Drops the schema and closes the connections. */
  close: () => Promise<void>;
}

/** A throwaway schema with every migration applied from zero. Needs `pnpm db:up`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const config = loadConfig();
  const schema = `test_${randomBytes(6).toString('hex')}`;

  const admin = connect(config);
  const sql = connect(config, process.env, { schema });
  const close = async (): Promise<void> => {
    await sql.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };

  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    await migrate(sql, loadMigrations());
  } catch (error) {
    // Leave no schema and no open socket behind, or the test run would hang.
    await close().catch(() => undefined);
    throw error;
  }
  return { sql, schema, close };
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
