// Usage: node packages/evals/src/cli.ts <deterministic|models|live>
// Prints a report, saves it as JSON under data/evals/, exits 1 when a threshold is missed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '@arianna/config';

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

const config = loadConfig();
const report = await runTier(tier, GROUPS, (group) => loadCases(join(config.home, 'evals', group)));

const reportDir = join(config.paths.data, 'evals');
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, `report-${tier}.json`), `${JSON.stringify(report, null, 2)}\n`);

console.log(formatReport(report));
process.exitCode = report.ok ? 0 : 1;
