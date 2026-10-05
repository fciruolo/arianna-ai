// Runs `docker compose` with the values of config/arianna.toml, so that ports and
// paths have a single source of truth.
// Usage: node scripts/compose.ts up -d --wait
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { loadConfig } from '@arianna/config';

import { composeGuard } from './compose-guard.ts';

const config = loadConfig();

/** The folder git names for `flag`; null outside a repository or without git (an installation copied without .git). */
const git = (flag: string): string | null => {
  try {
    return resolve(config.home, execFileSync('git', ['rev-parse', flag], { cwd: config.home, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
};
const guard = composeGuard(git('--git-dir'), git('--git-common-dir'), process.argv.slice(2));
if (!guard.run) {
  console.error(guard.message);
  process.exit(guard.exitCode);
}

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
