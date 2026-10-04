// The Python environment of apps/voice (D-066), always inside data/voice.
// Usage: node scripts/voice.ts sync | lock | test
//   sync  builds data/voice/venv from uv.lock exactly (pnpm voice:sync)
//   lock  updates uv.lock after a change of pyproject.toml (pnpm voice:lock)
//   test  runs the Python tests in that environment (pnpm test:voice)
//   vapid prints a new key pair for Web Push (pnpm voice:vapid)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, DATA_DIR, loadConfig, resolveHome, uvEnvironment, VAPID_PRIVATE_KEY_REF, voicePaths } from '@arianna/config';

import { generateVapidKeys } from '../apps/core/src/voice/push.ts';

const command = process.argv[2];
const extra = process.argv.slice(3);
if (!['sync', 'lock', 'test', 'vapid'].includes(command ?? '') || extra.length > 0) {
  console.error('usage: node scripts/voice.ts sync | lock | test | vapid');
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

if (command === 'vapid') {
  // The private half goes to the vault, never into a file of the repository.
  const keys = generateVapidKeys();
  console.log('Web Push (D-066): add to config/arianna.toml');
  console.log('');
  console.log('[voice.push]');
  console.log(`public_key = "${keys.publicKey}"`);
  console.log(`private_key = "${VAPID_PRIVATE_KEY_REF}"`);
  console.log('subject = "mailto:<your address>"');
  console.log('');
  console.log('then put this value in the vault with pnpm vault:edit, key vapid-private-key:');
  console.log(keys.privateKey);
  console.log('');
  console.log('Restart the core, open the voice page of the chat and turn the notifications on.');
  process.exit(0);
}

if (command === 'sync') {
  process.exitCode = run('uv', ['sync', '--frozen', '--no-install-project']);
} else if (command === 'lock') {
  // UV_NO_CONFIG also hides [tool.uv] of pyproject.toml: its exclude-newer is passed by hand.
  const excludeNewer = /^exclude-newer = "([^"]+)"$/m.exec(readFileSync(join(paths.project, 'pyproject.toml'), 'utf8'))?.[1];
  if (excludeNewer === undefined) {
    console.error('apps/voice/pyproject.toml: exclude-newer is missing from [tool.uv]');
    process.exit(1);
  }
  process.exitCode = run('uv', ['lock', '--exclude-newer', excludeNewer]);
} else {
  if (!existsSync(paths.python)) {
    console.error('data/voice/venv is missing: pnpm voice:sync');
    process.exit(1);
  }
  process.exitCode = run(paths.python, ['-m', 'unittest', 'discover', '-s', 'tests'], { PYTHONPATH: paths.src, PYTHONDONTWRITEBYTECODE: '1' });
}
