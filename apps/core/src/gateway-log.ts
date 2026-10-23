import { isLabel, type Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';

/**
 * «Registro del gateway» (D-296, exit criterion of Phase 1A: «log del gateway
 * leggibile»): the decisions of the gateway, newest first, one row per exit
 * allowed or blocked. Read only, metadata only: when, towards which target
 * (closed codes), which label, the outcome and the rule that decided it, the
 * size, and who asked (the agent of the run, the conversation or the card,
 * with the titles the chat already shows in the list of conversations and on
 * the Cardwall: none for the secretary, a side thread, a refresh of the
 * Dashboard or a purged conversation).
 * Never `summary` (what left, in words) nor `reason` (free text that may name
 * a site or the kinds of the values found) nor `payload_sha256` (a guessable
 * text could be found from it): no query here reads those columns.
 * Rows of an incognito conversation (D-136, I-4) are left out, as in every
 * other view: they stay in the table, append-only, but the page never shows them.
 * A row with neither task nor run (a catalog, a notice of the core) cannot be
 * tied to a conversation and is always shown: every exit reachable from an
 * incognito conversation passes its task.
 */

export const GATEWAY_DECISIONS = ['allow', 'block'] as const;
export type GatewayDecisionKind = (typeof GATEWAY_DECISIONS)[number];

export const GATEWAY_TARGET_KINDS = ['executor', 'channel', 'web', 'link'] as const;
export type GatewayTargetKind = (typeof GATEWAY_TARGET_KINDS)[number];

/** Rows of one page by default, and at most. */
export const GATEWAY_LOG_PAGE = 50;
export const GATEWAY_LOG_MAX_PAGE = 100;

/** A code written by the code (a target, a rule, an agent id): anything else is shown as `other`. */
const CODE = /^[a-z][a-z0-9-]{0,47}$/;

export interface GatewayLogQuery {
  decision?: GatewayDecisionKind;
  kind?: GatewayTargetKind;
  target?: string;
  label?: Label;
  /** Inclusive start and exclusive end of the period, as instants. */
  from?: Date;
  to?: Date;
  /** The id of the last row already shown: the page goes on below it. */
  before?: string;
  limit: number;
}

export interface GatewayLogEntry {
  id: string;
  ts: string;
  targetKind: GatewayTargetKind | 'other';
  target: string;
  locality: 'local' | 'cloud';
  label: Label;
  decision: GatewayDecisionKind;
  /** The rule that decided: a closed code, the reason of a block. */
  rule: string;
  /** Bytes that left (allowed) or were offered (blocked); null when not measured (a secret, a personal datum). */
  bytes: number | null;
  /** Who asked: the agent of the run, of the direct chat or of the card; null for the core itself. */
  agent: string | null;
  /** The model of the run, when there is one. */
  model: string | null;
  /** `title` only for a conversation of the list; `open`: not purged, «Apri la conversazione» can open it. */
  conversation: { id: string; title: string | null; open: boolean } | null;
  /** A card (a task outside any conversation), with its title as on the Cardwall. */
  card: { id: string; title: string } | null;
}

export interface GatewayLogTarget {
  kind: GatewayTargetKind | 'other';
  target: string;
}

export interface GatewayLogPage {
  entries: GatewayLogEntry[];
  /** The cursor of the next page (`before`), null at the end. */
  next: string | null;
  /** The targets ever seen, for the filter: only on the first page. */
  targets?: GatewayLogTarget[];
}

export class GatewayLogQueryError extends Error {
  override name = 'GatewayLogQueryError';
}

function oneOf<T extends string>(values: readonly T[], raw: string, name: string): T {
  if (!(values as readonly string[]).includes(raw)) throw new GatewayLogQueryError(`${name} must be one of ${values.join(', ')}`);
  return raw as T;
}

function instant(raw: string, name: string): Date {
  const date = raw.length <= 40 && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(raw) ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new GatewayLogQueryError(`${name} must be an ISO date`);
  return date;
}

/** The filters of an address; an empty parameter is no filter, anything unknown a GatewayLogQueryError (a 400). */
export function parseGatewayLogQuery(params: URLSearchParams): GatewayLogQuery {
  const known = ['decision', 'kind', 'target', 'label', 'from', 'to', 'before', 'limit'];
  for (const key of params.keys()) if (!known.includes(key)) throw new GatewayLogQueryError(`unknown parameter ${key}`);
  const value = (name: string): string | undefined => {
    const raw = params.get(name);
    return raw === null || raw === '' ? undefined : raw;
  };
  const query: GatewayLogQuery = { limit: GATEWAY_LOG_PAGE };
  const decision = value('decision');
  if (decision !== undefined) query.decision = oneOf(GATEWAY_DECISIONS, decision, 'decision');
  const kind = value('kind');
  if (kind !== undefined) query.kind = oneOf(GATEWAY_TARGET_KINDS, kind, 'kind');
  const target = value('target');
  if (target !== undefined) {
    if (!CODE.test(target)) throw new GatewayLogQueryError('target must be a target code');
    query.target = target;
  }
  const label = value('label');
  if (label !== undefined) {
    if (!isLabel(label)) throw new GatewayLogQueryError('label must be L0, L1, L2 or L3');
    query.label = label;
  }
  const from = value('from');
  if (from !== undefined) query.from = instant(from, 'from');
  const to = value('to');
  if (to !== undefined) query.to = instant(to, 'to');
  if (query.from !== undefined && query.to !== undefined && query.to <= query.from) throw new GatewayLogQueryError('to must come after from');
  const before = value('before');
  if (before !== undefined) {
    // 18 digits at most: always within a bigint, so the cast never fails.
    if (!/^[1-9]\d{0,17}$/.test(before)) throw new GatewayLogQueryError('before must be a row id');
    query.before = before;
  }
  const limit = value('limit');
  if (limit !== undefined) {
    const n = Number(limit);
    if (!/^\d{1,3}$/.test(limit) || n < 1 || n > GATEWAY_LOG_MAX_PAGE) throw new GatewayLogQueryError(`limit must be 1-${String(GATEWAY_LOG_MAX_PAGE)}`);
    query.limit = n;
  }
  return query;
}

interface Row {
  id: string;
  ts: Date;
  target_kind: string;
  target: string;
  locality: string;
  label: string;
  decision: string;
  rule: string;
  bytes_out: number | null;
  agent: string | null;
  model: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  conversation_open: boolean | null;
  card_id: string | null;
  card_title: string | null;
}

function code(value: string | null): string | null {
  if (value === null) return null;
  return CODE.test(value) ? value : 'other';
}

function kindOf(value: string): GatewayTargetKind | 'other' {
  return (GATEWAY_TARGET_KINDS as readonly string[]).includes(value) ? (value as GatewayTargetKind) : 'other';
}

function entryOf(row: Row): GatewayLogEntry {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    targetKind: kindOf(row.target_kind),
    target: code(row.target) ?? 'other',
    locality: row.locality === 'local' ? 'local' : 'cloud',
    label: isLabel(row.label) ? row.label : 'L2',
    decision: row.decision === 'allow' ? 'allow' : 'block',
    rule: code(row.rule) ?? 'other',
    bytes: row.bytes_out,
    agent: code(row.agent),
    model: row.model === null ? null : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(row.model) ? row.model : 'other',
    conversation: row.conversation_id === null ? null : { id: row.conversation_id, title: row.conversation_title, open: row.conversation_open === true },
    card: row.card_id === null ? null : { id: row.card_id, title: row.card_title ?? '' },
  };
}

