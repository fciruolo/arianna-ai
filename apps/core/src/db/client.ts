import postgres from 'postgres';

import type { AriannaConfig } from '@arianna/config';

import { passwordOf, type DbLogin } from './logins.ts';

export type Sql = postgres.Sql;
/** A connection pool or an open transaction. */
export type Queryable = postgres.Sql | postgres.TransactionSql;
/** An open transaction: savepoints are there. */
export type TransactionSql = postgres.TransactionSql;

export interface ConnectOptions {
  /** Schema to work in instead of `public`; used by tests for isolation. */
  schema?: string;
}

/**
 * The schema of the tables first, then `extensions`, where migration 0092
 * keeps pgvector (D-308): `vector`, its operators and operator classes need
 * no schema in front. Without `schema` the default of PostgreSQL, `"$user",
 * public`, then `extensions`.
 */
export function searchPath(schema?: string): string {
  return `${schema ?? '"$user", public'}, extensions`;
}

/** Connections of the pool of `connect`. */
export const POOL_MAX = 5;

/** Connects as `login`: the owner for migrations and setup, the application role for everything else. */
export function connect(config: AriannaConfig, login: DbLogin, options: ConnectOptions = {}): Sql {
  return postgres({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    username: login.user,
    // Read at each new connection, so the value is not copied into the options.
    password: () => passwordOf(login),
    max: POOL_MAX,
    onnotice: () => undefined,
    connection: { search_path: searchPath(options.schema) },
  });
}
