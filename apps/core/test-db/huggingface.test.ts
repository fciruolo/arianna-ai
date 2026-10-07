// The search of Hugging Face (I-10, D-139) through the real gateway: one row
// in gateway_log for the web target, without the text, before the request.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CATALOG_FILE } from '@arianna/config';

import { passGateway } from '../src/gateway.ts';
import { HubError } from '../src/hub-http.ts';
import { createHuggingFace } from '../src/huggingface.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const home = mkdtempSync(join(tmpdir(), 'arianna-hf-db-'));
after(() => {
  rmSync(home, { recursive: true, force: true });
});
mkdirSync(join(home, 'config'));
writeFileSync(join(home, CATALOG_FILE), 'version: 1\nmodels: []\n');

interface LogRow {
  target_kind: string;
  target: string;
  locality: string;
  label: string;
  decision: string;
  rule: string;
  summary: string | null;
  bytes_out: number | null;
}

function hub(urls: string[]) {
  return createHuggingFace({
    home,
    dataDir: join(home, 'data'),
    client: {
      json: (url) => {
        urls.push(url);
        return Promise.resolve([{ id: 'fake-org/Fake-4bit', downloads: 1 }]);
      },
      bytes: () => Promise.reject(new Error('not used')),
    },
    gateway: (payload, context, target, meta) => passGateway(db().sql, payload, context, target, meta),
    roles: () => ({}),
    busy: () => false,
    onEvent: () => undefined,
  });
}

async function webRows(): Promise<LogRow[]> {
  return db().sql<LogRow[]>`
    SELECT target_kind, target, locality, label, decision, rule, summary, bytes_out
    FROM gateway_log WHERE target_kind = 'web' ORDER BY id`;
}

test('a search is logged as an L0 exit towards the web, without the text, before it leaves', async () => {
  const urls: string[] = [];
  const results = await hub(urls).search('fake model query');
  assert.equal(results.length, 1);
  assert.equal(urls.length, 1);
  const rows = await webRows();
  assert.deepEqual(rows.at(-1), {
    target_kind: 'web',
    target: 'web-search',
    locality: 'cloud',
    label: 'L0',
    decision: 'allow',
    rule: 'cloud',
    summary: 'huggingface.co: ricerca di modelli',
    bytes_out: 16,
  });
  const [{ count }] = await db().sql<[{ count: string }]>`SELECT count(*) FROM gateway_log WHERE summary LIKE '%fake model query%' OR reason LIKE '%fake model query%'`;
  assert.equal(count, '0');
});

test('a blocked search is logged and never leaves', async () => {
  const urls: string[] = [];
  await assert.rejects(hub(urls).search('IT60X0542811101000000123456'), (error: unknown) => error instanceof HubError && error.code === 'blocked');
  assert.deepEqual(urls, []);
  const last = (await webRows()).at(-1);
  assert.equal(last?.decision, 'block');
  assert.equal(last.rule, 'scanner');
  assert.equal(last.summary, null);
});
