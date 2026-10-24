// Usage: node packages/evals/src/memory-cli.ts [--candidate <id>]
// Runs the memory protocol of docs/MEMORIA-CONFRONTO.md on evals/memory/ with
// one candidate (default `fake`, D-307), prints a summary, saves the report as
// data/evals/report-memory-<id>.json and exits 1 when a privacy check fails.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, DATA_DIR, loadConfig, resolveHome } from '@arianna/config';

import { casesFingerprint } from './cases.ts';
import { loadMemoryCases } from './memory/cases.ts';
import { NO_JUDGE } from './memory/check.ts';
import { createFakeMemory } from './memory/fake.ts';
import { formatMemoryReport, runMemoryEval } from './memory/run.ts';
import type { MemoryAdapter } from './memory/types.ts';

/** The candidates the protocol can run; Graphiti, Hindsight and ours come with step (c). */
const CANDIDATES = new Map<string, () => MemoryAdapter>([
  ['fake', createFakeMemory],
]);

const args = process.argv.slice(2);
const candidateId = args.length === 0 ? 'fake' : args[0] === '--candidate' && args.length === 2 ? args[1] : undefined;
const create = candidateId === undefined ? undefined : CANDIDATES.get(candidateId);
if (candidateId === undefined || create === undefined) {
  console.error(`Usage: memory-cli.ts [--candidate <${[...CANDIDATES.keys()].join('|')}>]`);
  process.exit(2);
}

const home = resolveHome();
const data = existsSync(join(home, CONFIG_FILE)) ? loadConfig().paths.data : join(home, DATA_DIR);
const casesDir = join(home, 'evals', 'memory');
const { world, questions } = loadMemoryCases(casesDir);
const report = await runMemoryEval(create(), world, questions, { judge: NO_JUDGE, cases: casesFingerprint(casesDir) });

const reportDir = join(data, 'evals');
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, `report-memory-${candidateId}.json`), `${JSON.stringify(report, null, 2)}\n`);

console.log(formatMemoryReport(report));
process.exitCode = report.ok ? 0 : 1;
