import { isLabel, sha256Hex, type Label } from '@arianna/policy';

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface GatewayLogQuery {
  decision?: GatewayDecisionKind;
  kind?: GatewayTargetKind;
  target?: string;
  label?: Label;
  /** Inclusive start and exclusive end of the period, as instants. */
  from?: Date;
  to?: Date;
  /** The id of the last row already shown: the page goes on below it (of a group: its newest row). */
  before?: string;
  /** Only the rows of this run (D-297: the exits of one group). */
  run?: string;
  /** `run`: one group per run of an agent (D-297, «una riga per richiesta»); a row without a run alone. */
  group?: 'run';
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
  /** The run of the exit: its group (D-297). */
  runId: string | null;
  /** What it was (D-297): a closed code (`brief`, `mcp-kb-read`…), L0; null for an exit before it or of no kind. */
  what: string | null;
}

/**
 * The exits of one run of an agent, as one line (D-297): the newest row with
 * who, where and from where, and the counts. A row without a run is a group
 * of one. Never a subject nor a text: readable from the phone.
 */
export interface GatewayLogGroup {
  /** The newest row of the group: its id is the cursor. */
  entry: GatewayLogEntry;
  count: number;
  allowed: number;
  blocked: number;
  /** Bytes of the rows that measured them; null when none did. */
  bytes: number | null;
  firstTs: string;
  /** Distinct targets in the group: more than one, «e altre». */
  targets: number;
  /** The highest label among its exits, blocked ones too. */
  label: Label;
  /** Exits allowed to the cloud with Privato or Segreto (not a link): the line is red. */
  privateOut: number;
  /** Exits to the cloud, allowed or blocked. */
  cloud: number;
  /** Where the line says it went: its newest cloud target when it has one, else its newest row's. */
  headline: { targetKind: GatewayTargetKind | 'other'; target: string; locality: 'local' | 'cloud' };
}

export interface GatewayLogTarget {
  kind: GatewayTargetKind | 'other';
  target: string;
}

export interface GatewayLogPage {
  /** The rows; empty in a page of groups. */
  entries: GatewayLogEntry[];
  /** With `group=run`, the groups instead of the rows. */
  groups?: GatewayLogGroup[];
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
  const known = ['decision', 'kind', 'target', 'label', 'from', 'to', 'before', 'limit', 'run', 'group'];
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
  const run = value('run');
  if (run !== undefined) {
    if (!UUID.test(run)) throw new GatewayLogQueryError('run must be a run id');
    query.run = run;
  }
  const group = value('group');
  if (group !== undefined) {
    if (group !== 'run') throw new GatewayLogQueryError('group must be run');
    if (query.run !== undefined) throw new GatewayLogQueryError('group and run do not go together');
    query.group = 'run';
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
  run_id: string | null;
  what: string | null;
}

interface GroupRow extends Row {
  n: number;
  allowed: number;
  blocked: number;
  total_bytes: string | null;
  first_ts: Date;
  targets: number;
  top_label: string;
  private_out: number;
  cloud: number;
  cloud_kind: string | null;
  cloud_target: string | null;
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
    runId: row.run_id,
    what: code(row.what),
  };
}

function groupOf(row: GroupRow): GatewayLogGroup {
  return {
    entry: entryOf(row),
    count: row.n,
    allowed: row.allowed,
    blocked: row.blocked,
    bytes: row.total_bytes === null ? null : Number(row.total_bytes),
    firstTs: row.first_ts.toISOString(),
    targets: row.targets,
    label: isLabel(row.top_label) ? row.top_label : 'L2',
    privateOut: row.private_out,
    cloud: row.cloud,
    headline:
      row.cloud_kind !== null && row.cloud_target !== null
        ? { targetKind: kindOf(row.cloud_kind), target: code(row.cloud_target) ?? 'other', locality: 'cloud' }
        : { targetKind: kindOf(row.target_kind), target: code(row.target) ?? 'other', locality: row.locality === 'local' ? 'local' : 'cloud' },
  };
}