/** One page of the log, newest first. */
export async function loadGatewayLog(sql: Queryable, query: GatewayLogQuery): Promise<GatewayLogPage> {
  const rows = await sql<Row[]>`
    SELECT g.id::text AS id, g.ts, g.target_kind, g.target, g.locality, g.label::text AS label, g.decision, g.rule, g.bytes_out,
      coalesce(r.agent, c.agent, CASE WHEN t.assignee <> 'user' THEN t.assignee END) AS agent,
      r.model,
      c.id::text AS conversation_id,
      -- The title only where the list of conversations shows it.
      CASE WHEN c.purged_at IS NULL AND NOT c.secretary AND c.side_of IS NULL AND c.dashboard_of IS NULL THEN c.title END AS conversation_title,
      c.purged_at IS NULL AS conversation_open,
      CASE WHEN t.conversation_id IS NULL THEN t.id::text END AS card_id,
      CASE WHEN t.conversation_id IS NULL THEN t.title END AS card_title
    FROM gateway_log g
    LEFT JOIN runs r ON r.id = g.run_id
    LEFT JOIN tasks t ON t.id = coalesce(g.task_id, r.task_id)
    LEFT JOIN conversations c ON c.id = t.conversation_id
    WHERE NOT coalesce(c.incognito, false)
      ${query.decision === undefined ? sql`` : sql`AND g.decision = ${query.decision}`}
      ${query.kind === undefined ? sql`` : sql`AND g.target_kind = ${query.kind}`}
      ${query.target === undefined ? sql`` : sql`AND g.target = ${query.target}`}
      ${query.label === undefined ? sql`` : sql`AND g.label = ${query.label}::privacy_label`}
      ${query.from === undefined ? sql`` : sql`AND g.ts >= ${query.from}`}
      ${query.to === undefined ? sql`` : sql`AND g.ts < ${query.to}`}
      ${query.before === undefined ? sql`` : sql`AND g.id < ${query.before}::bigint`}
    ORDER BY g.id DESC
    LIMIT ${query.limit + 1}`;
  const more = rows.length > query.limit;
  const entries = rows.slice(0, query.limit).map(entryOf);
  const page: GatewayLogPage = { entries, next: more ? (entries.at(-1)?.id ?? null) : null };
  if (query.before === undefined) {
    // The same rows as the list: a target seen only in an incognito conversation is not offered.
    const targets = await sql<{ target_kind: string; target: string }[]>`
      SELECT DISTINCT g.target_kind, g.target
      FROM gateway_log g
      LEFT JOIN runs r ON r.id = g.run_id
      LEFT JOIN tasks t ON t.id = coalesce(g.task_id, r.task_id)
      LEFT JOIN conversations c ON c.id = t.conversation_id
      WHERE NOT coalesce(c.incognito, false)
      ORDER BY g.target_kind, g.target`;
    const seen = new Set<string>();
    page.targets = [];
    for (const row of targets) {
      const target = code(row.target) ?? 'other';
      const kind = kindOf(row.target_kind);
      if (target === 'other' || seen.has(`${kind}/${target}`)) continue;
      seen.add(`${kind}/${target}`);
      page.targets.push({ kind, target });
    }
  }
  return page;
}
