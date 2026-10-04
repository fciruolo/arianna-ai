// The Python environment of apps/voice (D-066), always inside data/voice.
// Usage: node scripts/voice.ts sync | lock | test
//   sync  builds data/voice/venv from uv.lock exactly (pnpm voice:sync)
//   lock  updates uv.lock after a change of pyproject.toml (pnpm voice:lock)
//   test  runs the Python tests in that environment (pnpm test:voice)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, DATA_DIR, loadConfig, resolveHome, uvEnvironment, voicePaths } from '@arianna/config';

const command = process.argv[2];
const extra = process.argv.slice(3);
if (!['sync', 'lock', 'test'].includes(command ?? '') || extra.length > 0) {
  console.error('usage: node scripts/voice.ts sync | lock | test');
  process.exit(2);
}

// `lock` and `test` work before arianna.toml exists, with the default data/.
const config = existsSync(join(resolveHome(), CONFIG_FILE)) ? loadConfig() : undefined;
const home = config?.home ?? resolveHome();
const paths = voicePaths(home, config?.paths.data ?? join(home, DATA_DIR));
// uv and the tests get a short environment: no secret of the shell reaches them.
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SSL_CERT_FILE'];
const base = Object.fromEntries(INHERITED.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
mkdirSync(paths.uvCache, { recursive: true, mode: 0o700 });

function run(file: string, args: string[], env: Record<string, string> = {}): number {
  const result = spawnSync(file, args, { stdio: 'inherit', cwd: paths.project, env: { ...base, ...uvEnvironment(paths), ...env } });
  if (result.error !== undefined) {
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    console.error(missing && file === 'uv' ? 'uv is not installed: brew install uv (D-066)' : `${file}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (command === 'sync') {
  process.exitCode = run('uv', ['sync', '--frozen', '--no-install-project']);
} else if (command === 'lock') {
  process.exitCode = run('uv', ['lock']);
} else {
  if (!existsSync(paths.python)) {
    console.error('data/voice/venv is missing: pnpm voice:sync');
    process.exit(1);
  }
  process.exitCode = run(paths.python, ['-m', 'unittest', 'discover', '-s', 'tests'], { PYTHONPATH: paths.src, PYTHONDONTWRITEBYTECODE: '1' });
}
