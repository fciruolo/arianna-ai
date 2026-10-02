import postgres from 'postgres';

import type { AriannaConfig } from '@arianna/config';

import { passwordOf, type DbLogin } from './logins.ts';

export type Sql = postgres.Sql;
/** A connection pool or an open transaction. */
export type Queryable = postgres.Sql | postgres.TransactionSql;

export interface ConnectOptions {
  /** Schema to work in instead of `public`; used by tests for isolation. */
  schema?: string;
}

/** Connects as `login`: the owner for migrations and setup, the application role for everything else. */
export function connect(config: AriannaConfig, login: DbLogin, options: ConnectOptions = {}): Sql {
  return postgres({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    username: login.user,
    // Read at each new connection, so the value is not copied into the options.
    password: () => passwordOf(login),
    max: 5,
    onnotice: () => undefined,
    ...(options.schema === undefined ? {} : { connection: { search_path: options.schema } }),
  });
}
