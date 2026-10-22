// D-289: a command the user runs with a refused arianna.toml prints why, a
// refused project in Italian with what to do, without the stack trace of Node.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

const REPO = resolveHome({});
const ROOT = join(REPO, 'data', 'test-tmp', `config-refusal-${randomUUID()}`);
const USER = join(ROOT, 'utente');
const VALID = '[paths]\ndata = "data"\n\n[database]\nhost = "127.0.0.1"\nport = 54329\nname = "arianna"\nuser = "arianna"\n';

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** An installation whose arianna.toml has these sections. */
function installation(name: string, sections: string): string {
  const home = join(ROOT, name);
  mkdirSync(join(home, 'config'), { recursive: true });
  copyFileSync(join(REPO, 'config', 'models.catalog.yaml'), join(home, 'config', 'models.catalog.yaml'));
  writeFileSync(join(home, 'config', 'arianna.toml'), `${VALID}\n${sections}\n`);
  return home;
}

function run(script: string, home: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [join(REPO, script)], {
    cwd: home,
    env: { PATH: process.env.PATH ?? '', HOME: USER, ARIANNA_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr };
}

const project = (path: string): string => `[[project]]\nname = "negozio"\npath = "${path}"\nlabel = "L1"\n`;

test('pnpm start with a project written as a full path says in Italian how to write it', () => {
  const { status, stderr } = run('apps/core/src/main.ts', installation('assoluto', project(join(USER, 'Sites', 'negozio'))));
  assert.equal(status, 1);
  assert.match(stderr, /^config\/arianna\.toml, progetti \(il 1° \[\[project\]\] del file\): Scrivi la cartella come ~\/Sites\/negozio:/m);
  assert.doesNotMatch(stderr, /ConfigError|at resolveProject|node:internal/);
});

test('pnpm db:up with a project elsewhere on the disk says in Italian what to do', () => {
  const { status, stderr } = run('scripts/compose.ts', installation('altrove', project(join(ROOT, 'altrove', 'negozio'))));
  assert.equal(status, 1);
  assert.match(stderr, /^config\/arianna\.toml, progetti \(il 1° \[\[project\]\] del file\): Un progetto deve stare nella tua cartella utente/m);
  assert.doesNotMatch(stderr, /ConfigError|at resolveProject/);
});

test('any other refusal keeps the message of the code, still without the stack trace', () => {
  const { status, stderr } = run('scripts/compose.ts', installation('server', '[server]\nhost = "0.0.0.0"\n'));
  assert.equal(status, 1);
  assert.equal(stderr.trim(), 'server.host: must be one of 127.0.0.1, ::1');
});
