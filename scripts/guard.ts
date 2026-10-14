// The Python environment of apps/guard (D-113), always inside data/guard.
// Usage: node scripts/guard.ts sync | lock | test | trial
//   sync   builds data/guard/venv from uv.lock exactly (pnpm guard:sync)
//   lock   updates uv.lock after a change of pyproject.toml (pnpm guard:lock)
//   test   runs the Python tests in that environment (pnpm test:guard)
//   trial  measures Rizzo-PII on the invented sentences of apps/guard/eval and
//          writes data/evals/report-guard.json (pnpm guard:trial)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, DATA_DIR, guardPaths, loadCatalog, loadConfig, modelFolderText, modelPath, resolveHome, uvEnvironment, type CatalogEntry } from '@arianna/config';

import { guardEnv } from '../apps/core/src/pii-guard.ts';

const command = process.argv[2];
const extra = process.argv.slice(3);
if (!['sync', 'lock', 'test', 'trial'].includes(command ?? '') || extra.length > 0) {
  console.error('usage: node scripts/guard.ts sync | lock | test | trial');
  process.exit(2);
}

// Everything works before arianna.toml exists, with the default data/.
const config = existsSync(join(resolveHome(), CONFIG_FILE)) ? loadConfig() : undefined;
const home = config?.home ?? resolveHome();
const data = config?.paths.data ?? join(home, DATA_DIR);
const paths = guardPaths(home, data);
// uv gets a short environment: no secret of the shell reaches it.
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SSL_CERT_FILE'];
const base = Object.fromEntries(INHERITED.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
mkdirSync(paths.uvCache, { recursive: true, mode: 0o700 });

function run(file: string, args: string[], env: Record<string, string>): number {
  const result = spawnSync(file, args, { stdio: 'inherit', cwd: paths.project, env });
  if (result.error !== undefined) {
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    console.error(missing && file === 'uv' ? 'uv is not installed: brew install uv (D-066)' : `${file}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * The cage of the Python process that reads the texts (D-113): a clean
 * environment, a proxy that goes nowhere, Hugging Face and transformers
 * offline, the caches inside data/guard. The weights come from the catalog.
 */
function cage(): Record<string, string> {
  return guardEnv(process.env, paths);
}

function needVenv(): void {
  if (!existsSync(paths.python)) {
    console.error('data/guard/venv is missing: pnpm guard:sync');
    process.exit(1);
  }
}

/** The model of the `pii` role, or the first catalog entry suited to it; its folder comes from the catalog (D-203). */
function piiModel(): CatalogEntry {
  const assigned = config?.roles.pii;
  const candidates = loadCatalog(home).models.filter((model) => model.roles.includes('pii'));
  const chosen = assigned === undefined ? candidates[0] : candidates.find((model) => model.id === assigned);
  if (chosen === undefined) {
    console.error(assigned === undefined ? 'config/models.catalog.yaml: no model has the pii role' : `${assigned}: not a pii model of config/models.catalog.yaml`);
    process.exit(1);
  }
  return chosen;
}

if (command === 'sync') {
  process.exitCode = run('uv', ['sync', '--frozen', '--no-install-project'], { ...base, ...uvEnvironment(paths) });
} else if (command === 'lock') {
  // UV_NO_CONFIG also hides [tool.uv] of pyproject.toml: its exclude-newer is passed by hand.
  const excludeNewer = /^exclude-newer = "([^"]+)"$/m.exec(readFileSync(join(paths.project, 'pyproject.toml'), 'utf8'))?.[1];
  if (excludeNewer === undefined) {
    console.error('apps/guard/pyproject.toml: exclude-newer is missing from [tool.uv]');
    process.exit(1);
  }
  process.exitCode = run('uv', ['lock', '--exclude-newer', excludeNewer], { ...base, ...uvEnvironment(paths) });
} else if (command === 'test') {
  needVenv();
  // The tests of the real model run only when its weights are on disk.
  process.exitCode = run(paths.python, ['-m', 'unittest', 'discover', '-s', 'tests'], { ...cage(), ARIANNA_GUARD_MODEL: modelPath(data, piiModel()) });
} else {
  needVenv();
  const entry = piiModel();
  const model = modelPath(data, entry);
  if (!existsSync(join(model, 'model.safetensors'))) {
    console.error(`${modelFolderText(entry)} is missing: assign the pii role in config/arianna.toml, then pnpm arianna:models pull`);
    process.exit(1);
  }
  mkdirSync(paths.evals, { recursive: true, mode: 0o700 });
  const cases = join(paths.project, 'eval', 'cases.json');
  const report = join(paths.evals, 'report-guard.json');
  process.exitCode = run(paths.python, ['-m', 'arianna_guard.trial', '--model', model, '--cases', cases, '--out', report], cage());
}
