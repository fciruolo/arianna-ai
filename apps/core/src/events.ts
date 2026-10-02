import { labelOrDefault, type Label } from '@arianna/policy';

import type { Sql } from './db/client.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface NewEvent {
  /** Dotted name, e.g. `step.started`, `gateway.blocked`, `approval.requested`. */
  kind: string;
  /** Omitted means L2 (default-deny). */
  label?: Label;
  /** With label >= L2: references only (ids, paths, hashes), never content. */
  payload?: { [key: string]: Json };
  taskId?: string;
  runId?: string;
  agent?: string;
}

export interface StoredEvent {
  /** bigint, kept as a string. */
  id: string;
  ts: Date;
  taskId: string | null;
  runId: string | null;
  agent: string | null;
  kind: string;
  label: Label;
  payload: Json;
  /** Hex; null only for the first event. */
  prevHash: string | null;
  /** Hex. */
  hash: string;
}

/** Appends to the log. The database assigns id, timestamp and the hash chain. */
export async function appendEvent(sql: Sql, event: NewEvent): Promise<StoredEvent> {
  const [stored] = await sql<StoredEvent[]>`
    INSERT INTO events (task_id, run_id, agent, kind, label, payload)
    VALUES (
      ${event.taskId ?? null},
      ${event.runId ?? null},
      ${event.agent ?? null},
      ${event.kind},
      ${labelOrDefault(event.label)}::privacy_label,
      ${sql.json(event.payload ?? {})}
    )
    RETURNING
      id::text, ts, task_id AS "taskId", run_id AS "runId", agent, kind, label, payload,
      encode(prev_hash, 'hex') AS "prevHash", encode(hash, 'hex') AS hash`;
  if (stored === undefined) throw new Error('INSERT INTO events returned no row');
  return stored;
}

export interface ReadOptions {
  /** Return only events with an id greater than this one. */
  afterId?: string;
  /** Maximum number of events; callers page with `afterId`. */
  limit: number;
}

/** Reads the log in order. */
export async function readEvents(sql: Sql, options: ReadOptions): Promise<StoredEvent[]> {
  const rows = await sql<StoredEvent[]>`
    SELECT
      id::text, ts, task_id AS "taskId", run_id AS "runId", agent, kind, label, payload,
      encode(prev_hash, 'hex') AS "prevHash", encode(hash, 'hex') AS hash
    FROM events
    WHERE id > ${options.afterId ?? '0'}::bigint
    ORDER BY id
    LIMIT ${options.limit}`;
  // postgres.js returns an Array subclass; callers get a plain array.
  return [...rows];
}

export type ChainCheck = { ok: true } | { ok: false; brokenAt: string };

/**
 * Recomputes every hash. `brokenAt` is the id of the first event that does not match.
 * Rows removed from the end of the log are not detectable from the chain alone.
 */
export async function verifyEventChain(sql: Sql): Promise<ChainCheck> {
  const [row] = await sql<{ brokenAt: string | null }[]>`
    SELECT verify_event_chain()::text AS "brokenAt"`;
  const brokenAt = row?.brokenAt ?? null;
  return brokenAt === null ? { ok: true } : { ok: false, brokenAt };
}
