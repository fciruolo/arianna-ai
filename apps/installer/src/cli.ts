// Usage: node apps/installer/src/cli.ts <command>
//   init [--reconfigure|--defaults]  the wizard that writes config/arianna.toml
//   install                   prerequisites, data/ layout, models, database, doctor
//   doctor                    is this installation ready for real data? (exit 1 if not)
//   models list|verify|pull   compare data/models with the models assigned to a role
//                             (pull --trial: also the candidates of the voice trial page)
// (tasks 1.17 and 1.18, docs/INSTALLER-PORTABILITY.md). Credentials of Claude
// Code and Codex are never touched: their login stays manual.
import { spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  DEFAULT_SETTINGS,
  loadCatalog,
  loadConfig,
  parseProjects,
  resolveHome,
  userHomeOf,
  voicePaths,
  type AriannaConfig,
  type CatalogEntry,
} from '@arianna/config';
import { runDoctor, type DoctorCheck } from '@arianna/core/doctor';

import { createFetcher } from './http.ts';
import { configPath, currentSettings, installedExecutors, writeSettings } from './init.ts';
import { MODELS_DIR, modelStatus, pullModels, selectedModels, type FileStatus } from './models.ts';
import { folderProblem, projectChecks, syncProjectLinks } from './projects.ts';
import { ensureLayout, freeBytes, layoutCheck, systemChecks, voiceCheck } from './system.ts';
import { runWizard, type Prompter } from './wizard.ts';

// Room left on the disk after the downloads, for the database and the archive.
const SPARE_BYTES = 10 * 2 ** 30;

function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

function print(checks: DoctorCheck[]): number {
  const width = Math.max(...checks.map((check) => check.id.length));
  for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.id.padEnd(width)}  ${check.detail}`);
  return checks.filter((check) => !check.ok).length;
}

function selected(config: AriannaConfig, trial = false): CatalogEntry[] {
  return selectedModels(config, loadCatalog(config.home), { trial });
}

async function modelsChecks(config: AriannaConfig): Promise<DoctorCheck[]> {
  const models = selected(config);
  if (models.length === 0) return [{ id: 'models', ok: true, detail: 'no model assigned to a role yet (pnpm arianna:init)' }];
  const statuses = await modelStatus(models, config.paths.data);
  const absent = statuses.filter((status) => status.state !== 'present');
  const ram = models.reduce((sum, model) => sum + model.ramMinGib, 0);
  const machine = Math.floor(totalmem() / 2 ** 30);
  return [
    {
      id: 'models',
      ok: absent.length === 0,
      detail:
        absent.length === 0
          ? `${String(statuses.length)} file(s) present with the right size (pnpm arianna:models verify checks the hashes)`
          : `${String(absent.length)} of ${String(statuses.length)} file(s) missing or wrong: pnpm arianna:models pull`,
    },
    {
      id: 'models.ram',
      ok: ram <= machine,
      detail: `the assigned models need ${String(ram)} GiB together, this machine has ${String(machine)} GiB`,
    },
  ];
}

async function doctor(config: AriannaConfig): Promise<number> {
  const checks = [
    ...(await systemChecks({ voice: config.voice !== undefined })),
    ...layoutCheck(config.home, config.paths.data),
    ...(config.voice === undefined ? [] : [voiceCheck(voicePaths(config.home, config.paths.data).python)]),
    ...(await modelsChecks(config)),
    ...projectChecks(config.home, config.projects),
    ...(await runDoctor({ config })),
  ];
  const failed = print(checks);
  console.log(failed === 0 ? '\nReady for real data.' : `\n${String(failed)} check(s) failed: not ready for real data.`);
  return failed === 0 ? 0 : 1;
}

function describe(status: FileStatus): string {
  return `${status.state.padEnd(10)}  ${status.model}/${status.file.path}  ${gib(status.file.sizeBytes)}`;
}

async function pull(config: AriannaConfig, verify = false, trial = false): Promise<void> {
  // Also makes data/ private before anything is written in it.
  ensureLayout(config.paths.data);
  const models = selected(config, trial);
  const needed = (await modelStatus(models, config.paths.data))
    .filter((status) => status.state !== 'present')
    .reduce((sum, status) => sum + status.file.sizeBytes, 0);
  const free = freeBytes(join(config.paths.data, MODELS_DIR));
  if (needed + SPARE_BYTES > free) {
    throw new Error(`not enough disk: ${gib(needed)} to download plus ${gib(SPARE_BYTES)} spare, ${gib(free)} free`);
  }
  let last = 0;
  const pulled = await pullModels(models, config.paths.data, {
    verify,
    fetch: createFetcher(),
    onProgress: (status, bytes) => {
      const now = Date.now();
      if (now - last < 2000 && bytes !== status.file.sizeBytes) return;
      last = now;
      console.log(`${status.model}/${status.file.path}: ${gib(bytes)} of ${gib(status.file.sizeBytes)}`);
    },
  });
  if (models.length === 0) console.log('No model assigned to a role yet (pnpm arianna:init).');
  else console.log(pulled.length === 0 ? 'Every model is present.' : `Downloaded and verified: ${String(pulled.length)} file(s).`);
}

/** Runs a script of this repository with the same Node; stops install on failure. */
function step(config: AriannaConfig, script: string, args: string[] = []): void {
  const result = spawnSync(process.execPath, [join(config.home, script), ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${script} failed`);
}

