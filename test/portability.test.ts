import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { listFiles, ROOT } from './support/files.ts';

// Code and configuration that must work from any folder (CLAUDE.md: no absolute paths).
const PORTABLE = /^(apps|packages|scripts|config|evals|agents)\/|^(compose\.yaml|package\.json)$/;
const MACHINE_PATH = /\/Users\/|\/home\/|\/Volumes\/|[A-Z]:\\/;

test('code and configuration contain no machine-specific absolute paths', () => {
  const offenders = listFiles()
    .filter((file) => PORTABLE.test(file))
    .filter((file) => MACHINE_PATH.test(readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
