// The pre-commit check for leftover merge-conflict markers (scripts/conflict-markers.ts).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { markerLines } from '../scripts/conflict-markers.ts';

test('the three markers at the start of a line are found, with their line', () => {
  const text = ['# Titolo', '<<<<<<< HEAD', 'nostro', '=======', 'loro', '>>>>>>> task/x', 'fine'].join('\n');
  assert.deepEqual(markerLines(text), [2, 4, 6]);
  assert.deepEqual(markerLines('<<<<<<<\r\nx'), [1]);
});

test('the hook script: a staged file with a marker refuses the commit, a clean one passes, also from a path with spaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arianna conflitti '));
  const script = join(dir, 'scripts dir', 'conflict-markers.ts');
  try {
    mkdirSync(join(dir, 'scripts dir'));
    copyFileSync(fileURLToPath(new URL('../scripts/conflict-markers.ts', import.meta.url)), script);
    // Inside the pre-commit hook git hands down GIT_DIR, GIT_INDEX_FILE and friends: without
    // dropping them, `git init` and `git add` here would act on the real repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
    git('init', '-q');
    writeFileSync(join(dir, 'nota pulita è.md'), '# Titolo\n\ntesto\n');
    git('add', '.');
    const run = () => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env });
    assert.equal(run().status, 0);
    writeFileSync(join(dir, 'unione sbagliata.md'), 'prima\n<<<<<<< HEAD\nnostro\n=======\nloro\n>>>>>>> ramo\n');
    git('add', '.');
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /unione sbagliata\.md:2/);
    assert.match(refused.stderr, /unione sbagliata\.md:6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('look-alikes are not markers', () => {
  // A setext heading, a longer rule, a marker inside a line or indented, a quote.
  const text = ['Titolo', '===', '========', 'a <<<<<<< b', '  =======', '> >>>>>>> citazione', '<<<<<<<<'].join('\n');
  assert.deepEqual(markerLines(text), []);
});
