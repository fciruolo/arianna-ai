// Usage: node packages/evals/src/cli.ts <deterministic|models|live> [--model <catalog id> | --tag <tag>]
// Prints a report, saves it as JSON under data/evals/, exits 1 when a threshold is missed.
// With --tag only the cases carrying that tag run, e.g. `live --tag codex` to
// spend the quota of one executor only (D-138); the report is
// report-<tier>-<tag>.json.
// With --model (tier models only, D-081) the orchestrator runs on that catalog
// model, `local-large` on the configured endpoints, and the report is
// report-models-<id>.json.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, DATA_DIR, loadCatalog, loadConfig, resolveHome } from '@arianna/config';
import { createLocalModel } from '@arianna/executors';

import { loadCases } from './cases.ts';
import { GROUPS } from './groups.ts';
import { createOrchestratorGroup } from './orchestrator-group.ts';
import { formatReport } from './report.ts';
import { runTier } from './runner.ts';
import { trialEndpoints } from './trial.ts';
import { TIERS } from './types.ts';

const [tierArg, flag, value, ...rest] = process.argv.slice(2);
const tier = TIERS.find((candidate) => candidate === tierArg);
const usage = `Usage: cli.ts <${TIERS.join('|')}> [--model <catalog id> | --tag <tag>]`;
const badFlag = flag !== undefined && (value === undefined || (flag === '--model' ? tier !== 'models' : flag !== '--tag'));
if (tier === undefined || rest.length > 0 || badFlag) {
  console.error(usage);
  process.exit(2);
}
const modelId = flag === '--model' ? value : undefined;
const tag = flag === '--tag' ? value : undefined;

// The deterministic evals run in `pnpm check`, also on a fresh clone without
// config/arianna.toml: the configuration only says where to save the report.
const home = resolveHome();
const data = existsSync(join(home, CONFIG_FILE)) ? loadConfig().paths.data : join(home, DATA_DIR);
let groups = GROUPS;
if (modelId !== undefined) {
  const config = loadConfig();
  const entry = loadCatalog(home).models.find((model) => model.id === modelId);
  if (entry?.roles.includes('orchestrator') !== true) {
    console.error(`${modelId}: not a catalog model for the orchestrator role (config/models.catalog.yaml)`);
    process.exit(2);
  }
  const endpoints = trialEndpoints(config.local.endpoints, modelId);
  if (endpoints.length === 0) {
    console.error('no [[local.endpoints]] in config/arianna.toml');
    process.exit(2);
  }
  const candidate = createOrchestratorGroup({ model: createLocalModel({ endpoints }) });
  groups = GROUPS.map((group) => (group.name === 'orchestrator' ? candidate : group));
}
if (tag !== undefined) {
  // A group left without cases is not run, rather than failed for having none.
  groups = groups.filter((group) => group.tier !== tier || loadCases(join(home, 'evals', group.name)).some((evalCase) => evalCase.tags.includes(tag)));
  if (!groups.some((group) => group.tier === tier)) {
    console.error(`no ${tier} case carries the tag ${tag}`);
    process.exit(2);
  }
}
const report = await runTier(tier, groups, (group) => loadCases(join(home, 'evals', group)).filter((evalCase) => tag === undefined || evalCase.tags.includes(tag)));

const reportDir = join(data, 'evals');
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, `report-${tier}${modelId === undefined ? '' : `-${modelId}`}${tag === undefined ? '' : `-${tag}`}.json`), `${JSON.stringify(report, null, 2)}\n`);

console.log(formatReport(report));
process.exitCode = report.ok ? 0 : 1;
