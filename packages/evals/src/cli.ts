// Usage: node packages/evals/src/cli.ts <deterministic|models|live>
// Prints a report, saves it as JSON under data/evals/, exits 1 when a threshold is missed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, DATA_DIR, loadConfig, resolveHome } from '@arianna/config';

import { loadCases } from './cases.ts';
import { GROUPS } from './groups.ts';
import { formatReport } from './report.ts';
import { runTier } from './runner.ts';
import { TIERS } from './types.ts';

const tier = TIERS.find((candidate) => candidate === process.argv[2]);
if (tier === undefined) {
  console.error(`Usage: cli.ts <${TIERS.join('|')}>`);
  process.exit(2);
}

// The deterministic evals run in `pnpm check`, also on a fresh clone without
// config/arianna.toml: the configuration only says where to save the report.
const home = resolveHome();
const data = existsSync(join(home, CONFIG_FILE)) ? loadConfig().paths.data : join(home, DATA_DIR);
const report = await runTier(tier, GROUPS, (group) => loadCases(join(home, 'evals', group)));

const reportDir = join(data, 'evals');
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, `report-${tier}.json`), `${JSON.stringify(report, null, 2)}\n`);

console.log(formatReport(report));
process.exitCode = report.ok ? 0 : 1;
