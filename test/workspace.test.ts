import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABELS, type Label } from '@arianna/policy';

import { listFiles } from './support/files.ts';

// Must mirror the globs of the "test" and "test:db" scripts in package.json.
const RUN_BY_TEST_SCRIPT = [
  /^(apps|packages)\/[^/]+\/test\/.+\.test\.ts$/,
  /^apps\/[^/]+\/test-db\/.+\.test\.ts$/,
  /^test\/.+\.test\.ts$/,
  /^\.claude\/hooks\/[^/]+\.test\.js$/,
];

// Guards the monorepo wiring: workspace packages resolve by name and run from source.
test('workspace packages are importable by name', () => {
  const mostRestricted: Label = 'L3';
  assert.equal(LABELS.at(-1), mostRestricted);
});

// A test file outside these folders would pass build and lint without ever running.
test('every test file is in a folder the test script runs', () => {
  const orphans = listFiles()
    .filter((file) => /\.test\.[cm]?[jt]s$/.test(file))
    .filter((file) => !RUN_BY_TEST_SCRIPT.some((pattern) => pattern.test(file)));
  assert.deepEqual(orphans, []);
});
