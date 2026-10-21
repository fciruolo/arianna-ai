// The image of the agent's browser (D-264):
//   pnpm browser:build
// builds apps/core/browser/Dockerfile with the local Docker and writes the
// id of the result, with the Chromium version, the snapshot date and the
// base, in config/browser-image.lock (outside git): the core runs only that
// id. The build reads the base image and the Debian packages from the
// network; nothing of the image runs with network afterwards.
//   node scripts/browser.ts seccomp <moby default.json>
// rewrites apps/core/browser/seccomp.json from the default profile of
// moby (checked against the sha256 of MOBY_SECCOMP) plus the three rules of
// the Chromium sandbox.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveHome } from '@arianna/config';

import {
  BROWSER_DOCKERFILE_DIR,
  BROWSER_IMAGE_LOCK,
  BROWSER_SECCOMP,
  isImageId,
  type BrowserImageLock,
} from '../apps/core/src/browser/image.ts';
import { browserSeccomp, MOBY_SECCOMP } from '../apps/core/src/browser/seccomp.ts';

const home = resolveHome();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function seccomp(source: string | undefined): void {
  if (source === undefined) fail('Uso: node scripts/browser.ts seccomp <default.json di moby>');
  const text = readFileSync(source, 'utf8');
  const sha = createHash('sha256').update(text).digest('hex');
  if (sha !== MOBY_SECCOMP.sha256) {
    fail(`Il file non è quello di moby/profiles ${MOBY_SECCOMP.commit} (sha256 ${sha}, atteso ${MOBY_SECCOMP.sha256}).`);
  }
  writeFileSync(join(home, BROWSER_SECCOMP), browserSeccomp(text));
  console.log(`Scritto ${BROWSER_SECCOMP}.`);
}

function build(): void {
  const dir = join(home, BROWSER_DOCKERFILE_DIR);
  const dockerfile = readFileSync(join(dir, 'Dockerfile'), 'utf8');
  const base = /^FROM (\S+@sha256:[0-9a-f]{64})$/m.exec(dockerfile)?.[1];
  const snapshot = /^ARG SNAPSHOT=(\d{8}T\d{6}Z)$/m.exec(dockerfile)?.[1];
  if (base === undefined || snapshot === undefined) fail('Il Dockerfile non ha FROM per digest e ARG SNAPSHOT.');

  execFileSync('docker', ['build', '--tag', 'arianna-browser:local', dir], { stdio: 'inherit' });
  const image = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', 'arianna-browser:local'], { encoding: 'utf8' }).trim();
  if (!isImageId(image)) fail(`Id dell'immagine inatteso: ${String(image)}`);

  // Only the version: no network, no capabilities, nothing written.
  const version = execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '10001:10001',
    '--entrypoint', 'chromium', image, '--version',
  ], { encoding: 'utf8' });
  const chromium = /(\d+\.\d+\.\d+\.\d+)/.exec(version)?.[1];
  if (chromium === undefined) fail(`Versione di Chromium non letta: ${version.trim()}`);

  const lock: BrowserImageLock = { image, builtAt: new Date().toISOString(), chromium, snapshot, base };
  const target = join(home, BROWSER_IMAGE_LOCK);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(temporary, target);
  console.log(`Immagine ${image.slice(0, 19)}… con Chromium ${chromium}; scritto ${BROWSER_IMAGE_LOCK}.`);
}

const [command, argument] = process.argv.slice(2);
if (command === 'build') build();
else if (command === 'seccomp') seccomp(argument);
else fail('Uso: node scripts/browser.ts build | seccomp <default.json di moby>');
