// Usage: node apps/core/src/db/migrate-cli.ts
// Applies the pending migrations to the database of config/arianna.toml and
// lets the application role log in with its password (D-046).
import { loadConfig } from '@arianna/config';

import { connect } from './client.ts';
import { prepareDatabase, resolveLogins } from './logins.ts';

const config = loadConfig();
const logins = await resolveLogins(config);
const owner = connect(config, logins.owner);
try {
  const applied = await prepareDatabase(owner, logins.app);
  console.log(applied.length === 0 ? 'Database is up to date.' : `Applied: ${applied.join(', ')}`);
} finally {
  await owner.end();
}
