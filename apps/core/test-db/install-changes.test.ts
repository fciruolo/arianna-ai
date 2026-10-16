// «Cosa è cambiato» (D-233) on PostgreSQL: the watcher writes its events in the chained log,
// the page reads them back, and the version of Claude comes from `executor.model`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { appendEvent, verifyEventChain } from '../src/events.ts';
import { createChangeWatcher, lastBinaryVersion, loadChanges, type StateAreas } from '../src/install-changes.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const base = resolve('data/test-tmp');
mkdirSync(base, { recursive: true });

test('the first picture starts the observation, a change is one event, read back by the page', async (t) => {
  const dir = mkdtempSync(join(base, 'changes-db-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  let fresh: StateAreas = { theme: { theme: 'base' }, project: { demo: 'L1' } };
  const watcher = createChangeWatcher({ sql: db().sql, file: join(dir, 'state.json'), read: () => Promise.resolve(fresh), onError: (error) => assert.fail(String(error)) });

  assert.deepEqual(await loadChanges(db().sql), { since: null, entries: [], truncated: false });
  assert.equal(await watcher.check(), 0);
  const started = await loadChanges(db().sql);
  assert.notEqual(started.since, null);
  assert.deepEqual(started.entries, []);

  fresh = { theme: { theme: 'halloween' }, project: { demo: 'L1', altro: 'L0' } };
  assert.equal(await watcher.check(), 2);
  fresh = { theme: { theme: 'natale' }, project: { demo: 'L1', altro: 'L0' } };
  assert.equal(await watcher.check(), 1);

  const report = await loadChanges(db().sql);
  assert.deepEqual(
    report.entries.map((entry) => entry.changes),
    [
      [{ area: 'theme', id: 'theme', from: 'halloween', to: 'natale' }],
      [
        { area: 'project', id: 'altro', from: null, to: 'L0' },
        { area: 'theme', id: 'theme', from: 'base', to: 'halloween' },
      ],
    ],
  );
  const labels = await db().sql<{ label: string }[]>`SELECT label::text FROM events WHERE kind = 'installation.changed' ORDER BY id`;
  assert.deepEqual(
    labels.map((row) => row.label),
    ['L1', 'L0'],
  );
  assert.deepEqual(await verifyEventChain(db().sql), { ok: true });
});

test('the version of Claude is the last one its runs reported; runs without one do not count', async () => {
  assert.equal(await lastBinaryVersion(db().sql, 'claude'), undefined);
  await appendEvent(db().sql, { kind: 'executor.model', label: 'L0', payload: { executor: 'claude', alias: 'sonnet', model: 'claude-sonnet-5-5', version: '2.1.288' } });
  await appendEvent(db().sql, { kind: 'executor.model', label: 'L0', payload: { executor: 'claude', alias: 'sonnet', model: 'claude-sonnet-5-5' } });
  await appendEvent(db().sql, { kind: 'executor.model', label: 'L0', payload: { executor: 'codex', alias: 'codex', model: null, version: '9.9.9' } });
  assert.equal(await lastBinaryVersion(db().sql, 'claude'), '2.1.288');
  await appendEvent(db().sql, { kind: 'executor.model', label: 'L0', payload: { executor: 'claude', alias: 'opus', model: 'claude-opus-5-5', version: '2.1.300' } });
  assert.equal(await lastBinaryVersion(db().sql, 'claude'), '2.1.300');
});
