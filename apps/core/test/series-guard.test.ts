// Every person of the series through the real second scanner (D-214, as the
// tests of D-203): its piece of the prompt must leave towards the cloud.
// Only with Rizzo-PII on disk: `pnpm test:guard` sets ARIANNA_GUARD_MODEL and
// runs this file too; in `pnpm test` it is skipped.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { SERIES_PERSONAS, seriesNamesOfSource, seriesPersonaBlock, seriesSource } from '@arianna/agents';
import { DATA_DIR, guardPaths, resolveHome } from '@arianna/config';
import { piiVerdict } from '@arianna/policy';

import { createPiiGuard, guardStarter } from '../src/pii-guard.ts';

const MODEL = process.env.ARIANNA_GUARD_MODEL ?? '';
const available = MODEL !== '' && existsSync(join(MODEL, 'model.safetensors'));
const home = resolveHome();
const guard = available ? createPiiGuard({ start: guardStarter(guardPaths(home, join(home, DATA_DIR)), MODEL), development: false, startTimeoutMs: 120_000, requestTimeoutMs: 120_000 }) : undefined;

after(async () => {
  await guard?.stop();
});

test('the piece of every person of the series passes the second scanner, its name being no person there (D-214)', { skip: !available && 'Rizzo-PII is not in data/guard/models' }, async () => {
  assert.ok(guard !== undefined);
  for (const [id, person] of Object.entries(SERIES_PERSONAS)) {
    const text = seriesPersonaBlock(person, { withName: true, withTraits: true });
    const check = await guard.scan([text], [seriesNamesOfSource(seriesSource(id))]);
    assert.deepEqual(piiVerdict(check, [text]), { verdict: 'clean' }, id);
  }
});
