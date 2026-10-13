// `pnpm dev:codex`: Codex CLI on the development of Arianna, in this folder
// (D-143). A thin wrapper: the checks, the permission profile, the arguments
// and the environment are built in @arianna/executors (`codexDevLaunch`), the
// only place cloud executors are launched from. Extra arguments: `--model
// <name>`, `--no-alt-screen` and a starting prompt; `--print` only prints the
// arguments.
import { resolveHome } from '@arianna/config';
import { codexDevLaunch, spawnCodexDev } from '@arianna/executors';

function main(): void {
  const extra = process.argv.slice(2).filter((arg) => arg !== '--print');
  let launch;
  try {
    launch = codexDevLaunch(resolveHome(process.env), extra);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(launch.args, null, 2));
    return;
  }
  const child = spawnCodexDev(launch);
  child.on('error', (error) => {
    console.error(`codex-dev: non riesco ad avviare codex (${error.message})`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

if (import.meta.main) main();
