import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendEvent, readEvents, verifyEventChain } from '../src/events.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ALL = { limit: 1000 };
const CHANGES = ["UPDATE events SET kind = 'changed'", 'DELETE FROM events', 'TRUNCATE events'];

async function assertUnchangeable(): Promise<void> {
  const { sql, owner } = db();
  for (const statement of CHANGES) {
    // The role of the core lacks the privilege; the owner, who has it, meets the trigger.
    await assert.rejects(sql.unsafe(statement), /permission denied/);
    await assert.rejects(owner.unsafe(statement), /append-only/);
  }
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
}

test('an empty log cannot be updated, deleted or truncated either', assertUnchangeable);

test('an event is written, read back and chained to the previous one', async () => {
  const { sql } = db();
  const taskId = '00000000-0000-4000-8000-000000000001';
  const first = await appendEvent(sql, {
    kind: 'step.started',
    label: 'L1',
    agent: 'coder',
    taskId,
    payload: { step: 1, note: 'fake data' },
  });
  const second = await appendEvent(sql, { kind: 'step.finished', label: 'L1', taskId });

  assert.equal(first.prevHash, null);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(second.prevHash, first.hash);
  assert.notEqual(second.hash, first.hash);
  assert.deepEqual(first.payload, { step: 1, note: 'fake data' });
  assert.equal(first.taskId, taskId);
  assert.equal(first.agent, 'coder');

  assert.deepEqual(await readEvents(sql, ALL), [first, second]);
  assert.deepEqual(await readEvents(sql, { afterId: first.id, limit: 10 }), [second]);
  assert.deepEqual(await readEvents(sql, { limit: 1 }), [first]);
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('an event without a label is stored as L2', async () => {
  const event = await appendEvent(db().sql, { kind: 'document.ingested' });
  assert.equal(event.label, 'L2');
  assert.deepEqual(event.payload, {});
});

test('callers cannot choose id, timestamp or hashes', async () => {
  const { sql } = db();
  const [row] = await sql<{ id: string; year: number; forged: boolean }[]>`
    INSERT INTO events (id, ts, kind, prev_hash, hash)
    VALUES (999999, '2000-01-01', 'forged', '\\x00', '\\x00')
    RETURNING id::text, extract(year FROM ts)::int AS year, hash = '\\x00' AS forged`;
  assert.notEqual(row?.id, '999999');
  assert.notEqual(row?.year, 2000);
  assert.equal(row?.forged, false);
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('stored events cannot be updated, deleted or truncated', assertUnchangeable);

test('concurrent writers still produce one valid chain', async () => {
  const { sql } = db();
  const before = (await readEvents(sql, ALL)).length;
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      appendEvent(sql, { kind: 'concurrent', label: 'L0', payload: { index } }),
    ),
  );
  const events = await readEvents(sql, ALL);
  assert.equal(events.length, before + 25);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  events.slice(1).forEach((event, index) => {
    assert.equal(event.prevHash, events[index]?.hash);
  });
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('a writer on a stale snapshot cannot fork the chain', async () => {
  const { sql } = db();
  const stale = await sql.reserve();
  try {
    await stale`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await stale`SELECT count(*) FROM events`; // takes the snapshot
    await appendEvent(sql, { kind: 'committed.meanwhile', label: 'L0' });
    await assert.rejects(
      stale`INSERT INTO events (kind) VALUES ('stale.writer')`,
      /events_single_successor|could not serialize/,
    );
  } finally {
    await stale`ROLLBACK`;
    stale.release();
  }
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

// Last on purpose: it corrupts the log of this throwaway schema.
test('tampering with a stored event is detected at that event', async () => {
  const { sql, owner } = db();
  const victim = (await readEvents(sql, ALL))[1];
  assert.ok(victim !== undefined);

  // Only the owner, who can alter the table, can get past the trigger.
  await assert.rejects(sql`ALTER TABLE events DISABLE TRIGGER events_append_only`, /must be owner/);
  await owner`ALTER TABLE events DISABLE TRIGGER events_append_only`;
  await owner`UPDATE events SET payload = '{"tampered":true}' WHERE id = ${victim.id}::bigint`;
  await owner`ALTER TABLE events ENABLE TRIGGER events_append_only`;

  assert.deepEqual(await verifyEventChain(sql), { ok: false, brokenAt: victim.id });
});