/** The columns of a row as the page shows it, from `g` and its joins (fromRows). */
function rowColumns(sql: Queryable) {
  return sql`
    g.id::text AS id, g.ts, g.target_kind, g.target, g.locality, g.label::text AS label, g.decision, g.rule, g.bytes_out,
    coalesce(r.agent, c.agent, CASE WHEN t.assignee <> 'user' THEN t.assignee END) AS agent,
    r.model,
    c.id::text AS conversation_id,
    -- The title only where the list of conversations shows it.
    CASE WHEN c.purged_at IS NULL AND NOT c.secretary AND c.side_of IS NULL AND c.dashboard_of IS NULL THEN c.title END AS conversation_title,
    c.purged_at IS NULL AS conversation_open,
    CASE WHEN t.conversation_id IS NULL THEN t.id::text END AS card_id,
    CASE WHEN t.conversation_id IS NULL THEN t.title END AS card_title,
    g.run_id::text AS run_id, g.what`;
}

/** gateway_log with who asked, without the rows of an incognito conversation. */
function fromRows(sql: Queryable) {
  return sql`
    FROM gateway_log g
    LEFT JOIN runs r ON r.id = g.run_id
    LEFT JOIN tasks t ON t.id = coalesce(g.task_id, r.task_id)
    LEFT JOIN conversations c ON c.id = t.conversation_id
    WHERE NOT coalesce(c.incognito, false)`;
}

/** The filters of a row; the outcome too unless the page is of groups, where it chooses groups. */
function rowFilters(sql: Queryable, query: GatewayLogQuery, decision: boolean) {
  return sql`
    ${decision && query.decision !== undefined ? sql`AND g.decision = ${query.decision}` : sql``}
    ${query.kind === undefined ? sql`` : sql`AND g.target_kind = ${query.kind}`}
    ${query.target === undefined ? sql`` : sql`AND g.target = ${query.target}`}
    ${query.label === undefined ? sql`` : sql`AND g.label = ${query.label}::privacy_label`}
    ${query.from === undefined ? sql`` : sql`AND g.ts >= ${query.from}`}
    ${query.to === undefined ? sql`` : sql`AND g.ts < ${query.to}`}
    ${query.run === undefined ? sql`` : sql`AND g.run_id = ${query.run}::uuid`}`;
}

/**
 * One page of groups (D-297): one per run, a row without a run alone, newest
 * first by their newest row. «Bloccate» keeps the groups with a block in them,
 * with all their counts; the other filters choose the rows counted.
 */
async function loadGroups(sql: Queryable, query: GatewayLogQuery): Promise<{ groups: GatewayLogGroup[]; next: string | null }> {
  const rows = await sql<GroupRow[]>`
    WITH chosen AS (
      SELECT g.id, g.ts, g.run_id, g.decision, g.bytes_out, g.target_kind, g.target, g.label, g.locality
      ${fromRows(sql)}
      ${rowFilters(sql, query, false)}
    ),
    grouped AS (
      SELECT max(id) AS last_id, count(*)::int AS n,
        (count(*) FILTER (WHERE decision = 'allow'))::int AS allowed,
        (count(*) FILTER (WHERE decision = 'block'))::int AS blocked,
        sum(bytes_out)::text AS total_bytes, min(ts) AS first_ts,
        count(DISTINCT (target_kind, target))::int AS targets,
        max(label)::text AS top_label,
        -- Allowed to the cloud with Privato or Segreto (not the address of a link): the line is red, as a row (D-296).
        (count(*) FILTER (WHERE decision = 'allow' AND locality = 'cloud' AND label >= 'L2' AND target_kind <> 'link'))::int AS private_out,
        -- The headline of a group with exits to the cloud is its newest cloud target: never «sul Mac» for it.
        (count(*) FILTER (WHERE locality = 'cloud'))::int AS cloud,
        (array_agg(target_kind ORDER BY id DESC) FILTER (WHERE locality = 'cloud'))[1] AS cloud_kind,
        (array_agg(target ORDER BY id DESC) FILTER (WHERE locality = 'cloud'))[1] AS cloud_target
      FROM chosen
      GROUP BY coalesce(run_id::text, 'row:' || id::text)
      HAVING true
        ${query.decision === 'block' ? sql`AND count(*) FILTER (WHERE decision = 'block') > 0` : sql``}
        ${query.decision === 'allow' ? sql`AND count(*) FILTER (WHERE decision = 'allow') > 0` : sql``}
    )
    SELECT ${rowColumns(sql)}, grouped.n, grouped.allowed, grouped.blocked, grouped.total_bytes, grouped.first_ts, grouped.targets, grouped.top_label, grouped.private_out,
      grouped.cloud, grouped.cloud_kind, grouped.cloud_target
    FROM grouped
    JOIN gateway_log g ON g.id = grouped.last_id
    LEFT JOIN runs r ON r.id = g.run_id
    LEFT JOIN tasks t ON t.id = coalesce(g.task_id, r.task_id)
    LEFT JOIN conversations c ON c.id = t.conversation_id
    ${query.before === undefined ? sql`` : sql`WHERE grouped.last_id < ${query.before}::bigint`}
    ORDER BY grouped.last_id DESC
    LIMIT ${query.limit + 1}`;
  const more = rows.length > query.limit;
  const groups = rows.slice(0, query.limit).map(groupOf);
  return { groups, next: more ? (groups.at(-1)?.entry.id ?? null) : null };
}

