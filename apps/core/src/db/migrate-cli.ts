// Usage: node apps/core/src/db/migrate-cli.ts
// Applies the pending migrations to the database of config/arianna.toml.
import { loadConfig } from '@arianna/config';

import { connect } from './client.ts';
import { loadMigrations, migrate } from './migrate.ts';

const sql = connect(loadConfig());
try {
  const applied = await migrate(sql, loadMigrations());
  console.log(applied.length === 0 ? 'Database is up to date.' : `Applied: ${applied.join(', ')}`);
} finally {
  await sql.end();
}
