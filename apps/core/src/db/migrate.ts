import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Sql } from './client.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// A migration runs inside the runner's transaction and must not end it.
const TRANSACTION_CONTROL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im;

export interface Migration {
  /** Four digits; migrations are applied in this order. */
  version: string;
  name: string;
  sql: string;
  sha256: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

/** Reads `NNNN_name.sql` files, sorted by version. Forward-only: there are no down migrations. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = FILE_NAME.exec(file);
      const version = match?.[1];
      const name = match?.[2];
      if (version === undefined || name === undefined) {
        throw new MigrationError(`${file}: expected a name like 0001_description.sql`);
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      if (TRANSACTION_CONTROL.test(sql)) {
        throw new MigrationError(`${file}: BEGIN, COMMIT and ROLLBACK are not allowed in a migration`);
      }
      return { version, name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    });

  const versions = migrations.map((migration) => migration.version);
  const duplicate = versions.find((version, index) => versions.indexOf(version) !== index);
  if (duplicate !== undefined) throw new MigrationError(`duplicate migration version ${duplicate}`);
  return migrations;
}

/**
 * Applies the pending migrations in one transaction and returns their versions.
 * Fails if a migration that was already applied has been edited or removed.
 */
export async function migrate(sql: Sql, migrations: Migration[]): Promise<string[]> {
  const connection = await sql.reserve();
  try {
    await connection`BEGIN`;
    // Serializes concurrent migrators until the transaction ends.
    await connection`SELECT pg_advisory_xact_lock(hashtext('arianna.migrations'))`;
    await connection`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const applied = await connection<{ version: string; sha256: string }[]>`
      SELECT version, sha256 FROM schema_migrations ORDER BY version`;

    for (const row of applied) {
      const known = migrations.find((migration) => migration.version === row.version);
      if (known === undefined) {
        throw new MigrationError(`migration ${row.version} is applied but its file is missing`);
      }
      if (known.sha256 !== row.sha256) {
        throw new MigrationError(
          `migration ${row.version} was edited after being applied; add a new migration instead`,
        );
      }
    }

    const done = new Set(applied.map((row) => row.version));
    const pending = migrations.filter((migration) => !done.has(migration.version));
    const lastApplied = applied.at(-1)?.version;
    if (lastApplied !== undefined) {
      const outOfOrder = pending.find((migration) => migration.version < lastApplied);
      if (outOfOrder !== undefined) {
        throw new MigrationError(
          `migration ${outOfOrder.version} is older than ${lastApplied}, which is already applied`,
        );
      }
    }
    for (const migration of pending) {
      await connection.unsafe(migration.sql);
      await connection`
        INSERT INTO schema_migrations (version, name, sha256)
        VALUES (${migration.version}, ${migration.name}, ${migration.sha256})`;
    }
    await connection`COMMIT`;
    return pending.map((migration) => migration.version);
  } catch (error) {
    try {
      await connection`ROLLBACK`;
    } catch {
      // Connection lost: the server rolls back on its own. Keep the original error.
    }
    throw error;
  } finally {
    connection.release();
  }
}
