import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext } from '@arianna/policy';
import { createRouterConfig, route, type RouteDecision, type RouterAgent } from '@arianna/router';

import { recordRouteDecision } from '../src/router-log.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

const CONFIG = createRouterConfig([
  { executor: 'local', model: 'local-large', locality: 'local' },
  { executor: 'claude', model: 'sonnet', locality: 'cloud' },
]);
const CODER: RouterAgent = { name: 'coder', executors: ['claude', 'local'], maxLabel: 'L2', cloudMaxLabel: 'L1', difficulty: 'normal' };

interface Row {
  label: string;
  decision: string;
  executor: string | null;
  model: string | null;
  locality: string | null;
  next: string | null;
  retry_at: Date | null;
  candidates: unknown;
  reason: string;
}

async function last(): Promise<Row> {
  const [row] = await db().sql<Row[]>`
    SELECT label, decision, executor, model, locality, next, retry_at, candidates, reason
    FROM router_decisions ORDER BY id DESC LIMIT 1`;
  if (row === undefined) throw new Error('router_decisions is empty');
  return row;
}

test('a routing decision is stored with its candidates', async () => {
  await recordRouteDecision(db().sql, route({ kind: 'coding', agent: CODER }, createContext('L1', 'L1'), { blocked: [] }, CONFIG));
  const row = await last();
  assert.deepEqual(
    { ...row, candidates: [...(row.candidates as unknown[])], reason: typeof row.reason },
    {
      label: 'L1',
      decision: 'route',
      executor: 'claude',
      model: 'sonnet',
      locality: 'cloud',
      next: null,
      retry_at: null,
      candidates: [
        { executor: 'local', model: 'local-large', outcome: 'not-for-step' },
        { executor: 'claude', model: 'sonnet', outcome: 'chosen' },
      ],
      reason: 'string',
    },
  );
});

test('a wait with a retry time is stored', async () => {
  const budget = { blocked: [{ executor: 'claude' as const, cause: 'quota' as const, until: '2026-10-03T08:00:00Z' }] };
  await recordRouteDecision(db().sql, route({ kind: 'coding', agent: CODER }, createContext('L1', 'L1'), budget, CONFIG));
  const row = await last();
  assert.equal(row.decision, 'wait');
  assert.equal(row.next, 'retry-later');
  assert.equal(row.retry_at?.toISOString(), '2026-10-03T08:00:00.000Z');
});

test('the database refuses an L2 decision routed to the cloud', async () => {
  const forged: RouteDecision = {
    decision: 'route',
    executor: 'claude',
    model: 'sonnet',
    locality: 'cloud',
    label: 'L2',
    difficulty: 'normal',
    reason: 'forged',
    candidates: [],
  };
  await assert.rejects(recordRouteDecision(db().sql, forged), /router_decisions_cloud_up_to_l1/);
});

test('the database refuses claude declared local', async () => {
  const forged: RouteDecision = {
    decision: 'route',
    executor: 'claude',
    model: 'sonnet',
    locality: 'local',
    label: 'L2',
    difficulty: 'normal',
    reason: 'forged',
    candidates: [],
  };
  await assert.rejects(recordRouteDecision(db().sql, forged), /router_decisions_cloud_binaries/);
});

test('router decisions are append-only', async () => {
  await recordRouteDecision(db().sql, route({ kind: 'coding', agent: CODER }, createContext('L2', 'L2'), { blocked: [] }, CONFIG));
  await assert.rejects(db().sql`UPDATE router_decisions SET reason = 'changed'`, /permission denied/);
  await assert.rejects(db().sql`DELETE FROM router_decisions`, /permission denied/);
  await assert.rejects(db().owner`UPDATE router_decisions SET reason = 'changed'`, /append-only/);
  await assert.rejects(db().owner`DELETE FROM router_decisions`, /append-only/);
});

test('a wait for the user and a budget approval are stored', async () => {
  await recordRouteDecision(db().sql, route({ kind: 'coding', agent: CODER }, createContext('L2', 'L2'), { blocked: [{ executor: 'local', cause: 'cap' }] }, CONFIG));
  const wait = await last();
  assert.deepEqual([wait.decision, wait.next, wait.executor, wait.retry_at], ['wait', 'wait-user', null, null]);

  const fable = createRouterConfig([{ executor: 'claude', model: 'fable', locality: 'cloud' }]);
  const critical: RouterAgent = { name: 'architect', executors: ['claude'], maxLabel: 'L1', difficulty: 'critical' };
  await recordRouteDecision(db().sql, route({ kind: 'coding', agent: critical }, createContext('L1', 'L1'), { blocked: [] }, fable));
  const [row] = await db().sql<{ model: string; approval: string }[]>`SELECT model, approval FROM router_decisions ORDER BY id DESC LIMIT 1`;
  assert.deepEqual({ ...row }, { model: 'fable', approval: 'budget' });
});

/** A valid routed row; each negative case changes one column. */
async function insertRaw(change: Record<string, unknown>): Promise<void> {
  const row = {
    label: 'L1',
    difficulty: 'normal',
    decision: 'route',
    executor: 'claude',
    model: 'sonnet',
    locality: 'cloud',
    next: null,
    retry_at: null,
    approval: null,
    candidates: [] as unknown,
    reason: 'test',
    ...change,
  };
  await db().sql`
    INSERT INTO router_decisions (label, difficulty, decision, executor, model, locality, next, retry_at, approval, candidates, reason)
    VALUES (${row.label}::privacy_label, ${row.difficulty}, ${row.decision},
      ${row.executor as string | null}, ${row.model as string | null}, ${row.locality as string | null},
      ${row.next as string | null}, ${row.retry_at as string | null}::timestamptz, ${row.approval as string | null},
      ${db().sql.json(row.candidates as never)}, ${row.reason})`;
}

test('the raw valid row is accepted', async () => {
  await insertRaw({});
});

test('the database refuses inconsistent rows, including those a NULL would let through', async () => {
  const waitBase = { decision: 'wait', executor: null, model: null, locality: null, next: 'wait-user' };
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ next: 'wait-user' }, /router_decisions_wait_next/],
    [{ retry_at: '2026-10-03T08:00:00Z' }, /router_decisions_retry_at/],
    [{ ...waitBase, next: 'retry-later' }, /router_decisions_retry_at/],
    [{ ...waitBase, executor: 'claude' }, /router_decisions_route_target/],
    [{ ...waitBase, approval: 'budget' }, /router_decisions_approval_on_route/],
    [{ approval: 'budget' }, /router_decisions_approval_only_fable/],
    [{ executor: 'local', model: 'opus', locality: 'local' }, /router_decisions_model_of_executor/],
    [{ model: 'gpt' }, /router_decisions_model_check/],
    [{ label: 'L3', executor: 'local', model: 'local-large', locality: 'local' }, /router_decisions_no_l3/],
    [{ candidates: {} }, /router_decisions_candidates_check/],
  ];
  for (const [change, pattern] of cases) {
    await assert.rejects(insertRaw(change), pattern, JSON.stringify(change));
  }
});
