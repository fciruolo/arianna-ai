// Runs `docker compose` with the values of config/arianna.toml, so that ports and
// paths have a single source of truth.
// Usage: node scripts/compose.ts up -d --wait
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { loadConfig } from '@arianna/config';

const config = loadConfig();

const result = spawnSync(
  'docker',
  [
    'compose',
    '--project-directory',
    config.home,
    '--file',
    join(config.home, 'compose.yaml'),
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ARIANNA_DATA_DIR: config.paths.data,
      ARIANNA_DB_PORT: String(config.database.port),
      ARIANNA_DB_NAME: config.database.name,
      ARIANNA_DB_USER: config.database.user,
    },
  },
);

if (result.error !== undefined) console.error(`docker compose: ${result.error.message}`);
process.exitCode = result.status ?? 1;
