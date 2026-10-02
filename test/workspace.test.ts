import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

import { LABELS, type Label } from '@arianna/policy';

const ROOT = join(import.meta.dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'data', 'dist']);
// Must mirror the globs of the "test" script in package.json.
const RUN_BY_TEST_SCRIPT = [
  /^(apps|packages)\/[^/]+\/test\/.+\.test\.ts$/,
  /^test\/.+\.test\.ts$/,
  /^\.claude\/hooks\/[^/]+\.test\.js$/,
];

function findTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : findTestFiles(path);
    return /\.test\.[cm]?[jt]s$/.test(entry.name) ? [relative(ROOT, path).split(sep).join('/')] : [];
  });
}

// Guards the monorepo wiring: workspace packages resolve by name and run from source.
test('workspace packages are importable by name', () => {
  const mostRestricted: Label = 'L3';
  assert.equal(LABELS.at(-1), mostRestricted);
});

// A test file outside these folders would pass build and lint without ever running.
test('every test file is in a folder the test script runs', () => {
  const orphans = findTestFiles(ROOT).filter(
    (file) => !RUN_BY_TEST_SCRIPT.some((pattern) => pattern.test(file)),
  );
  assert.deepEqual(orphans, []);
});