/** One page of the log, newest first: rows, or groups with `group=run`. */
export async function loadGatewayLog(sql: Queryable, query: GatewayLogQuery): Promise<GatewayLogPage> {
  let page: GatewayLogPage;
  if (query.group === 'run') {
    const { groups, next } = await loadGroups(sql, query);
    page = { entries: [], groups, next };
  } else {
    const rows = await sql<Row[]>`
      SELECT ${rowColumns(sql)}
      ${fromRows(sql)}
      ${rowFilters(sql, query, true)}
      ${query.before === undefined ? sql`` : sql`AND g.id < ${query.before}::bigint`}
      ORDER BY g.id DESC
      LIMIT ${query.limit + 1}`;
    const more = rows.length > query.limit;
    const entries = rows.slice(0, query.limit).map(entryOf);
    page = { entries, next: more ? (entries.at(-1)?.id ?? null) : null };
  }
  if (query.before === undefined && query.run === undefined) {
    // The same rows as the list: a target seen only in an incognito conversation is not offered.
    const targets = await sql<{ target_kind: string; target: string }[]>`
      SELECT DISTINCT g.target_kind, g.target
      ${fromRows(sql)}
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

/**
 * «Cosa è uscito» (D-297): the exact text of one exit, read only from the Mac
 * (`GET /api/gateway/log/:id/text`, in LOCAL_ONLY_PATHS of server/remote.ts).
 * Kept in gateway_texts only for an exit allowed to the cloud up to L1, never
 * in incognito, deleted with the conversation and after 30 days. What is not
 * there says why, with no text: a blocked exit says only its label.
 */
export type GatewayTextState =
  /** The text, part by part, in the order it left. */
  | 'text'
  /** Stopped by the gateway: nothing left, and nothing of it is kept. */
  | 'blocked'
  /** Towards a target on the Mac: it never left, the text is not kept. */
  | 'local'
  /** Allowed above Interno (the address of a link or of the browser): not kept. */
  | 'private'
  /** The conversation was deleted, or the exit is older than 30 days. */
  | 'gone'
  /** No text kept: an exit from before D-297, or one tied to no task or run (the browser driven by the user, a catalog). */
  | 'none';

export interface GatewayTextPart {
  text: string;
  /** The size of the whole part as it left. */
  bytes: number;
  /** Over 1 MiB: only its first MiB is kept. */
  truncated: boolean;
}

export interface GatewayText {
  id: string;
  state: GatewayTextState;
  label: Label;
  parts?: GatewayTextPart[];
  /** The sum of the parts as they left. */
  bytes?: number;
  /** The sha256 of the kept parts is the one in gateway_log; null when a part was cut. */
  verified?: boolean | null;
  /** What it was about (D-297): the path, the search, the skill, the site; blocked exits too. Mac only. */
  subject: string | null;
}

/** How long a text is kept, and read. */
export const GATEWAY_TEXT_DAYS = 30;

/** An id of gateway_log as an address carries it, or undefined. */
export function gatewayLogId(raw: string): string | undefined {
  return /^[1-9]\d{0,17}$/.test(raw) ? raw : undefined;
}

/** The text of one exit; undefined for a row that does not exist or belongs to an incognito conversation. */
export async function loadGatewayText(sql: Queryable, id: string): Promise<GatewayText | undefined> {
  const [row] = await sql<{ decision: string; locality: string; label: string; sha256: string | null; old: boolean; purged: boolean; subject: string | null }[]>`
    SELECT g.decision, g.locality, g.label::text AS label, g.payload_sha256 AS sha256,
      (SELECT s.subject FROM gateway_subjects s WHERE s.log_id = g.id AND s.created_at >= now() - make_interval(days => ${GATEWAY_TEXT_DAYS})) AS subject,
      g.ts < now() - make_interval(days => ${GATEWAY_TEXT_DAYS}) AS old,
      coalesce(c.purged_at IS NOT NULL, false) AS purged
    FROM gateway_log g
    -- As gateway_texts ties a row (0090): by task or run, a card «Piano» by its request.
    LEFT JOIN conversations c ON c.id = gateway_log_conversation(g.task_id, g.run_id)
    WHERE g.id = ${id}::bigint AND NOT coalesce(c.incognito, false)`;
  if (row === undefined) return undefined;
  const label: Label = isLabel(row.label) ? row.label : 'L2';
  const base = { id, label, subject: row.subject };
  if (row.decision !== 'allow') return { ...base, state: 'blocked' };
  if (row.locality !== 'cloud') return { ...base, state: 'local' };
  if (label !== 'L0' && label !== 'L1') return { ...base, state: 'private' };
  const kept = await sql<{ body: Buffer; bytes: number }[]>`
    SELECT body, bytes FROM gateway_texts
    WHERE log_id = ${id}::bigint AND created_at >= now() - make_interval(days => ${GATEWAY_TEXT_DAYS})
    ORDER BY seq`;
  if (kept.length === 0) return { ...base, state: row.old || row.purged ? 'gone' : 'none' };
  const parts = kept.map((part) => ({ text: part.body.toString('utf8'), bytes: part.bytes, truncated: part.bytes > part.body.length }));
  const whole = parts.every((part) => !part.truncated);
  return {
    ...base,
    state: 'text',
    parts,
    bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
    verified: whole ? row.sha256 !== null && sha256Hex(JSON.stringify(parts.map((part) => part.text))) === row.sha256 : null,
  };
}

/** The texts older than 30 days go (D-297): at start and every hour. */
export async function pruneGatewayTexts(sql: Queryable): Promise<number> {
  const [row] = await sql<{ count: number }[]>`SELECT gateway_texts_prune() AS count`;
  return row?.count ?? 0;
}

/**
 * The subjects of the exits of one run (D-297, «Cosa era»), by row id: only
 * from the Mac (`GET /api/gateway/log/run/:id/subjects`, in LOCAL_ONLY_PATHS),
 * never of an incognito conversation, 30 days at most.
 */
export async function loadGatewaySubjects(sql: Queryable, runId: string): Promise<Record<string, string>> {
  const rows = await sql<{ id: string; subject: string }[]>`
    SELECT g.id::text AS id, s.subject
    FROM gateway_log g
    JOIN gateway_subjects s ON s.log_id = g.id
    LEFT JOIN conversations c ON c.id = gateway_log_conversation(g.task_id, g.run_id)
    WHERE g.run_id = ${runId}::uuid AND NOT coalesce(c.incognito, false)
      AND s.created_at >= now() - make_interval(days => ${GATEWAY_TEXT_DAYS})
    ORDER BY g.id`;
  return Object.fromEntries(rows.map((row) => [row.id, row.subject]));
}

/** A run id as an address carries it, or undefined. */
export function runIdOf(raw: string): string | undefined {
  return UUID.test(raw) ? raw : undefined;
}
