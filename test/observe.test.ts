import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { listFiles, ROOT } from './support/files.ts';

// `observe` of the claude adapter hands over the raw stream, labeled content
// included: it is for the canary eval only (D-050), never for the core.
test('apps do not use the observe hook of the claude adapter', () => {
  const offenders = listFiles()
    .filter((file) => file.startsWith('apps/') && file.endsWith('.ts'))
    .filter((file) => /\bobserve\s*:/.test(readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
