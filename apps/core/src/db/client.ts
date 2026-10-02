import postgres from 'postgres';

import type { AriannaConfig } from '@arianna/config';

export type Sql = postgres.Sql;
/** A connection pool or an open transaction. */
export type Queryable = postgres.Sql | postgres.TransactionSql;

// Development default for a local database that holds fake data only and listens
// on loopback. ARIANNA_DB_PASSWORD overrides it; the real secret comes with the
// vault (task 1.14).
const DEV_PASSWORD = 'arianna_dev';

export interface ConnectOptions {
  /** Schema to work in instead of `public`; used by tests for isolation. */
  schema?: string;
}

export function connect(
  config: AriannaConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ConnectOptions = {},
): Sql {
  return postgres({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    username: config.database.user,
    password: env.ARIANNA_DB_PASSWORD ?? DEV_PASSWORD,
    max: 5,
    onnotice: () => undefined,
    ...(options.schema === undefined ? {} : { connection: { search_path: options.schema } }),
  });
}