async function install(config: AriannaConfig): Promise<number> {
  console.log('Prerequisites');
  const system = await systemChecks({ voice: config.voice !== undefined });
  print(system);
  // sops and age serve the vault, which a first installation does not need yet.
  const blocking = system.filter((check) => !check.ok && !['system.sops', 'system.age'].includes(check.id));
  if (blocking.length > 0) {
    console.error('\nInstall what is missing, then run pnpm arianna:install again.');
    return 1;
  }
  const created = ensureLayout(config.paths.data);
  console.log(`\nFolders: ${created.length === 0 ? 'already in place' : `created or fixed ${created.join(', ')}`}`);
  console.log('\nModels');
  await pull(config);
  if (config.voice !== undefined) {
    console.log('\nVoice (Python environment in data/voice)');
    step(config, 'scripts/voice.ts', ['sync']);
  }
  console.log('\nDatabase');
  step(config, 'scripts/compose.ts', ['up', '--detach', '--wait']);
  step(config, 'apps/core/src/db/migrate-cli.ts');
  console.log('\nDoctor');
  return doctor(config);
}

/** Lines are queued, so answers typed or pasted ahead are not lost. */
function terminal(): Prompter & { close(): void } {
  const lines = createInterface({ input: stdin, terminal: false });
  const next = lines[Symbol.asyncIterator]();
  return {
    say: (text) => {
      console.log(text);
    },
    ask: async (question) => {
      stdout.write(question);
      const line = await next.next();
      if (line.done === true) throw new Error('input closed before the last answer: nothing was written');
      return line.value.trim();
    },
    close: () => {
      lines.close();
    },
  };
}

/** The wizard; `true` when config/arianna.toml was written. */
async function init(mode: 'first' | 'reconfigure' | 'defaults'): Promise<boolean> {
  const home = resolveHome();
  const catalog = loadCatalog(home);
  const current = currentSettings(home, catalog);
  if (current !== undefined && mode !== 'reconfigure') {
    console.error(`${configPath(home)} already exists: pnpm arianna:init --reconfigure changes it, after a confirmation.`);
    return false;
  }
  if (mode === 'defaults') {
    writeSettings(home, catalog, DEFAULT_SETTINGS);
    console.log('Written config/arianna.toml with the development defaults (fake data only).');
    return true;
  }
  if (!stdin.isTTY) throw new Error('the wizard asks questions: run it in a terminal (or pnpm arianna:init --defaults)');
  const io = terminal();
  try {
    const settings = await runWizard(io, {
      catalog,
      settings: current ?? DEFAULT_SETTINGS,
      home,
      freeBytes: freeBytes(home),
      ramBytes: totalmem(),
      installed: installedExecutors(),
      userHome: userHomeOf(),
      checkFolder: (absolute, name) => folderProblem(absolute, home, name),
    });
    if (settings === undefined) {
      console.log('Nulla è stato scritto.');
      return false;
    }
    writeSettings(home, catalog, settings);
    console.log('Scritto config/arianna.toml. Un core avviato applica subito modelli e progetti; il resto al riavvio.');
    const userHome = userHomeOf();
    for (const line of syncProjectLinks(home, parseProjects(current?.projects ?? [], home, userHome), parseProjects(settings.projects, home, userHome))) {
      console.log(line);
    }
    return true;
  } finally {
    io.close();
  }
}

const [command, sub, flag, ...extra] = process.argv.slice(2);
try {
  if (extra.length > 0 || (command === 'init' && flag !== undefined)) {
    console.error('usage: cli.ts init [--reconfigure|--defaults] | install | doctor | models list | models verify | models pull [--verify|--trial]');
    process.exitCode = 2;
  } else if (command === 'init' && (sub === undefined || sub === '--reconfigure' || sub === '--defaults')) {
    const written = await init(sub === undefined ? 'first' : sub === '--reconfigure' ? 'reconfigure' : 'defaults');
    if (written && sub !== '--defaults') console.log('Prossimo passo: pnpm arianna:install (modelli, database, doctor).');
    process.exitCode = written ? 0 : 1;
  } else if (command === 'install') {
    // A first installation starts from the questions.
    if (currentSettings(resolveHome(), loadCatalog(resolveHome())) === undefined && !(await init('first'))) process.exitCode = 1;
    else process.exitCode = await install(loadConfig());
  } else if (command === 'doctor') process.exitCode = await doctor(loadConfig());
  else if (command === 'models' && (sub === 'list' || sub === 'verify')) {
    const config = loadConfig();
    const statuses = await modelStatus(selected(config), config.paths.data, { hash: sub === 'verify' });
    for (const status of statuses) console.log(describe(status));
    if (statuses.length === 0) console.log('No model assigned to a role yet (pnpm arianna:init).');
    process.exitCode = statuses.every((status) => status.state === (sub === 'verify' ? 'ok' : 'present')) ? 0 : 1;
  } else if (command === 'models' && sub === 'pull' && (flag === undefined || flag === '--verify' || flag === '--trial')) {
    await pull(loadConfig(), flag === '--verify', flag === '--trial');
  } else {
    console.error('usage: cli.ts init [--reconfigure|--defaults] | install | doctor | models list | models verify | models pull [--verify|--trial]');
    process.exitCode = 2;
  }
} catch (error) {
  // Our errors name a file and a code; anything else only its class.
  console.error(error instanceof Error && ['ModelError', 'Error', 'ConfigError', 'VaultError', 'LoginError'].includes(error.name) ? error.message : 'unexpected error');
  process.exitCode = 1;
}
