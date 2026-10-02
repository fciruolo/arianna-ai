// Usage: node apps/installer/src/cli.ts <command>
//   install                   prerequisites, data/ layout, models, database, doctor
//   doctor                    is this installation ready for real data? (exit 1 if not)
//   models list|verify|pull   compare data/models with the manifest; verify reads every byte
// (task 1.17, docs/INSTALLER-PORTABILITY.md). Credentials of Claude Code and
// Codex are never touched: their login stays manual.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { loadConfig, loadManifest, type AriannaConfig } from '@arianna/config';
import { runDoctor, type DoctorCheck } from '@arianna/core/doctor';

import { createFetcher } from './http.ts';
import { MODELS_DIR, modelStatus, pullModels, type FileStatus } from './models.ts';
import { ensureLayout, freeBytes, layoutCheck, systemChecks } from './system.ts';

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

async function modelsCheck(config: AriannaConfig): Promise<DoctorCheck> {
  const statuses = await modelStatus(loadManifest(config.home), config.paths.data);
  if (statuses.length === 0) return { id: 'models', ok: true, detail: 'the manifest lists no model yet' };
  const absent = statuses.filter((status) => status.state !== 'present');
  return {
    id: 'models',
    ok: absent.length === 0,
    detail:
      absent.length === 0
        ? `${String(statuses.length)} file(s) present with the right size (pnpm arianna:models verify checks the hashes)`
        : `${String(absent.length)} of ${String(statuses.length)} file(s) missing or wrong: pnpm arianna:models pull`,
  };
}

async function doctor(config: AriannaConfig): Promise<number> {
  const checks = [
    ...(await systemChecks()),
    ...layoutCheck(config.home, config.paths.data),
    await modelsCheck(config),
    ...(await runDoctor({ config })),
  ];
  const failed = print(checks);
  console.log(failed === 0 ? '\nReady for real data.' : `\n${String(failed)} check(s) failed: not ready for real data.`);
  return failed === 0 ? 0 : 1;
}

function describe(status: FileStatus): string {
  return `${status.state.padEnd(10)}  ${status.model}/${status.file.path}  ${gib(status.file.sizeBytes)}`;
}

async function pull(config: AriannaConfig, verify = false): Promise<void> {
  // Also makes data/ private before anything is written in it.
  ensureLayout(config.paths.data);
  const manifest = loadManifest(config.home);
  const needed = (await modelStatus(manifest, config.paths.data))
    .filter((status) => status.state !== 'present')
    .reduce((sum, status) => sum + status.file.sizeBytes, 0);
  const free = freeBytes(join(config.paths.data, MODELS_DIR));
  if (needed + SPARE_BYTES > free) {
    throw new Error(`not enough disk: ${gib(needed)} to download plus ${gib(SPARE_BYTES)} spare, ${gib(free)} free`);
  }
  let last = 0;
  const pulled = await pullModels(manifest, config.paths.data, {
    verify,
    fetch: createFetcher(),
    onProgress: (status, bytes) => {
      const now = Date.now();
      if (now - last < 2000 && bytes !== status.file.sizeBytes) return;
      last = now;
      console.log(`${status.model}/${status.file.path}: ${gib(bytes)} of ${gib(status.file.sizeBytes)}`);
    },
  });
  if (manifest.models.length === 0) console.log('The manifest lists no model yet (config/models.manifest.yaml).');
  else console.log(pulled.length === 0 ? 'Every model is present.' : `Downloaded and verified: ${String(pulled.length)} file(s).`);
}

/** Runs a script of this repository with the same Node; stops install on failure. */
function step(config: AriannaConfig, script: string, args: string[] = []): void {
  const result = spawnSync(process.execPath, [join(config.home, script), ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${script} failed`);
}

async function install(config: AriannaConfig): Promise<number> {
  console.log('Prerequisites');
  const system = await systemChecks();
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
  console.log('\nDatabase');
  step(config, 'scripts/compose.ts', ['up', '--detach', '--wait']);
  step(config, 'apps/core/src/db/migrate-cli.ts');
  console.log('\nDoctor');
  return doctor(config);
}

const [command, sub, flag] = process.argv.slice(2);
try {
  const config = loadConfig();
  if (command === 'install') process.exitCode = await install(config);
  else if (command === 'doctor') process.exitCode = await doctor(config);
  else if (command === 'models' && (sub === 'list' || sub === 'verify')) {
    const statuses = await modelStatus(loadManifest(config.home), config.paths.data, { hash: sub === 'verify' });
    for (const status of statuses) console.log(describe(status));
    if (statuses.length === 0) console.log('The manifest lists no model yet (config/models.manifest.yaml).');
    process.exitCode = statuses.every((status) => status.state === (sub === 'verify' ? 'ok' : 'present')) ? 0 : 1;
  } else if (command === 'models' && sub === 'pull' && (flag === undefined || flag === '--verify')) {
    await pull(config, flag === '--verify');
  }
  else {
    console.error('usage: cli.ts install | doctor | models list | models verify | models pull [--verify]');
    process.exitCode = 2;
  }
} catch (error) {
  // Our errors name a file and a code; anything else only its class.
  console.error(error instanceof Error && ['ModelError', 'Error', 'ConfigError', 'VaultError', 'LoginError'].includes(error.name) ? error.message : 'unexpected error');
  process.exitCode = 1;
}
